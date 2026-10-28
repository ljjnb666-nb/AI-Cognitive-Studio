#!/usr/bin/env python3
"""Private, read-only, same-source OCR candidate comparison.

No book text, paths, image pixels or PDF fragments may leave stdout.
Pairwise disagreement is NOT accuracy. Even an approved-reference declaration
is only self-attested until independently admitted by a reviewer.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import sys
import unicodedata

SCHEMA = "ACS_PRIVATE_OCR_COMPARISON_V1"
MAX_CANDIDATES = 5
MAX_FILE_BYTES = 32_000
MAX_PAGE_CHARS = 6_000
MAX_MANIFEST_BYTES = 32_000
MAX_PDF_BYTES = 200 * 1024 * 1024
MAX_PAGES = 2_000
# Independently established B03 source identity, not inferred from a filename.
B03_SHA256 = "5be652d2066b680f1242bf358979c549aaf8a1588d9648926ecd8b6c30697440"
B03_BYTES = 151_495_200
B03_PAGES = 271
ENGINES = {"mineru", "docling", "rapidocr", "pdfjs-native", "other"}


class Blocked(Exception):
    """Only stable, non-content-bearing reason codes reach the caller."""


def require_relative(root: Path, name: object) -> Path:
    if not isinstance(name, str) or not name or len(name) > 260:
        raise Blocked("UNSAFE_PRIVATE_PATH")
    candidate = Path(name)
    if candidate.is_absolute() or ".." in candidate.parts or any(x in name for x in ("\0", "\\", ":")):
        raise Blocked("UNSAFE_PRIVATE_PATH")
    current = root
    for part in candidate.parts:
        if part in ("", "."):
            raise Blocked("UNSAFE_PRIVATE_PATH")
        current = current / part
        try:
            info = current.lstat()
        except OSError:
            raise Blocked("PRIVATE_FILE_NOT_FOUND") from None
        if stat.S_ISLNK(info.st_mode) or (
            getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        ):
            raise Blocked("UNSAFE_PRIVATE_PATH")
    try:
        if not current.resolve().is_relative_to(root.resolve()) or not current.is_file():
            raise Blocked("UNSAFE_PRIVATE_PATH")
    except OSError:
        raise Blocked("UNSAFE_PRIVATE_PATH") from None
    return current


def read_bounded(path: Path, limit: int) -> bytes:
    try:
        size = path.stat().st_size
        if size <= 0 or size > limit:
            raise Blocked("PRIVATE_FILE_SIZE_INVALID")
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
        if len(data) != size or len(data) > limit:
            raise Blocked("PRIVATE_FILE_CHANGED")
        return data
    except OSError:
        raise Blocked("PRIVATE_FILE_READ_FAILED") from None


def read_text(root: Path, name: object) -> str:
    data = read_bounded(require_relative(root, name), MAX_FILE_BYTES)
    try:
        text = unicodedata.normalize("NFC", data.decode("utf-8-sig").replace("\r\n", "\n"))
    except UnicodeError:
        raise Blocked("CANDIDATE_ENCODING_INVALID") from None
    if not text.strip() or len(text) > MAX_PAGE_CHARS or "\0" in text:
        raise Blocked("CANDIDATE_TEXT_INVALID")
    return text


def distance(a: str, b: str) -> int:
    """Exact Levenshtein distance in O(min(n,m)) storage; bounded upstream."""
    if len(a) < len(b):
        a, b = b, a
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, ch in enumerate(a, 1):
        current = [i]
        for j, other in enumerate(b, 1):
            current.append(min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (ch != other),
            ))
        previous = current
    return previous[-1]


def sha_of(path: Path, max_bytes: int) -> str:
    try:
        before = path.stat()
        if not 5 <= before.st_size <= max_bytes:
            raise Blocked("SOURCE_PDF_SIZE_INVALID")
        h = hashlib.sha256()
        with path.open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                raise Blocked("SOURCE_PDF_MAGIC_INVALID")
            stream.seek(0)
            for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                h.update(chunk)
        after = path.stat()
        if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
            raise Blocked("SOURCE_CHANGED_DURING_REVIEW")
        return h.hexdigest()
    except OSError:
        raise Blocked("SOURCE_PDF_READ_FAILED") from None


def validate_source(root: Path, source: object) -> dict:
    if not isinstance(source, dict) or set(source) != {
        "pdf", "sha256", "size_bytes", "page_count", "physical_page_1_based", "book_id"
    }:
        raise Blocked("SOURCE_CONTRACT_INVALID")
    digest = source["sha256"]
    size = source["size_bytes"]
    pages = source["page_count"]
    index = source["physical_page_1_based"]
    if not isinstance(digest, str) or re.fullmatch("[0-9a-f]{64}", digest) is None or (
        type(size) is not int or type(pages) is not int or type(index) is not int
    ) or not (5 <= size <= MAX_PDF_BYTES and 1 <= pages <= MAX_PAGES and 1 <= index <= pages):
        raise Blocked("SOURCE_CONTRACT_INVALID")
    book_id = source["book_id"]
    if not isinstance(book_id, str) or re.fullmatch(r"B[0-9]{2}", book_id) is None:
        raise Blocked("SOURCE_CONTRACT_INVALID")
    if book_id == "B03" and (digest != B03_SHA256 or size != B03_BYTES or pages != B03_PAGES):
        raise Blocked("B03_PINNED_SOURCE_IDENTITY_MISMATCH")
    path = require_relative(root, source["pdf"])
    if path.stat().st_size != size or sha_of(path, MAX_PDF_BYTES) != digest:
        raise Blocked("SOURCE_SHA_MISMATCH")
    try:
        import fitz
        doc = fitz.open(str(path))
        try:
            if doc.needs_pass or doc.page_count != pages:
                raise Blocked("SOURCE_PAGE_COUNT_MISMATCH")
            page = doc.load_page(index - 1)
            rect = page.rect
            if rect.width <= 0 or rect.height <= 0 or max(rect.width, rect.height) > 20_000:
                raise Blocked("SOURCE_PAGE_INVALID")
            # Verify this physical page can actually be rendered, without
            # exporting its pixels. Huge pages are downscaled before decode.
            scale = min(1.0, 384.0 / max(rect.width, rect.height))
            pixels = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            if not (1 <= pixels.width <= 384 and 1 <= pixels.height <= 384):
                raise Blocked("SOURCE_PAGE_RENDER_INVALID")
        finally:
            doc.close()
    except ImportError:
        raise Blocked("SOURCE_PYMUPDF_UNAVAILABLE") from None
    except Blocked:
        raise
    except Exception:
        raise Blocked("SOURCE_PDF_READ_FAILED") from None
    if sha_of(path, MAX_PDF_BYTES) != digest:
        raise Blocked("SOURCE_CHANGED_DURING_REVIEW")
    return source


def inspect_candidate_receipt(
    root: Path, candidate: dict, source: dict, text: str, content_sha256: str
) -> str:
    """Verify local artifact/receipt consistency, not a trusted engine signature."""
    if "receipt" not in candidate:
        return "DECLARED_ONLY"
    receipt = json.loads(read_bounded(require_relative(root, candidate["receipt"]), MAX_MANIFEST_BYTES))
    fields = {
        "schema_version", "status", "runner", "engine", "engine_version",
        "source_sha256", "source_size_bytes", "physical_page_1_based",
        "text_sha256", "text_chars", "model_sha256",
    }
    if not isinstance(receipt, dict) or set(receipt) != fields or receipt["schema_version"] != 1:
        raise Blocked("RECEIPT_CONTRACT_INVALID")
    if receipt["status"] != "SUCCEEDED" or receipt["runner"] != "ACS_PRIVATE_LOCAL_OCR_V1":
        raise Blocked("RECEIPT_CONTRACT_INVALID")
    if (receipt["engine"] != candidate["engine"] or
        receipt["engine_version"] != candidate["revision"] or
        receipt["source_sha256"] != source["sha256"] or
        type(receipt["source_size_bytes"]) is not int or
        receipt["source_size_bytes"] != source["size_bytes"] or
        type(receipt["physical_page_1_based"]) is not int or
        receipt["physical_page_1_based"] != source["physical_page_1_based"]):
        raise Blocked("RECEIPT_SOURCE_PAGE_MISMATCH")
    if (not isinstance(receipt["text_sha256"], str) or
        not re.fullmatch("[0-9a-f]{64}", receipt["text_sha256"]) or
        receipt["text_sha256"] != content_sha256 or
        type(receipt["text_chars"]) is not int or
        receipt["text_chars"] != len(text)):
        raise Blocked("RECEIPT_TEXT_MISMATCH")
    model = receipt["model_sha256"]
    if (candidate["engine"] == "rapidocr" and
        (not isinstance(model, str) or re.fullmatch("[0-9a-f]{64}", model) is None)):
        raise Blocked("RECEIPT_MODEL_PROVENANCE_INVALID")
    if candidate["engine"] != "rapidocr" and model is not None and (
        not isinstance(model, str) or re.fullmatch("[0-9a-f]{64}", model) is None
    ):
        raise Blocked("RECEIPT_MODEL_PROVENANCE_INVALID")
    return "LOCAL_HASH_CONSISTENT_SELF_ATTESTED"


def compare(root: Path, manifest: object) -> dict:
    if not isinstance(manifest, dict) or set(manifest) != {"schema_version", "source", "candidates", "reference"} or manifest["schema_version"] != 1:
        raise Blocked("MANIFEST_CONTRACT_INVALID")
    source = validate_source(root, manifest["source"])
    candidates = manifest["candidates"]
    if not isinstance(candidates, list) or not 2 <= len(candidates) <= MAX_CANDIDATES:
        raise Blocked("CANDIDATES_CONTRACT_INVALID")
    seen = set()
    texts: list[tuple[str, str]] = []
    receipts: list[dict[str, str]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict) or set(candidate) not in (
            {"engine", "revision", "text", "source_sha256", "physical_page_1_based"},
            {"engine", "revision", "text", "source_sha256", "physical_page_1_based", "receipt"},
        ):
            raise Blocked("CANDIDATE_CONTRACT_INVALID")
        engine, revision = candidate["engine"], candidate["revision"]
        if engine not in ENGINES or not isinstance(revision, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,48}", revision):
            raise Blocked("CANDIDATE_CONTRACT_INVALID")
        if engine in seen:
            raise Blocked("DUPLICATE_CANDIDATE_ENGINE")
        seen.add(engine)
        if candidate["source_sha256"] != source["sha256"] or type(candidate["physical_page_1_based"]) is not int or candidate["physical_page_1_based"] != source["physical_page_1_based"]:
            raise Blocked("CANDIDATE_SOURCE_PAGE_MISMATCH")
        candidate_path = require_relative(root, candidate["text"])
        raw = read_bounded(candidate_path, MAX_FILE_BYTES)
        text = read_text(root, candidate["text"])
        receipts.append({
            "engine": engine,
            "state": inspect_candidate_receipt(
                root, candidate, source, text, hashlib.sha256(raw).hexdigest()
            ),
        })
        texts.append((engine, text))
    # Candidates' source_sha256 and revisions are declared metadata, NOT proof
    # they were actually generated from that source by the stated engines.
    pairwise = []
    for i, (first, a) in enumerate(texts):
        for second, b in texts[i + 1:]:
            pairwise.append({
                "left": first, "right": second,
                "edit_distance": distance(a, b),
                "left_chars": len(a), "right_chars": len(b),
                "metric": "PAIRWISE_DISAGREEMENT_NOT_CER",
            })

    result = {
        "schema": SCHEMA,
        "source_pdf_bytes_sha256": "MATCHES_PRIVATE_MANIFEST",
        "book_identity": "B03_PINNED_SHA_MATCHED" if source["book_id"] == "B03" else "MANIFEST_DECLARED_ONLY",
        "physical_page": source["physical_page_1_based"],
        "page_count": source["page_count"],
        "candidate_lineage": (
            "LOCAL_RECEIPTS_CONSISTENT_NOT_INDEPENDENTLY_ATTESTED"
            if all(entry["state"] == "LOCAL_HASH_CONSISTENT_SELF_ATTESTED" for entry in receipts)
            else "DECLARED_NOT_INDEPENDENTLY_ATTESTED"
        ),
        "candidate_receipts": receipts,
        "reference_status": "NOT_APPROVED",
        "official_cer": None,
        "engine_ranking": None,
        "pairwise": pairwise,
        "production": "UNVERIFIED",
    }
    reference = manifest["reference"]
    if reference is None:
        return result
    if not isinstance(reference, dict) or set(reference) != {
        "text", "source_sha256", "physical_page_1_based",
        "coverage", "review_status", "reviewer_approval_id", "independent_review"
    }:
        raise Blocked("REFERENCE_CONTRACT_INVALID")
    # Do not read or compare an unapproved reference; no global Gold by inference.
    if reference["coverage"] != "FULL_PAGE" or reference["review_status"] != "APPROVED" or (
        reference["independent_review"] is not True or
        not isinstance(reference["reviewer_approval_id"], str) or
        re.fullmatch(r"[A-Za-z0-9._-]{8,96}", reference["reviewer_approval_id"]) is None
    ):
        return result
    if reference["source_sha256"] != source["sha256"] or type(reference["physical_page_1_based"]) is not int or reference["physical_page_1_based"] != source["physical_page_1_based"]:
        raise Blocked("REFERENCE_SOURCE_PAGE_MISMATCH")
    approved = read_text(root, reference["text"])
    result["reference_status"] = "DECLARED_APPROVED_NOT_INDEPENDENTLY_VERIFIED"
    result["provisional_cer"] = []
    for name, text in texts:
        errors = distance(approved, text)
        result["provisional_cer"].append({
            "engine": name, "character_errors": errors, "reference_chars": len(approved),
            "cer": round(errors / len(approved), 6),
        })
    # Even a self-attested approved reference is not independently established Gold.
    # Human/independent provenance admission is a separate, future gate.
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Private local OCR candidate comparison; output metrics only")
    parser.add_argument("--root", required=True)
    parser.add_argument("--manifest", required=True, help="Private root-relative JSON manifest")
    args = parser.parse_args(argv)
    try:
        root = Path(args.root)
        if not root.is_dir() or root.is_symlink():
            raise Blocked("PRIVATE_ROOT_INVALID")
        manifest = json.loads(read_bounded(require_relative(root, args.manifest), MAX_MANIFEST_BYTES))
        output = compare(root, manifest)
        print(json.dumps(output, sort_keys=True, ensure_ascii=True, separators=(",", ":")))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, Blocked) and re.fullmatch(r"[A-Z_]+", str(error)) else "PRIVATE_REVIEW_BLOCKED"
        print(json.dumps({"schema": SCHEMA, "status": "BLOCKED", "reason": code,
                          "official_cer": None, "engine_ranking": None,
                          "production": "UNVERIFIED"}, sort_keys=True, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    sys.exit(main())
