#!/usr/bin/env python3
"""B31 source-only RapidOCR 3.9.2 / ONNXRuntime CPU in an ISOLATED D: venv.

Must not read GLM output, request/provider credentials, or download models.
Only packaged ONNX weights are permitted and validated before RapidOCR().
All recognized text and boxes stay on the user's private D: evidence volume.
"""
import argparse
import hashlib
from importlib import metadata, util
import json
import math
import os
from pathlib import Path
import sys

from ebook_b31_source_raster_geometry import read_evidence
from ebook_b31_offline_ocr import parse_results
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

OUT = "b31_source_rapidocr392.private.json"
EVIDENCE = "B31_SHA_BOUND_SOURCE_RAPIDOCR392_NOT_GOLD"
MAX_BYTES = 550000
EXPECTED = {"rapidocr": "3.9.2", "onnxruntime": "1.22.1"}
MAX_PIXELS = 4_000_000


def probe_bundled_weights():
    """Inspect only packaged ONNX files; return private SHA fingerprints."""
    versions = {}
    for name, version in EXPECTED.items():
        try:
            found = metadata.version(name)
        except metadata.PackageNotFoundError:
            raise VisualGateError("RAPID_OCR_DEPENDENCY_MISSING") from None
        if found != version:
            raise VisualGateError("RAPID_OCR_PACKAGE_VERSION_MISMATCH")
        versions[name] = found
    spec = util.find_spec("rapidocr")
    if spec is None or spec.origin is None:
        raise VisualGateError("RAPID_OCR_PACKAGE_NOT_IMPORTABLE")
    package = Path(spec.origin).resolve().parent
    models = package / "models"
    if not models.is_dir() or models.is_symlink():
        raise VisualGateError("RAPID_OCR_BUNDLED_MODELS_MISSING")
    onnx = sorted(p for p in models.glob("*.onnx")
                  if p.is_file() and not p.is_symlink())
    labels = {kind for p in onnx for kind in ("det", "rec", "cls")
              if kind in p.name.lower()}
    if not {"det", "rec"}.issubset(labels):
        raise VisualGateError("RAPID_OCR_BUNDLED_DET_REC_MISSING")
    results = {}
    for p in onnx:
        if not 10000 < p.stat().st_size <= 150_000_000:
            raise VisualGateError("RAPID_OCR_BUNDLED_WEIGHT_SIZE_INVALID")
        results[p.name] = hashlib.sha256(p.read_bytes()).hexdigest()
    return versions, results


def ocr_rows(bgr, engine):
    result = engine(bgr)
    if result is None:
        raise VisualGateError("RAPID_OCR_NULL_RESULT")
    boxes, txts, scores = (
        getattr(result, "boxes", None),
        getattr(result, "txts", None),
        getattr(result, "scores", None))
    if all(v is None for v in (boxes, txts, scores)):
        return []
    if any(v is None for v in (boxes, txts, scores)):
        raise VisualGateError("RAPID_OCR_PARTIAL_RESULT")
    if not (len(boxes) == len(txts) == len(scores)):
        raise VisualGateError("RAPID_OCR_RESULT_CARDINALITY")
    return parse_results([(q, t, float(s)) for q,t,s in
                          zip(boxes, txts, scores)],
                         bgr.shape[1], bgr.shape[0])


