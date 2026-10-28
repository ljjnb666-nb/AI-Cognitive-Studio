#!/usr/bin/env python3
"""Offline SHA-bound private Gold/CER evaluator. Never calls models or prints book text.

An approval is a claim of independent source-image review, not cryptographic
proof that the review itself was correct. Missing data never means zero CER.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

BOOKS = ("B03", "B08", "B15", "B29", "B31")
MAX_INPUT = 4_000_000
MAX_PAGE_TEXT = 12_000
MAX_CELLS = 25_000_000
SHA = re.compile(r"^[a-f0-9]{64}$")
MAX_PAGES = 60
GATE_VERSION = 28

class GateError(ValueError):
    pass

def require(test, code):
    if not test:
        raise GateError(code)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def encode(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")

def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEYS")
        result[key] = value
    return result

def read_json(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "PRIVATE_INPUT_MISSING")
    require(0 < path.stat().st_size <= MAX_INPUT, "PRIVATE_INPUT_SIZE_INVALID")
    try:
        return json.loads(path.read_bytes().decode("utf-8"), object_pairs_hook=no_duplicate_keys,
                          parse_constant=lambda v: (_ for _ in ()).throw(GateError("NONFINITE_JSON")))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise GateError("INVALID_PRIVATE_JSON") from None

def shape_keys(obj, required):
    require(type(obj) is dict and set(obj) == set(required), "PRIVATE_SCHEMA_KEYS_INVALID")

def valid_sha(v):
    return type(v) is str and SHA.fullmatch(v) is not None

def valid_text(v):
    return (type(v) is str and 0 < len(v) <= MAX_PAGE_TEXT and "\x00" not in v and
            not any(0xD800 <= ord(c) <= 0xDFFF for c in v))

def valid_candidate_text(v):
    return (type(v) is str and len(v) <= MAX_PAGE_TEXT and "\x00" not in v and
            not any(0xD800 <= ord(c) <= 0xDFFF for c in v))

def distance(a, b):
    require(valid_text(a) and valid_candidate_text(b), "CER_TEXT_INVALID")
    require(len(a) * len(b) <= MAX_CELLS, "CER_MATRIX_OVER_BUDGET")
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j-1] + (ca != cb)))
        previous = current
    return previous[-1]

def make_report(manifest, packet, source_images):
    require(type(manifest) is dict and type(manifest.get("corpus_id")) is str and
            type(manifest.get("sources")) is list, "CORPUS_MANIFEST_INVALID")
    require(packet.get("schema_version") == GATE_VERSION and
            packet.get("corpus_id") == manifest["corpus_id"] and
            type(packet.get("rows")) is list and 0 < len(packet["rows"]) <= MAX_PAGES,
            "GOLD_PACKET_INVALID")
    book_sources = {}
    for entry in manifest["sources"]:
        require(type(entry) is dict and type(entry.get("id")) is str, "SOURCE_ROW_INVALID")
        if entry["id"] in BOOKS:
            require(entry["id"] not in book_sources and valid_sha(entry.get("sha256")) and
                    type(entry.get("total_physical_pages")) is int and
                    entry["total_physical_pages"] > 0 and
                    type(entry.get("selected_physical_pages")) is list and
                    len(entry["selected_physical_pages"]) > 0,
                    "GOLD_SOURCE_MANIFEST_INVALID")
            book_sources[entry["id"]] = entry
    require(set(book_sources) == set(BOOKS), "FIVE_BOOK_SOURCE_MANIFEST_INCOMPLETE")
    for row in book_sources.values():
        pages = row["selected_physical_pages"]
        require(len(pages) == len(set(pages)) and all(type(x) is int and
                1 <= x <= row["total_physical_pages"] for x in pages),
                "SOURCE_PAGE_SELECTION_INVALID")
    expected = {(name, page) for name, row in book_sources.items()
                for page in row["selected_physical_pages"]}
    seen = set()
    evaluated = []
    pending = []
    for row in packet["rows"]:
        shape_keys(row, ("book_id", "physical_page", "source_pdf_sha256", "source_png_filename",
                         "source_png_sha256", "reference", "candidates", "bleedthrough"))
        book, page = row["book_id"], row["physical_page"]
        require(type(book) is str and type(page) is int and (book, page) in expected and
                (book, page) not in seen, "GOLD_SOURCE_PAGE_MISMATCH")
        seen.add((book, page))
        require(row["source_pdf_sha256"] == book_sources[book]["sha256"] and
                valid_sha(row["source_png_sha256"]), "GOLD_SOURCE_HASH_MISMATCH")
        image_name = row["source_png_filename"]
        require(type(image_name) is str and
                re.fullmatch(r"B(?:03|08|15|29|31)_p\d{4}_FULL\.private\.png", image_name) and
                image_name == f"{book}_p{page:04d}_FULL.private.png", "GOLD_SOURCE_IMAGE_NAME_INVALID")
        image = Path(source_images) / image_name
        require(image.parent.resolve() == Path(source_images).resolve() and
                image.is_file() and not image.is_symlink() and
                0 < image.stat().st_size <= 18_000_000 and
                digest(image.read_bytes()) == row["source_png_sha256"],
                "GOLD_SOURCE_IMAGE_CHANGED")
        require(row["bleedthrough"] in ("FRONT_ONLY_VERIFIED", "UNDETERMINED"),
                "BLEEDTHROUGH_STATE_INVALID")
        candidates = row["candidates"]
        require(type(candidates) is list and len(candidates) <= 5, "CANDIDATES_INVALID")
        observed_engines = set()
        for c in candidates:
            shape_keys(c, ("engine", "text", "source_pdf_sha256", "physical_page"))
            require(type(c["engine"]) is str and re.fullmatch(r"[a-zA-Z0-9_-]{1,35}", c["engine"]) and
                    c["engine"] not in observed_engines and valid_candidate_text(c["text"]) and
                    c["source_pdf_sha256"] == row["source_pdf_sha256"] and
                    c["physical_page"] == page, "CANDIDATE_SOURCE_INVALID")
            observed_engines.add(c["engine"])
        reference = row["reference"]
        if reference is None:
            pending.append((book, page))
            continue
        shape_keys(reference, ("text", "text_sha256", "authority", "review_origin",
                               "source_png_sha256", "bleedthrough_verdict", "review_receipt",
                               "reviewer_record_id", "full_page_coverage"))
        require(type(reference["reviewer_record_id"]) is str and
                re.fullmatch(r"[A-Za-z0-9_-]{8,80}", reference["reviewer_record_id"]),
                "REFERENCE_REVIEWER_ID_INVALID")
        coverage = reference["full_page_coverage"]
        require(type(coverage) is dict and set(coverage) == {
                    "coverage_scope", "reviewed_grid_cells",
                    "sidebars_and_vertical_text_reviewed",
                    "all_visible_text_and_punctuation_transcribed",
                    "page_reading_order_reviewed", "unresolved_text_regions"
                } and coverage["coverage_scope"] == "COMPLETE_PHYSICAL_PAGE_TEXT" and
                coverage["reviewed_grid_cells"] == [
                    f"R{r}C{k}" for r in range(1, 4) for k in range(1, 4)
                ] and coverage["sidebars_and_vertical_text_reviewed"] is True and
                coverage["all_visible_text_and_punctuation_transcribed"] is True and
                coverage["page_reading_order_reviewed"] is True and
                type(coverage["unresolved_text_regions"]) is list and
                coverage["unresolved_text_regions"] == [],
                "REFERENCE_FULL_PAGE_COVERAGE_UNVERIFIED")
        require(valid_text(reference["text"]) and
                digest(reference["text"].encode("utf-8")) == reference["text_sha256"] and
                reference["source_png_sha256"] == row["source_png_sha256"], "REFERENCE_SHA_INVALID")
        require(reference["authority"] == "SOURCE_INDEPENDENT_APPROVED" and
                reference["review_origin"] == "DIRECT_SOURCE_IMAGE" and
                reference["bleedthrough_verdict"] == row["bleedthrough"] and
                row["bleedthrough"] == "FRONT_ONLY_VERIFIED", "REFERENCE_AUTHORITY_NOT_ESTABLISHED")
        receipt = reference["review_receipt"]
        shape_keys(receipt, ("status", "source_png_sha256", "reference_text_sha256",
                             "review_source", "engine_candidates_not_used_as_reference"))
        require(receipt["status"] == "APPROVED" and
                receipt["source_png_sha256"] == row["source_png_sha256"] and
                receipt["reference_text_sha256"] == reference["text_sha256"] and
                receipt["review_source"] == "ORIGINAL_PAGE_IMAGE" and
                receipt["engine_candidates_not_used_as_reference"] is True,
                "REFERENCE_REVIEW_RECEIPT_INVALID")
        # This checks an approval declaration; it cannot prove the declaration's honesty.
        for c in candidates:
            err = distance(reference["text"], c["text"])
            evaluated.append((book, page, c["engine"], err, len(reference["text"])))
    missing = sorted(expected - seen)
    # Missing pages are pending, never implicitly counted as error-free.
    pending.extend(missing)
    complete_books = sorted(book for book in BOOKS if all(
        (book, p) not in pending for p in book_sources[book]["selected_physical_pages"]))
    results = []
    for name in sorted({r[2] for r in evaluated}):
        rows = [r for r in evaluated if r[2] == name]
        errors = sum(r[3] for r in rows)
        chars = sum(r[4] for r in rows)
        results.append(dict(engine=name, evaluated_pages=len(rows), errors=errors,
                            reference_characters=chars, cer=errors / chars if chars else None))
    fivebook_complete = len(complete_books) == len(BOOKS) and not pending
    # Full coverage required PER ENGINE; partial engine results stay provisional.
    complete_engine_results = [r for r in results if r["evaluated_pages"] == len(expected)] if fivebook_complete else []
    partial_engine_results = [r for r in results if r["evaluated_pages"] < len(expected) or not fivebook_complete]
    return dict(schema_version=GATE_VERSION, corpus_id=manifest["corpus_id"],
                evaluation_scope="FIVE_BOOK_SELECTED_PAGES",
                input_page_count=len(expected), declared_source_approved_pages=len(expected)-len(pending),
                pending_pages=len(pending), complete_books=complete_books,
                fivebook_gold_complete=fivebook_complete,
                official_fivebook_cer=(complete_engine_results if complete_engine_results else None),
                provisional_page_metrics=(partial_engine_results if partial_engine_results else None),
                missing_packet_pages=len(missing), complete_engine_count=len(complete_engine_results),
                approval_audit_note="RECEIPTS_DECLARE_SOURCE_REVIEW_NOT_PROOF_OF_HUMAN_JUDGMENT",
                source_pdf_content_published=False, source_png_content_published=False)

def main():
    parser = argparse.ArgumentParser(description="Owner-only private independent Gold CER gate")
    parser.add_argument("--private-root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--packet", required=True)
    parser.add_argument("--source-images", required=True)
    parser.add_argument("--private-output", required=True)
    options = parser.parse_args()
    try:
        root = Path(options.private_root).resolve(strict=True)
        out = Path(options.private_output)
        require(out.parent.resolve() != root and root in out.resolve().parents and
                root in Path(options.source_images).resolve(strict=True).parents and
                root in Path(options.manifest).resolve(strict=True).parents and
                root in Path(options.packet).resolve(strict=True).parents,
                "PRIVATE_ROOT_BOUNDARY_INVALID")
        require(out.name.endswith(".private.json") and out.parent.is_dir() and
                not out.parent.is_symlink() and not out.is_symlink() and
                not out.exists() and out.parent.resolve() != Path.cwd().resolve(),
                "PRIVATE_OUTPUT_INVALID")
        report = make_report(read_json(options.manifest), read_json(options.packet),
                             options.source_images)
        with tempfile.NamedTemporaryFile(dir=out.parent, prefix=".gold-v28-", delete=False) as temp:
            staging = Path(temp.name)
            temp.write(encode(report))
        try:
            require(not out.exists(), "PRIVATE_OUTPUT_RACE")
            os.link(staging, out)
        finally:
            staging.unlink(missing_ok=True)
        print("ACS_GOLD_V28=PRIVATE_REPORT_WRITTEN")
        print("ACS_GOLD_V28_COMPLETE=" + ("YES" if report["fivebook_gold_complete"] else "NO"))
        print("ACS_GOLD_V28_PENDING_PAGES=" + str(report["pending_pages"]))
        print("ACS_GOLD_V28_OFFICIAL_CER=" + ("READY" if report["official_fivebook_cer"] is not None else "NULL"))
        return 0
    except Exception:
        # No paths, text, hashes or raw diagnostic messages on public runners.
        print("ACS_GOLD_V28=REJECTED")
        return 2

if __name__ == "__main__":
    sys.exit(main())
