#!/usr/bin/env python3
"""Memory-light, private-only SHA/sidecar inventory for Windows ebook samples.

This does NOT read book pages, OCR, or verify that AI visual ROI is correct.
It streams every PDF candidate in bounded chunks, never exports source bytes,
names, hashes, raw coordinates or any private file contents to stdout.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import zipfile

BOOKS = ("B15", "B16", "B31")
MAX_PDF_BYTES = 200 * 1024 * 1024
MAX_ZIP_ENTRIES = 4000
CHUNK_SIZE = 1024 * 1024


class PreflightError(ValueError):
    pass


def _digest(stream, max_bytes=MAX_PDF_BYTES):
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = stream.read(CHUNK_SIZE)
        if not chunk:
            return size, digest.hexdigest()
        size += len(chunk)
        if size > max_bytes:
            raise PreflightError("PRIVATE_PDF_SIZE_OVER_LIMIT")
        digest.update(chunk)


def _iter_pdf_digests(root):
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        if path.suffix.lower() == ".pdf":
            if path.stat().st_size > MAX_PDF_BYTES:
                continue
            with path.open("rb") as stream:
                yield _digest(stream)
        elif path.suffix.lower() == ".zip":
            try:
                with zipfile.ZipFile(path) as archive:
                    if len(archive.infolist()) > MAX_ZIP_ENTRIES:
                        continue
                    for info in archive.infolist():
                        if (info.is_dir() or not info.filename.lower().endswith(".pdf") or
                                info.file_size > MAX_PDF_BYTES or info.file_size < 1 or
                                info.flag_bits & 0x1):
                            continue
                        with archive.open(info) as stream:
                            observed = _digest(stream)
                        if observed[0] != info.file_size:
                            raise PreflightError("PRIVATE_ZIP_MEMBER_SIZE_MISMATCH")
                        yield observed
            except (OSError, zipfile.BadZipFile, RuntimeError):
                continue


def _read_private_json(root, relative):
    file = root / relative
    if not file.is_file():
        return None
    if file.is_symlink() or not file.resolve().is_relative_to(root.resolve()) or file.stat().st_size > 262144:
        raise PreflightError("PRIVATE_SIDECAR_INVALID")
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (UnicodeError, ValueError) as e:
        raise PreflightError("PRIVATE_SIDECAR_JSON_INVALID") from e


def preflight(root, manifest):
    if not root.is_dir() or root.is_symlink():
        raise PreflightError("PRIVATE_ROOT_INVALID")
    if not isinstance(manifest, dict) or not isinstance(manifest.get("sources"), list):
        raise PreflightError("CORPUS_MANIFEST_INVALID")
    expected = {}
    for row in manifest["sources"]:
        if not isinstance(row, dict) or row.get("id") not in BOOKS:
            continue
        if (row["id"] in expected or not isinstance(row.get("sha256"), str) or
                len(row["sha256"]) != 64 or type(row.get("size")) is not int or
                not 0 < row["size"] <= MAX_PDF_BYTES):
            raise PreflightError("CORPUS_TARGET_INVALID")
        expected[row["id"]] = (row["size"], row["sha256"])
    if set(expected) != set(BOOKS):
        raise PreflightError("CORPUS_TARGETS_MISSING")
    remaining = dict(expected)
    for size, sha in _iter_pdf_digests(root):
        for book, identity in tuple(remaining.items()):
            if identity == (size, sha):
                del remaining[book]
        if not remaining:
            break
    roi = _read_private_json(root, Path("semantic_gate") / "B15_B31_roi_candidates.private.json")
    calib = _read_private_json(root, Path("semantic_gate") / "B15_roi_frame_calibration.private.json")
    roi_status = "ABSENT"
    if roi is not None:
        if not isinstance(roi, dict) or roi.get("authority") != "L2_AI_VISUAL_PROVISIONAL_NOT_HUMAN_GROUND_TRUTH":
            raise PreflightError("PRIVATE_ROI_AUTHORITY_INVALID")
        roi_status = "PRESENT_NOT_ACCURACY_VERIFIED"
    calibration_status = "ABSENT"
    if calib is not None:
        if (not isinstance(calib, dict) or
                calib.get("authority") != "PRIVATE_AI_VISUAL_L2_FRAME_CALIBRATION_NOT_GROUND_TRUTH" or
                calib.get("book_id") != "B15" or
                calib.get("physical_page") != 109 or
                calib.get("source_document_sha256") != expected["B15"][1] or
                calib.get("source_pdf_rotation_degrees") != 270):
            raise PreflightError("PRIVATE_CALIBRATION_PROVENANCE_INVALID")
        calibration_status = "PRESENT_NOT_GEOMETRY_VERIFIED"
    return {
        "corpus_present": len(BOOKS) - len(remaining),
        "corpus_required": len(BOOKS),
        "missing_book_ids": sorted(remaining),
        "private_roi_status": roi_status,
        "private_calibration_status": calibration_status,
        "real_spatial_accuracy": "UNVERIFIED",
        "graph_semantics": "UNVERIFIED",
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args(argv)
    data = preflight(Path(args.root), json.loads(Path(args.manifest).read_text(encoding="utf-8")))
    print("ACS_PRIVATE_PREFLIGHT_SHA_MATCHED=" + str(data["corpus_present"]))
    print("ACS_PRIVATE_PREFLIGHT_SHA_REQUIRED=" + str(data["corpus_required"]))
    print("ACS_PRIVATE_PREFLIGHT_ROI=" + data["private_roi_status"])
    print("ACS_PRIVATE_PREFLIGHT_ROTATION_ANCHORS=" + data["private_calibration_status"])
    print("ACS_PRIVATE_PREFLIGHT_REAL_SPATIAL_ACCURACY=UNVERIFIED")
    print("ACS_PRIVATE_PREFLIGHT_GRAPH_SEMANTICS=UNVERIFIED")
    if data["missing_book_ids"]:
        print("ACS_PRIVATE_PREFLIGHT_SHA_MISSING=" + ",".join(data["missing_book_ids"]))
        return 3
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (PreflightError, OSError, ValueError) as e:
        print("ACS_PRIVATE_PREFLIGHT_REJECTED=" + (str(e) if isinstance(e, PreflightError) else type(e).__name__))
        sys.exit(2)
