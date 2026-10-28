#!/usr/bin/env python3
"""B03 private Windows original-book identity check.

No OCR, model, network, dependency installation, file writes, or content export.
Only safe booleans/status strings are emitted.  A successful source match alone
does NOT establish lineage of an independently uploaded Library PNG.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import stat
import sys
from dataclasses import dataclass

BOOK_ID = "B03"
EXPECTED_SIZE = 151_495_200
EXPECTED_SHA256 = "5be652d2066b680f1242bf358979c549aaf8a1588d9648926ecd8b6c30697440"
EXPECTED_PAGES = 271
TARGET_PAGE_ONE_BASED = 67
DEFAULT_ROOT = r"D:\ai-cognitive-pdf-benchmark-data"
MAX_DISCOVERED_FILES = 30_000
MAX_CANDIDATES = 8
CHUNK = 4 * 1024 * 1024


class ReviewBlocked(Exception):
    """Fail closed; exception text must never go to CI or stdout."""


@dataclass(frozen=True)
class Finding:
    source: str
    page_count: str
    page_67_render: str
    library_image_lineage: str = "NOT_ATTESTED"

    def safe_record(self) -> dict[str, str | int]:
        return {
            "policy": "ACS_B03_PRIVATE_SOURCE_IDENTITY_V1",
            "book_id": BOOK_ID,
            "expected_physical_page_1_based": TARGET_PAGE_ONE_BASED,
            "source_pdf_sha256": self.source,
            "pdf_page_count_271": self.page_count,
            "page67_render_from_matched_pdf": self.page_67_render,
            "uploaded_library_png_identity": self.library_image_lineage,
            "full_page_gold": "NOT_MEASURED",
            "production": "UNVERIFIED",
        }


def digest_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def unsafe_link_or_reparse(path: pathlib.Path) -> bool:
    # Windows junctions are not always reported by is_symlink() in Python 3.11.
    try:
        metadata = path.lstat()
        return (path.is_symlink() or
                (hasattr(path, "is_junction") and path.is_junction()) or
                bool(getattr(metadata, "st_file_attributes", 0) &
                     getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)))
    except OSError:
        raise ReviewBlocked("PATH_INSPECTION_FAILED") from None


def identify_exact_original(
    root: pathlib.Path, expected_size: int = EXPECTED_SIZE, expected_sha: str = EXPECTED_SHA256
) -> pathlib.Path:
    """Match known SHA rather than a private filename. Reject symlinks and ambiguous matches."""
    if not root.is_dir() or unsafe_link_or_reparse(root):
        raise ReviewBlocked("PRIVATE_DATA_ROOT_UNAVAILABLE")
    if not isinstance(expected_size, int) or expected_size < 5:
        raise ReviewBlocked("INVALID_CONTRACT")
    if len(expected_sha) != 64 or any(ch not in "0123456789abcdef" for ch in expected_sha):
        raise ReviewBlocked("INVALID_CONTRACT")

    examined = 0
    candidates: list[pathlib.Path] = []
    for dirpath, dirs, files in os.walk(root, topdown=True, followlinks=False):
        base = pathlib.Path(dirpath)
        # Do not traverse reparse points or link targets.
        dirs[:] = sorted(d for d in dirs if not unsafe_link_or_reparse(base / d))
        for name in sorted(files):
            # Filter non-PDF OCR caches/images before applying scan budget.
            if not name.lower().endswith(".pdf"):
                continue
            examined += 1
            if examined > MAX_DISCOVERED_FILES:
                raise ReviewBlocked("SEARCH_TOO_BROAD")
            candidate = base / name
            if unsafe_link_or_reparse(candidate):
                continue
            try:
                stat = candidate.stat()
            except OSError:
                raise ReviewBlocked("SOURCE_STAT_FAILED") from None
            if stat.st_size == expected_size:
                candidates.append(candidate)
                if len(candidates) > MAX_CANDIDATES:
                    raise ReviewBlocked("TOO_MANY_SAME_SIZE_PDFS")

    matched: list[pathlib.Path] = []
    for path in candidates:
        try:
            first = path.stat()
            if digest_file(path) != expected_sha:
                continue
            second = path.stat()
        except OSError:
            raise ReviewBlocked("SOURCE_READ_FAILED") from None
        if first.st_size != expected_size or second.st_size != expected_size or \
                first.st_mtime_ns != second.st_mtime_ns:
            raise ReviewBlocked("SOURCE_CHANGED_DURING_SCAN")
        matched.append(path)
    if not matched:
        raise ReviewBlocked("B03_SHA_NOT_FOUND")
    # Identical files may exist in caches and archives. A single selected
    # source is required before establishing any downstream page lineage.
    if len(matched) != 1:
        raise ReviewBlocked("MULTIPLE_IDENTICAL_B03_COPIES")
    return matched[0]


def verify_page_source(path: pathlib.Path) -> tuple[str, str]:
    """Optional local PDF rendering, not visual equality with uploaded Library PNG."""
    try:
        import fitz  # PyMuPDF, optional preinstalled package; never auto-install
    except ImportError:
        return "NOT_TESTED_PYMUPDF_UNAVAILABLE", "NOT_TESTED_PYMUPDF_UNAVAILABLE"
    try:
        document = fitz.open(str(path))  # lazily opens file; do NOT read_bytes()
        try:
            if len(document) != EXPECTED_PAGES:
                return "MISMATCH", "NOT_TESTED_PAGE_COUNT_INVALID"
            page = document.load_page(TARGET_PAGE_ONE_BASED - 1)
            rect = page.rect
            if rect.width <= 0 or rect.height <= 0 or max(rect.width, rect.height) > 20000:
                return "PASS", "INVALID_PAGE_GEOMETRY"
            scale = min(1.0, 768.0 / max(rect.width, rect.height))
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            if pixmap.width < 1 or pixmap.height < 1 or pixmap.width > 768 or pixmap.height > 768:
                return "PASS", "INVALID_RENDER_DIMENSIONS"
            # Rendering only; no pixels written, printed, uploaded or hashed.
            return "PASS", "PASS"
        finally:
            document.close()
    except Exception:
        return "NOT_VERIFIED_PDF_RENDER_ERROR", "NOT_VERIFIED_PDF_RENDER_ERROR"


def inspect(root: pathlib.Path) -> Finding:
    path = identify_exact_original(root)
    # Hashing the original and opening a page are separate operations.
    # Re-check after rendering to detect a private PDF replaced or edited
    # between the first SHA verification and its second path-based open.
    try:
        before = path.stat()
        if before.st_size != EXPECTED_SIZE or unsafe_link_or_reparse(path):
            raise ReviewBlocked("SOURCE_CHANGED_DURING_PAGE_VERIFY")
        page_count, render = verify_page_source(path)
        middle = path.stat()
        if (before.st_size != middle.st_size or
                before.st_mtime_ns != middle.st_mtime_ns or
                unsafe_link_or_reparse(path)):
            raise ReviewBlocked("SOURCE_CHANGED_DURING_PAGE_VERIFY")
        # Even a same-size, timestamp-preserving replacement must fail.
        if digest_file(path) != EXPECTED_SHA256:
            raise ReviewBlocked("SOURCE_CHANGED_DURING_PAGE_VERIFY")
        after = path.stat()
        if (middle.st_size != after.st_size or
                middle.st_mtime_ns != after.st_mtime_ns or
                unsafe_link_or_reparse(path)):
            raise ReviewBlocked("SOURCE_CHANGED_DURING_PAGE_VERIFY")
    except OSError:
        raise ReviewBlocked("SOURCE_CHANGED_DURING_PAGE_VERIFY") from None
    return Finding("PASS", page_count, render)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="B03 read-only local SHA + physical page check")
    parser.add_argument("--root", default=DEFAULT_ROOT,
                        help="Local PRIVATE data root; never uploaded or printed")
    args = parser.parse_args(argv)
    try:
        result = inspect(pathlib.Path(args.root))
        print("ACS_B03_PRIVATE_SOURCE_PROOF=" + json.dumps(result.safe_record(),
             ensure_ascii=True, sort_keys=True, separators=(",", ":")))
        # If PyMuPDF is not installed, SHA identity is still proven; page verification stays open.
        return 0 if result.page_count == "PASS" and result.page_67_render == "PASS" else 2
    except Exception as error:
        # Only allow predeclared invariant codes, never raw OS/PDF exceptions or paths.
        allowed = {
            "PRIVATE_DATA_ROOT_UNAVAILABLE", "INVALID_CONTRACT", "SEARCH_TOO_BROAD",
            "SOURCE_STAT_FAILED", "TOO_MANY_SAME_SIZE_PDFS",
            "SOURCE_READ_FAILED", "SOURCE_CHANGED_DURING_SCAN",
            "B03_SHA_NOT_FOUND", "MULTIPLE_IDENTICAL_B03_COPIES", "PATH_INSPECTION_FAILED",
            "SOURCE_CHANGED_DURING_PAGE_VERIFY",
        }
        reason = str(error) if isinstance(error, ReviewBlocked) and str(error) in allowed else "PRIVATE_READ_BLOCKED"
        print("ACS_B03_PRIVATE_SOURCE_PROOF=" + json.dumps({
            "reason_code": reason,
            "policy": "ACS_B03_PRIVATE_SOURCE_IDENTITY_V1",
            "book_id": BOOK_ID,
            "source_pdf_sha256": "NOT_VERIFIED",
            "pdf_page_count_271": "NOT_VERIFIED",
            "page67_render_from_matched_pdf": "NOT_VERIFIED",
            "uploaded_library_png_identity": "NOT_ATTESTED",
            "full_page_gold": "NOT_MEASURED",
            "production": "UNVERIFIED",
        }, sort_keys=True, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    sys.exit(main())
