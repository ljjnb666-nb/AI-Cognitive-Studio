#!/usr/bin/env python3
"""Blind B31 real-page OCR with ONLY already-bundled local models.

Never downloads OCR weights, calls any cloud provider or reads a model's
graph candidate. Real recognized text and box coordinates are kept solely
in D: private files, never printed to Actions logs/artifacts.
"""
import argparse
import hashlib
import importlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys

from ebook_b31_source_raster_geometry import read_evidence
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

OUT = "b31_source_offline_ocr.private.json"
MAX_LINES = 300
MAX_CHARS = 4000
MAX_OUTPUT_BYTES = 500_000
MAX_PIXELS = 4_000_000
PROVENANCE = "SOURCE_ONLY_OFFLINE_OCR_NOT_INDEPENDENT_GOLD"
ENGINE_NAME = "rapidocr_onnxruntime"
SCRIPT_VERSION = "2026-10-23-ocr-01"


def available_bundled_engine():
    """A local-engine gate: never import engine unless ONNX weights exist on disk."""
    spec = importlib.util.find_spec(ENGINE_NAME)
    if spec is None or not spec.origin:
        return False, "PACKAGE_NOT_INSTALLED"
    base = Path(spec.origin).parent
    if base.is_symlink() or not base.is_dir():
        return False, "PACKAGE_DIRECTORY_UNSAFE"
    # Legacy rapidocr_onnxruntime ships default weights in-package; a mere
    # Python import is insufficient proof of offline model availability.
    models = [p for p in base.rglob("*.onnx") if p.is_file() and not p.is_symlink()
              and 0 < p.stat().st_size < 150_000_000]
    kinds = {kind for p in models for kind in ("det", "rec")
             if kind in p.name.lower()}
    if not {"det", "rec"}.issubset(kinds):
        return False, "BUNDLED_DET_REC_WEIGHTS_NOT_FOUND"
    return True, "BUNDLED_MODELS_PRESENT"


def parse_results(raw, width, height):
    """Validate old RapidOCR (box,text,score) structure; never guess a label."""
    if raw is None:
        raw = []
    if type(raw) not in (list, tuple) or len(raw) > MAX_LINES:
        raise VisualGateError("OCR_OUTPUT_SHAPE_OR_LIMIT_INVALID")
    rows = []
    for line in raw:
        if type(line) not in (list, tuple) or len(line) < 3:
            raise VisualGateError("OCR_RESULT_ROW_INVALID")
        box, txt, confidence = line[:3]
        if not isinstance(txt, str) or not 0 < len(txt) <= 120 or (
                any(ord(ch) < 32 and ch not in "\t" for ch in txt)):
            raise VisualGateError("OCR_TEXT_FIELD_INVALID")
        if (type(confidence) not in (float, int) or not
                math.isfinite(confidence) or not 0 <= confidence <= 1):
            raise VisualGateError("OCR_CONFIDENCE_INVALID")
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            raise VisualGateError("OCR_BOX_INVALID")
        pts = []
        for p in box:
            if (not isinstance(p, (list, tuple)) or len(p) != 2 or
                    any(type(x) not in (int, float) or
                        not math.isfinite(x) for x in p) or
                    not 0 <= p[0] <= width or not 0 <= p[1] <= height):
                raise VisualGateError("OCR_BOX_COORDINATES_INVALID")
            pts.append([round(float(p[0]), 2), round(float(p[1]), 2)])
        rows.append({
            "text": txt,
            "score": round(float(confidence), 4),
            "quad": pts,
            "origin": "LOCAL_SOURCE_IMAGE_OCR_NOT_GOLD",
        })
    if sum(len(r["text"]) for r in rows) > MAX_CHARS:
        raise VisualGateError("OCR_PAGE_TEXT_BUDGET_EXCEEDED")
    return rows


def invoke_local_engine(bgr, engine=None):
    if engine is None:
        from rapidocr_onnxruntime import RapidOCR
        engine = RapidOCR()
    result = engine(bgr)
    if not isinstance(result, (list, tuple)) or len(result) != 2:
        raise VisualGateError("OCR_ENGINE_RETURN_CONTRACT_INVALID")
    return result[0]