def run(root, manifest, cv2, np, *, write=False, engine=None,
        probe=None):
    png, meta, folder = read_evidence(root, manifest)
    dest = folder / OUT
    if dest.exists() or dest.is_symlink():
        raise VisualGateError("RAPID_OCR_PRIVATE_REPORT_EXISTS")
    w, h = meta["render_width"], meta["render_height"]
    if (type(w) is not int or type(h) is not int or
            w < 32 or h < 32 or w*h > MAX_PIXELS or
            len(png) < 24 or png[12:16] != b"IHDR" or
            int.from_bytes(png[16:20], "big") != w or
            int.from_bytes(png[20:24], "big") != h):
        raise VisualGateError("RAPID_OCR_SOURCE_DIMENSIONS_INVALID")
    versions, hashes = probe_bundled_weights() if probe is None else probe
    if (versions != EXPECTED or not isinstance(hashes, dict) or
            not hashes or any(not isinstance(s, str) or
            len(s) != 64 for s in hashes.values())):
        raise VisualGateError("RAPID_OCR_MODEL_PROVENANCE_INVALID")
    bgr = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_COLOR)
    if bgr is None or bgr.shape != (h, w, 3):
        raise VisualGateError("RAPID_OCR_PAGE_DECODE_INVALID")
    if engine is None:
        from rapidocr import RapidOCR
        engine = RapidOCR()
    rows = ocr_rows(bgr, engine)
    rows_sha = hashlib.sha256(json.dumps(
        rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")).hexdigest()
    data = {
        "schema_version": 1,
        "evidence": EVIDENCE,
        "book_id": "B31",
        "physical_page": 126,
        "source_document_sha256": meta["source_document_sha256"],
        "source_page_png_sha256": meta["private_png_sha256"],
        "engine_versions": versions,
        "bundled_model_hashes": hashes,
        "recognized_line_count": len(rows),
        "recognized_character_count": sum(len(row["text"]) for row in rows),
        "private_source_ocr_rows": rows,
        "private_rows_sha256": rows_sha,
        "ocr_quality_gold": None,
        "independent_graph_gold": None,
        "arrow_direction_verified": False,
        "certified_graph_f1": None,
        "provider_calls": 0,
        "model_downloads": 0,
        "only_bundled_local_models": True,
    }
    blob = (json.dumps(data, ensure_ascii=False,
                       sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    if len(blob) > MAX_BYTES:
        raise VisualGateError("RAPID_OCR_RESULT_BYTES_EXCEEDED")
    if write:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        with os.fdopen(os.open(dest, flags, 0o600), "wb") as out:
            out.write(blob)
    return data


def audit_existing(root, manifest):
    _, meta, folder = read_evidence(root, manifest)
    path = folder / OUT
    if (path.is_symlink() or not path.is_file() or
            not 0 < path.stat().st_size <= MAX_BYTES):
        raise VisualGateError("RAPID_OCR_PRIVATE_RECEIPT_MISSING")
    try:
        data = json.loads(path.read_text(encoding="utf-8"),
                          object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (UnicodeError, ValueError, TypeError):
        raise VisualGateError("RAPID_OCR_PRIVATE_RECEIPT_JSON_INVALID") from None
    if (not isinstance(data, dict) or data.get("schema_version") != 1 or
            data.get("evidence") != EVIDENCE or
            data.get("book_id") != "B31" or
            type(data.get("physical_page")) is not int or
            data["physical_page"] != 126 or
            data.get("source_document_sha256") != meta["source_document_sha256"] or
            data.get("source_page_png_sha256") != meta["private_png_sha256"] or
            data.get("engine_versions") != EXPECTED or
            data.get("model_downloads") != 0 or
            data.get("provider_calls") != 0 or
            data.get("only_bundled_local_models") is not True or
            data.get("ocr_quality_gold", object()) is not None or
            data.get("independent_graph_gold", object()) is not None or
            data.get("certified_graph_f1", object()) is not None or
            data.get("arrow_direction_verified") is not False or
            not isinstance(data.get("private_source_ocr_rows"), list)):
        raise VisualGateError("RAPID_OCR_PRIVATE_RECEIPT_PROVENANCE_INVALID")
    hashes = data.get("bundled_model_hashes")
    if (not isinstance(hashes, dict) or not hashes or
            any(not isinstance(name, str) or not isinstance(value, str) or
                len(value) != 64 or any(c not in "0123456789abcdef" for c in value)
                for name,value in hashes.items())):
        raise VisualGateError("RAPID_OCR_PRIVATE_MODEL_DIGEST_INVALID")
    try:
        rows = parse_results([(r["quad"],r["text"],r["score"])
                              for r in data["private_source_ocr_rows"]],
                             meta["render_width"],meta["render_height"])
    except (ValueError, TypeError, KeyError) as err:
        raise VisualGateError("RAPID_OCR_PRIVATE_RECEIPT_ROWS_INVALID") from err
    rows_sha = hashlib.sha256(json.dumps(
        rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")).hexdigest()
    if (data.get("private_rows_sha256") != rows_sha or
            rows != data["private_source_ocr_rows"] or
            len(rows) != data.get("recognized_line_count") or
            sum(len(x["text"]) for x in rows) != data.get("recognized_character_count")):
        raise VisualGateError("RAPID_OCR_PRIVATE_RECEIPT_COUNT_MISMATCH")
    return data


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--private-root", required=True)
    p.add_argument("--manifest", required=True)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--write", action="store_true")
    g.add_argument("--audit-only", action="store_true")
    args = p.parse_args(argv)
    manifest = json.loads(Path(args.manifest).read_text("utf-8"))
    if args.audit_only:
        report = audit_existing(Path(args.private_root), manifest)
    else:
        import cv2
        import numpy as np
        report = run(Path(args.private_root),manifest,cv2,np,write=args.write)
    print("ACS_B31_RAPIDOCR_STATUS=" + (
        "PRIVATE_CREATED" if args.write else
        "PRIVATE_RECEIPT_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_B31_RAPIDOCR_LINES="+str(report["recognized_line_count"]))
    print("ACS_B31_RAPIDOCR_CHARS="+str(report["recognized_character_count"]))
    print("ACS_B31_RAPIDOCR_QUALITY_GOLD=UNVERIFIED")
    print("ACS_B31_RAPIDOCR_GRAPH_GOLD=UNVERIFIED")
    print("ACS_B31_RAPIDOCR_PROVIDER_CALLS=0")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VisualGateError, OSError, TypeError, ValueError,
            ImportError, RuntimeError) as error:
        print("ACS_B31_RAPIDOCR_REJECTED="+(
            error.code if isinstance(error, VisualGateError)
            else type(error).__name__))
        sys.exit(2)
