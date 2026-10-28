#!/usr/bin/env python3
"""Bridge five *existing* SHA-bound OCR focus source images into private v28.

No OCR, PDF rerender, model, Gold creation, external API, or public artifact.
Only five focus pages can be staged; the other 15 stay missing and CER null.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

from ebook_private_gold_cer_gate_v28 import (
    BOOKS, GateError, digest, encode, make_report, read_json, require,
)
from ebook_multibook_native_matrix import EVIDENCE as NATIVE_EVIDENCE

SCHEMA = 29
SOURCE_FOLDER = "multibook_matrix_20261023"
SUBDIR = "fivebook_v28_source_bridge_v29"
PACKET = "fivebook_source_candidates.v28.private.json"
RECEIPT = "fivebook_source_bridge.v29.private.json"
FOCUS = {"B03": 67, "B08": 64, "B15": 109, "B29": 72, "B31": 126}
V17 = "b08_b29_b31_source_hidpi_v17"
V17_RECEIPT = "b08_b29_b31_source_hidpi.v17.private.json"
NATIVE_RECEIPT = "multibook_native_24pages.private.json"
MAX_IMAGE = 18_000_000
PNG_HEADER = b"\x89PNG\r\n\x1a\n"

def safe_png(path, expected_sha):
    require(not path.is_symlink() and path.is_file(), "SOURCE_PNG_MISSING")
    require(8 < path.stat().st_size <= MAX_IMAGE, "SOURCE_PNG_SIZE_INVALID")
    raw = path.read_bytes()
    require(raw.startswith(PNG_HEADER), "SOURCE_PNG_NOT_PNG")
    require(digest(raw) == expected_sha, "SOURCE_PNG_SHA_CHANGED")
    return raw

def exact_index(rows, allowed):
    require(type(rows) is list and len(rows) == len(allowed), "SOURCE_RECEIPT_ROW_COUNT")
    result = {}
    for row in rows:
        require(type(row) is dict and row.get("book_id") in allowed and
                row["book_id"] not in result, "SOURCE_RECEIPT_ROW_DUPLICATE")
        result[row["book_id"]] = row
    require(set(result) == set(allowed), "SOURCE_RECEIPT_ROW_SET_CHANGED")
    return result

def source_bundle(private_root, manifest):
    root = Path(private_root)
    require(root.is_dir() and not root.is_symlink(), "PRIVATE_ROOT_INVALID")
    directory = root / "semantic_gate" / SOURCE_FOLDER
    require(directory.is_dir() and not directory.is_symlink() and
            not directory.parent.is_symlink(), "PRIVATE_MATRIX_MISSING")
    require(manifest.get("corpus_id") == "ACS-EBOOK-20261022-A" and
            type(manifest.get("sources")) is list, "SOURCE_MANIFEST_INVALID")
    sources = {}
    for item in manifest["sources"]:
        require(type(item) is dict, "SOURCE_MANIFEST_ROW_INVALID")
        book = item.get("id")
        if book in BOOKS:
            require(book not in sources and item.get("format") == "pdf" and
                    type(item.get("total_physical_pages")) is int and
                    type(item.get("ocr_physical_pages")) is list and
                    FOCUS[book] in item["ocr_physical_pages"] and
                    type(item.get("selected_physical_pages")) is list and
                    FOCUS[book] in item["selected_physical_pages"] and
                    type(item.get("sha256")) is str and len(item["sha256"]) == 64,
                    "SOURCE_MANIFEST_FOCUS_CHANGED")
            sources[book] = item
    require(set(sources) == set(BOOKS), "FIVE_BOOK_SOURCE_MISSING")
    native = read_json(directory / NATIVE_RECEIPT)
    require(native.get("schema_version") == 1 and
            native.get("evidence") == NATIVE_EVIDENCE, "NATIVE_PARENT_RECEIPT_CHANGED")
    rows = native.get("rows")
    require(type(rows) is list and len(rows) == 6, "NATIVE_PARENT_COVERAGE_CHANGED")
    native_index = exact_index(rows, set(BOOKS) | {"B16"})
    v17_dir = directory / V17
    require(v17_dir.is_dir() and not v17_dir.is_symlink(), "V17_SOURCE_FOLDER_MISSING")
    previous = read_json(v17_dir / V17_RECEIPT)
    require(previous.get("schema_version") == 17 and
            previous.get("status") == "SOURCE_ONLY_NOT_GOLD" and
            previous.get("independent_approval") is False, "V17_APPROVAL_STATE_CHANGED")
    high = exact_index(previous.get("rows"), {"B08", "B29", "B31"})
    images = {}
    result = []
    provenance = []
    for book in BOOKS:
        page = FOCUS[book]
        info = sources[book]
        r = native_index[book]
        require(r.get("source_document_sha256") == info["sha256"] and
                r.get("ocr_focus_requested") == page and
                type(r.get("pages")) is list and
                len(r["pages"]) == len(info["selected_physical_pages"]),
                "NATIVE_SOURCE_PAGE_IDENTITY_CHANGED")
        focus = [p for p in r["pages"] if p.get("physical_page") == page]
        require(len(focus) == 1, "NATIVE_FOCUS_PAGE_MISSING")
        parent_png = focus[0].get("ocr_focus_png")
        require(parent_png == f"{book}_p{page:04d}.private.png" and
                type(focus[0].get("ocr_focus_png_sha256")) is str,
                "NATIVE_FOCUS_SHA_MISSING")
        original = safe_png(directory / parent_png,
                            focus[0]["ocr_focus_png_sha256"])
        if book in high:
            high_row = high[book]
            require(high_row.get("physical_page") == page and
                    high_row.get("original_pdf_sha256_private") == info["sha256"] and
                    high_row.get("independent_gold") is False and
                    high_row.get("full_png_name") == f"{book}_p{page:04d}_FULL.private.png" and
                    type(high_row.get("full_png_sha256_private")) is str,
                    "V17_SOURCE_IDENTITY_CHANGED")
            raw = safe_png(v17_dir / high_row["full_png_name"],
                           high_row["full_png_sha256_private"])
            tier = "V17_HIDPI_SOURCE_3X"
        else:
            # v13 saves B03/B15 *tiles*, not the full-size source page.
            # Preserve the existing native-focus PNG bytes (no fake 3x render).
            raw = original
            tier = "NATIVE_FOCUS_SOURCE_1P4X"
        name = f"{book}_p{page:04d}_FULL.private.png"
        images[name] = raw
        result.append({
            "book_id": book, "physical_page": page,
            "source_pdf_sha256": info["sha256"],
            "source_png_filename": name, "source_png_sha256": digest(raw),
            "reference": None, "candidates": [],
            "bleedthrough": "UNDETERMINED"
        })
        provenance.append({
            "book_id": book, "physical_page": page, "source_tier": tier,
            "original_book_sha256_private": info["sha256"],
            "native_focus_png_sha256_private": digest(original),
            "staged_png_sha256_private": digest(raw),
            "gold_approved": False, "ocr_candidate_imported": False
        })
    require(len(images) == len(result) == 5, "BRIDGE_FIVE_SOURCE_PAGES_INCOMPLETE")
    packet = {"schema_version": 28, "corpus_id": manifest["corpus_id"], "rows": result}
    receipt = {"schema_version": SCHEMA,
               "status": "PRIVATE_SOURCE_ONLY_NO_GOLD",
               "corpus_id": manifest["corpus_id"],
               "staged_pages": 5, "selected_pages": 20, "unavailable_selected_pages": 15,
               "independent_approved_pages": 0,
               "official_cer": None, "new_model_calls": 0, "rows": provenance}
    return directory, images, packet, receipt

def execute(root, manifest, *, write=False, audit=False):
    require(write != audit, "EXPLICIT_MODE_REQUIRED")
    folder, images, packet, receipt = source_bundle(root, manifest)
    target = folder / SUBDIR
    files = dict(images)
    files[PACKET] = encode(packet)
    files[RECEIPT] = encode(receipt)
    if audit:
        require(target.is_dir() and not target.is_symlink() and
                {x.name for x in target.iterdir()} == set(files),
                "PRIVATE_BRIDGE_SNAPSHOT_MISSING_OR_CHANGED")
        for name, raw in files.items():
            entry = target / name
            require(entry.is_file() and not entry.is_symlink() and
                    entry.read_bytes() == raw, "PRIVATE_BRIDGE_CONTENT_CHANGED")
    else:
        require(not target.exists() and not target.is_symlink(),
                "PRIVATE_BRIDGE_SNAPSHOT_EXISTS")
        with tempfile.TemporaryDirectory(dir=folder, prefix=".source-bridge-v29-") as scratch:
            stage = Path(scratch) / "staged"
            stage.mkdir()
            for name, raw in files.items():
                with (stage / name).open("xb") as dest:
                    dest.write(raw)
            require(not target.exists() and not target.is_symlink(),
                    "PRIVATE_BRIDGE_SNAPSHOT_RACE")
            os.rename(stage, target)
    report = make_report(manifest, packet, target)
    require(report["pending_pages"] == 20 and
            report["official_fivebook_cer"] is None and
            not report["fivebook_gold_complete"],
            "PRIVATE_BRIDGE_UNVERIFIED_GOLD_LEAK")
    return receipt

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-root", required=True)
    parser.add_argument("--manifest", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--audit-only", action="store_true")
    args = parser.parse_args()
    try:
        manifest = read_json(args.manifest)
        receipt = execute(args.private_root, manifest, write=args.write,
                          audit=args.audit_only)
        print("ACS_FIVEBOOK_V29=" + ("SOURCE_STAGED_PRIVATE" if args.write else "PRIVATE_AUDIT_PASS"))
        print("ACS_FIVEBOOK_V29_SOURCE_PAGES=" + str(receipt["staged_pages"]))
        print("ACS_FIVEBOOK_V29_UNAVAILABLE_SELECTED_PAGES=15")
        print("ACS_FIVEBOOK_V29_GOLD_APPROVED=0")
        print("ACS_FIVEBOOK_V29_OFFICIAL_CER=NULL")
        print("ACS_FIVEBOOK_V29_NEW_MODEL_CALLS=0")
        return 0
    except Exception:
        print("ACS_FIVEBOOK_V29=REJECTED")
        return 2

if __name__ == "__main__":
    sys.exit(main())