def analyze(root, manifest, cv2, np, *, engine=None, write=False,
            availability=None):
    png, meta, folder = read_evidence(root, manifest)
    target = folder / OUT
    if target.exists() or target.is_symlink():
        raise VisualGateError("OCR_PRIVATE_RESULT_ALREADY_EXISTS")
    width, height = meta["render_width"], meta["render_height"]
    if (type(width) is not int or type(height) is not int or
            not 32 <= width <= 3000 or not 32 <= height <= 3000 or
            width*height > MAX_PIXELS or
            len(png) < 24 or png[12:16] != b"IHDR" or
            int.from_bytes(png[16:20], "big") != width or
            int.from_bytes(png[20:24], "big") != height):
        raise VisualGateError("OCR_PAGE_DIMENSION_PREFLIGHT_FAILED")
    img = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None or img.shape != (height, width, 3):
        raise VisualGateError("OCR_PAGE_DECODE_INVALID")
    if availability is None:
        availability = available_bundled_engine()
    available, reason = availability
    if type(available) is not bool or reason not in (
        "PACKAGE_NOT_INSTALLED", "PACKAGE_DIRECTORY_UNSAFE",
        "BUNDLED_DET_REC_WEIGHTS_NOT_FOUND", "BUNDLED_MODELS_PRESENT"):
        raise VisualGateError("OCR_ENGINE_PROBE_INVALID")
    if available != (reason == "BUNDLED_MODELS_PRESENT"):
        raise VisualGateError("OCR_ENGINE_PROBE_INCONSISTENT")
    # Unit tests may inject an in-memory fake engine; Windows real path only
    # instantiates RapidOCR when *bundled and local* weights were found.
    rows = parse_results(invoke_local_engine(img, engine), width, height) if available else []
    outcome = "OFFLINE_OCR_OBSERVATION" if available else "NO_OFFLINE_OCR_ENGINE"
    record = {
        "schema_version": 1,
        "evidence": PROVENANCE,
        "script_version": SCRIPT_VERSION,
        "book_id": "B31",
        "physical_page": 126,
        "source_document_sha256": meta["source_document_sha256"],
        "source_page_png_sha256": meta["private_png_sha256"],
        "offline_engine": ENGINE_NAME if available else None,
        "engine_availability_reason": reason,
        "outcome": outcome,
        "recognized_line_count": len(rows),
        "recognized_character_count": sum(len(x["text"]) for x in rows),
        "recognized_private_lines": rows,
        "all_text_stays_private": True,
        "no_download_or_provider_request": True,
        "arrow_direction_verified": False,
        "independent_graph_gold": None,
        "certified_graph_f1": None,
        "provider_calls": 0,
    }
    payload = (json.dumps(record, ensure_ascii=False,
                          sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    if len(payload) > MAX_OUTPUT_BYTES:
        raise VisualGateError("OCR_PRIVATE_REPORT_TOO_LARGE")
    if write:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(target, flags, 0o600)
        with os.fdopen(fd, "wb") as out:
            out.write(payload)
    return record


def audit_existing(root, manifest):
    _, meta, folder = read_evidence(root, manifest)
    target = folder / OUT
    if target.is_symlink() or not target.is_file() or not 0 < target.stat().st_size <= MAX_OUTPUT_BYTES:
        raise VisualGateError("OCR_PRIVATE_RECEIPT_MISSING_OR_UNSAFE")
    try:
        data = json.loads(target.read_text(encoding="utf-8"),
                          object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (ValueError, TypeError, UnicodeError):
        raise VisualGateError("OCR_PRIVATE_RECEIPT_JSON_INVALID") from None
    if (not isinstance(data, dict) or data.get("schema_version") != 1 or
            data.get("script_version") != SCRIPT_VERSION or
            data.get("evidence") != PROVENANCE or
            data.get("book_id") != "B31" or
            type(data.get("physical_page")) is not int or data["physical_page"] != 126 or
            data.get("source_document_sha256") != meta["source_document_sha256"] or
            data.get("source_page_png_sha256") != meta["private_png_sha256"] or
            data.get("all_text_stays_private") is not True or
            data.get("no_download_or_provider_request") is not True or
            data.get("provider_calls") != 0 or
            data.get("independent_graph_gold", object()) is not None or
            data.get("certified_graph_f1", object()) is not None or
            data.get("arrow_direction_verified") is not False or
            type(data.get("recognized_line_count")) is not int or
            type(data.get("recognized_character_count")) is not int or
            not isinstance(data.get("recognized_private_lines"), list)):
        raise VisualGateError("OCR_PRIVATE_RECEIPT_PROVENANCE_INVALID")
    rows = parse_results([
        (r["quad"], r["text"], r["score"]) for r in data["recognized_private_lines"]],
        meta["render_width"], meta["render_height"])
    if (len(rows) != data["recognized_line_count"] or
            sum(len(r["text"]) for r in rows) != data["recognized_character_count"] or
            rows != data["recognized_private_lines"] or
            (data.get("outcome") == "NO_OFFLINE_OCR_ENGINE" and len(rows) != 0) or
            data.get("outcome") not in ("OFFLINE_OCR_OBSERVATION", "NO_OFFLINE_OCR_ENGINE")):
        raise VisualGateError("OCR_PRIVATE_RECEIPT_CONTENT_MISMATCH")
    return data


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-root", required=True)
    parser.add_argument("--manifest", required=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--write", action="store_true")
    modes.add_argument("--audit-only", action="store_true")
    args = parser.parse_args(argv)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    if args.audit_only:
        report = audit_existing(Path(args.private_root), manifest)
    else:
        import cv2
        import numpy as np
        report = analyze(Path(args.private_root), manifest, cv2, np, write=args.write)
    print("ACS_B31_BLIND_OCR_STATUS=" +
          ("PRIVATE_WRITTEN" if args.write else
           "PRIVATE_RECEIPT_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_B31_BLIND_OCR_OUTCOME=" + report["outcome"])
    print("ACS_B31_BLIND_OCR_ENGINE_READINESS=" + report["engine_availability_reason"])
    print("ACS_B31_BLIND_OCR_LINES=" + str(report["recognized_line_count"]))
    print("ACS_B31_BLIND_OCR_CHARS=" + str(report["recognized_character_count"]))
    print("ACS_B31_BLIND_OCR_GRAPH_GOLD=UNVERIFIED")
    print("ACS_B31_BLIND_OCR_PROVIDER_CALLS=0")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VisualGateError, ValueError, TypeError, OSError, ImportError) as err:
        code = err.code if isinstance(err, VisualGateError) else type(err).__name__
        print("ACS_B31_BLIND_OCR_REJECTED=" + code)
        sys.exit(2)
