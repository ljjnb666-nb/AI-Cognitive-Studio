#!/usr/bin/env python3
"""Low-memory SHA-pinned PyMuPDF real-page metadata; original PDFs stay private.

No OCR, Docling model, page images or textual content is exported. Full report
is written only beneath the private D: benchmark root.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile

from ebook_windows_private_preflight import _digest, PreflightError, MAX_PDF_BYTES

PAGES = {"B15": 109, "B16": 53, "B31": 126}
EXPECTED_ROTATION = {"B15": 270, "B16": 0, "B31": 0}


def _raw_sources(root, source_map):
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        if path.suffix.lower() == ".pdf" and path.stat().st_size <= MAX_PDF_BYTES:
            with path.open("rb") as stream:
                identity = _digest(stream)
            if identity in source_map:
                yield source_map[identity], path.read_bytes()
        elif path.suffix.lower() == ".zip":
            try:
                with zipfile.ZipFile(path) as archive:
                    if len(archive.infolist()) > 4000:
                        continue
                    for info in archive.infolist():
                        if info.is_dir() or not info.filename.lower().endswith(".pdf") or not 0 < info.file_size <= MAX_PDF_BYTES or info.flag_bits & 0x1:
                            continue
                        with archive.open(info) as stream:
                            identity = _digest(stream)
                        if identity in source_map:
                            with archive.open(info) as stream:
                                raw = stream.read(MAX_PDF_BYTES + 1)
                            if len(raw) != identity[0]:
                                raise PreflightError("NATIVE_ZIP_MEMBER_SIZE_MISMATCH")
                            yield source_map[identity], raw
            except (OSError, zipfile.BadZipFile, RuntimeError):
                continue


def _summarize(book, raw, fixture, fitz):
    with fitz.open(stream=raw, filetype="pdf") as document:
        pages = document.page_count
        if pages != fixture["total_physical_pages"]:
            raise PreflightError("NATIVE_PAGE_COUNT_CHANGED")
        page_no = PAGES[book]
        if page_no > pages:
            raise PreflightError("NATIVE_PHYSICAL_PAGE_OUTSIDE_SOURCE")
        page = document[page_no - 1]
        rotation = int(page.rotation)
        if rotation != EXPECTED_ROTATION[book]:
            raise PreflightError("NATIVE_PHYSICAL_ROTATION_CHANGED")
        text = "".join(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]+", page.get_text("text", sort=True))).lower()
        return {
            "book_id": book,
            "physical_page": page_no,
            "total_physical_pages": pages,
            "pdf_rotation_degrees": rotation,
            "native_text_chars": len(text),
            "native_text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "independent_ocr_ground_truth": "UNVERIFIED",
            "diagram_semantics": "UNVERIFIED",
        }


def evaluate(root, manifest, fitz):
    if not root.is_dir() or root.is_symlink():
        raise PreflightError("PRIVATE_ROOT_INVALID")
    if not isinstance(manifest, dict) or not isinstance(manifest.get("sources"), list):
        raise PreflightError("NATIVE_MANIFEST_INVALID")
    expected = {}
    by_identity = {}
    for row in manifest["sources"]:
        if not isinstance(row, dict) or row.get("id") not in PAGES:
            continue
        book = row["id"]
        if (book in expected or type(row.get("size")) is not int or not 0 < row["size"] <= MAX_PDF_BYTES or
                type(row.get("total_physical_pages")) is not int or
                not isinstance(row.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", row["sha256"])):
            raise PreflightError("NATIVE_MANIFEST_TARGET_INVALID")
        expected[book] = row
        identity = (row["size"], row["sha256"])
        if identity in by_identity:
            raise PreflightError("NATIVE_MANIFEST_DUPLICATE_SOURCE")
        by_identity[identity] = book
    if set(expected) != set(PAGES):
        raise PreflightError("NATIVE_MANIFEST_TARGET_MISSING")
    results = {}
    for book, raw in _raw_sources(root, by_identity):
        if book not in results:
            results[book] = _summarize(book, raw, expected[book], fitz)
        del raw
        if len(results) == len(PAGES):
            break
    return {"schema_version": 1, "evidence": "REAL_PRIVATE_PYMUPDF_NATIVE_NOT_OCR_GROUND_TRUTH",
            "observed": sorted(results), "missing": sorted(set(PAGES)-set(results)),
            "rows": [results[b] for b in sorted(results)]}


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--manifest", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args(argv)
    root = Path(args.root).resolve(strict=True)
    output = Path(args.output).resolve()
    if not output.is_relative_to(root) or output.suffix.lower() != ".json":
        raise PreflightError("NATIVE_OUTPUT_OUTSIDE_PRIVATE_ROOT")
    import fitz
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    report = evaluate(root, manifest, fitz)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=True, indent=2)+"\n", encoding="utf-8")
    temporary.replace(output)
    for row in report["rows"]:
        print("ACS_PRIVATE_NATIVE_PAGE=" + row["book_id"] +
              "|PHYSICAL=" + str(row["physical_page"]) +
              "|ROTATION=" + str(row["pdf_rotation_degrees"]) +
              "|NATIVE_CHARS=" + str(row["native_text_chars"]) +
              "|GRAPH=UNVERIFIED")
    print("ACS_PRIVATE_NATIVE_MATCHED=" + str(len(report["rows"])))
    if report["missing"]:
        print("ACS_PRIVATE_NATIVE_MISSING=" + ",".join(report["missing"]))
        return 3
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (PreflightError, OSError, ValueError) as e:
        print("ACS_PRIVATE_NATIVE_REJECTED=" + (str(e) if isinstance(e, PreflightError) else type(e).__name__))
        sys.exit(2)
