#!/usr/bin/env python3
"""SHA-locked offline/private three-page PP-OCRv6 evaluation on Windows.

Original books and recognized text never leave the private local D: directory.
"""
import argparse
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import re
import time
import zipfile

BOOK_PAGES = {"B16": 53, "B15": 109, "B31": 126}
MAX_BYTES = 200 * 1024 * 1024


def normalize(value):
    return "".join(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]+", value)).lower()


def sources(root):
    for path in Path(root).rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        if path.suffix.lower() == ".pdf" and path.stat().st_size <= MAX_BYTES:
            yield path.read_bytes()
        elif path.suffix.lower() == ".zip":
            try:
                with zipfile.ZipFile(path) as archive:
                    for item in archive.infolist():
                        if item.is_dir() or item.file_size > MAX_BYTES or not item.filename.lower().endswith(".pdf"):
                            continue
                        with archive.open(item) as stream:
                            data = stream.read(MAX_BYTES + 1)
                        if len(data) <= MAX_BYTES:
                            yield data
            except (OSError, zipfile.BadZipFile):
                continue


def extract_text(ocr, image):
    import numpy as np
    results = ocr.predict(input=np.asarray(image))
    parts = []
    for item in results:
        data = item.json
        if callable(data):
            data = data()
        if "res" in data:
            data = data["res"]
        words = data.get("rec_texts")
        if not isinstance(words, list):
            raise TypeError("PaddleOCR result rec_texts missing or invalid")
        parts.extend(str(x) for x in words)
    return normalize("".join(parts))


def assess(item, raw, ocr):
    import pymupdf
    from PIL import Image
    from rapidfuzz.distance.Levenshtein import distance
    page_id = BOOK_PAGES[item["id"]]
    with pymupdf.open(stream=raw, filetype="pdf") as document:
        if len(document) != item["total_physical_pages"]:
            raise ValueError("Physical page count mismatch")
        page = document[page_id - 1]
        reference = normalize(page.get_text("text", sort=True))
        raster = page.get_pixmap(matrix=pymupdf.Matrix(1.6, 1.6),
                                 colorspace=pymupdf.csRGB, alpha=False)
        image = Image.open(io.BytesIO(raster.tobytes("png"))).convert("RGB")
        t = time.perf_counter()
        output = extract_text(ocr, image)
        duration = round((time.perf_counter() - t) * 1000, 1)
    result = {
        "book_id": item["id"], "physical_page": page_id, "status": "SUCCESS",
        "recognized_characters": len(output), "wall_ms": duration,
        "output_sha256": hashlib.sha256(output.encode("utf-8")).hexdigest(),
        "reference_layer_characters": len(reference),
    }
    if reference:
        errors = distance(reference, output)
        result["reference_layer_edit_distance"] = errors
        result["reference_layer_cer"] = round(errors / len(reference), 4)
        result["reference_quality"] = "NATIVE_PDF_TEXT_LAYER_PROXY_NOT_GROUND_TRUTH"
    else:
        result["reference_quality"] = "NO_REFERENCE_LAYER_NOT_ACCURACY_SCORED"
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    corpus = json.loads(Path(args.manifest).read_text("utf-8"))
    if corpus.get("schema_version") != 1:
        raise ValueError("Invalid corpus manifest schema")
    required = {e["sha256"]: e for e in corpus["sources"] if e["id"] in BOOK_PAGES}
    if len(required) != len(BOOK_PAGES):
        raise ValueError("Required three SHA records missing")
    from paddleocr import PaddleOCR
    started = time.perf_counter()
    pipeline = PaddleOCR(lang="ch", use_doc_orientation_classify=False,
                         use_doc_unwarping=False, use_textline_orientation=False,
                         engine="paddle", device="cpu")
    init_ms = round((time.perf_counter() - started) * 1000, 1)
    rows = {}
    for payload in sources(args.root):
        fixture = required.get(hashlib.sha256(payload).hexdigest())
        if fixture is None or fixture["id"] in rows:
            continue
        if len(payload) != fixture["size"]:
            raise ValueError("Matching SHA but unexpected size")
        try:
            rows[fixture["id"]] = assess(fixture, payload, pipeline)
            print("ACS_PADDLE_REAL_BOOK_COMPLETE=" + fixture["id"], flush=True)
        except Exception as error:
            rows[fixture["id"]] = {
                "book_id": fixture["id"], "physical_page": BOOK_PAGES[fixture["id"]],
                "status": "FAILURE", "error_type": type(error).__name__,
            }
            print("ACS_PADDLE_REAL_BOOK_FAILED=" + fixture["id"] + ":" + type(error).__name__,
                  flush=True)
        del payload
    missing = sorted(set(BOOK_PAGES).difference(rows))
    failed = sorted(k for k, row in rows.items() if row["status"] != "SUCCESS")
    report = {
        "schema_version": 1, "corpus_id": corpus["corpus_id"],
        "engine": "PaddleOCR PP-OCRv6 CPU", "version": importlib.metadata.version("paddleocr"),
        "initialization_ms": init_ms, "rows": [rows[k] for k in sorted(rows)],
        "missing": missing, "failed": failed,
        "evidence_level": "REAL_PRIVATE_PAGES_AUTOMATED_PROXY_NOT_HUMAN_GROUND_TRUTH",
        "limits": [
            "Pure OCR text does not reconstruct chart/flow graph relations",
            "Native text layer is a reference proxy, not an independent ground truth",
            "OCR model downloads and initialization are excluded from per-page inference wall time",
            "No original books/images/full extracted text are exported",
        ],
    }
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    intermediate = target.with_suffix(".tmp")
    intermediate.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
    intermediate.replace(target)
    if missing or failed:
        raise SystemExit("REAL_PADDLE_INCOMPLETE missing=" + ",".join(missing)
                         + " failed=" + ",".join(failed))
    print("ACS_PADDLE_REAL_PRIVATE_PASS=3", flush=True)


if __name__ == "__main__":
    main()
