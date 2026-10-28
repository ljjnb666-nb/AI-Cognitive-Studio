#!/usr/bin/env python3
"""Real pinned RapidOCR/ONNX test on a synthetic image-only PDF page.

No source books, network calls during OCR, credentials, or human-derived Gold.
This tests native Python child execution, not production accuracy/CER.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

import fitz


CHILD = Path(__file__).resolve().parents[2] / "src" / "rapidocr" / "rapidocr-child.py"
PHRASE = "HELLO STUDIO 2026"


def make_scanned_page(path: Path) -> None:
    """Rasterize generated printed text, then embed pixels in a new PDF."""
    text_pdf = fitz.open()
    text_page = text_pdf.new_page(width=612, height=792)
    text_page.insert_text((70, 220), PHRASE, fontsize=32, fontname="helv")
    text_page.insert_text((70, 280), "SYNTHETIC SCAN PAGE", fontsize=26, fontname="helv")
    pixmap = text_page.get_pixmap(matrix=fitz.Matrix(2, 2), colorspace=fitz.csRGB, alpha=False)
    scanned_pdf = fitz.open()
    scan = scanned_pdf.new_page(width=612, height=792)
    scan.insert_image(scan.rect, stream=pixmap.tobytes("png"), keep_proportion=False)
    scanned_pdf.save(path)
    scanned_pdf.close()
    text_pdf.close()
    with fitz.open(path) as check:
        if check.page_count != 1 or check[0].get_text().strip():
            raise AssertionError("SYNTHETIC_SOURCE_NOT_IMAGE_ONLY")
        if not check[0].get_images(full=True):
            raise AssertionError("SYNTHETIC_SOURCE_HAS_NO_PAINTED_IMAGE")


def offline_env() -> dict[str, str]:
    allowed = ("PATH", "HOME", "TMP", "TEMP", "TMPDIR", "LANG", "LD_LIBRARY_PATH")
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env.update({
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "OMP_NUM_THREADS": "2",
        "OPENBLAS_NUM_THREADS": "2",
        "MKL_NUM_THREADS": "2",
        "HTTP_PROXY": "http://127.0.0.1:1",
        "HTTPS_PROXY": "http://127.0.0.1:1",
        "ALL_PROXY": "http://127.0.0.1:1",
        "NO_PROXY": "",
        "http_proxy": "http://127.0.0.1:1",
        "https_proxy": "http://127.0.0.1:1",
        "all_proxy": "http://127.0.0.1:1",
        "no_proxy": "",
    })
    return env


def invoke(*args: str) -> tuple[int, dict]:
    completed = subprocess.run(
        [sys.executable, str(CHILD), *args],
        env=offline_env(),
        cwd=str(CHILD.parent),
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    # The fixed protocol is exactly one JSON line, no stdout diagnostics.
    lines = completed.stdout.strip().splitlines()
    if len(lines) != 1 or len(completed.stdout) > 200_000:
        raise AssertionError("RAPIDOCR_CHILD_PROTOCOL_INVALID")
    result = json.loads(lines[0])
    if not isinstance(result, dict):
        raise AssertionError("RAPIDOCR_CHILD_PROTOCOL_INVALID")
    return completed.returncode, result


def run() -> None:
    code, probe = invoke("--probe")
    if code != 0 or probe.get("schemaVersion") != 1 or probe.get("status") != "READY":
        raise AssertionError("RAPIDOCR_REAL_MODEL_PROBE_FAILED")
    if probe.get("rapidocr") != "3.9.2" or probe.get("onnxruntime") != "1.22.1":
        raise AssertionError("RAPIDOCR_PINNED_RUNTIME_MISMATCH")
    model_sha = probe.get("modelSha256")
    if not isinstance(model_sha, str) or not re.fullmatch("[0-9a-f]{64}", model_sha):
        raise AssertionError("RAPIDOCR_MODEL_PROVENANCE_INVALID")

    with tempfile.TemporaryDirectory(prefix="acs-rapidocr-model-smoke-") as folder:
        source = Path(folder) / "synthetic-image-only.pdf"
        make_scanned_page(source)
        if not source.read_bytes().startswith(b"%PDF-"):
            raise AssertionError("SYNTHETIC_PDF_MAGIC_INVALID")
        code, result = invoke("--pdf", str(source), "--page", "0", "--safe-diagnostic-stage")
        if code != 0 or result.get("schemaVersion") != 1 or result.get("status") != "SUCCEEDED":
            safe = {"START", "SOURCE_INPUT", "IMPORT_RASTER_AND_OCR", "RENDER_PDF_PAGE",
                    "RAPIDOCR_INFERENCE", "RAPIDOCR_RESULT_SCHEMA"}
            stage = result.get("safeStage")
            raise AssertionError("RAPIDOCR_REAL_PAGE_INFERENCE_FAILED_STAGE_" +
                                 (stage if stage in safe else "UNKNOWN"))
        raw = result.get("text")
        if not isinstance(raw, str):
            raise AssertionError("RAPIDOCR_REAL_TEXT_SCHEMA_INVALID")
        normalized = re.sub("[^A-Z0-9]", "", raw.upper())
        if "HELLOSTUDIO2026" not in normalized:
            # Never auto-promote this synthetic probe to an OCR accuracy claim.
            raise AssertionError("RAPIDOCR_SYNTHETIC_ANCHOR_NOT_RECOGNIZED")

        code, invalid = invoke("--pdf", str(source), "--page", "1")
        if code == 0 or invalid.get("status") != "FAILED":
            raise AssertionError("RAPIDOCR_OUT_OF_RANGE_PAGE_ACCEPTED")

    print("RAPIDOCR_MODEL_SMOKE_REAL_ONNX=PASS")
    print("RAPIDOCR_MODEL_SHA256=" + model_sha)
    print("RAPIDOCR_IMAGE_ONLY_PDF=PASS")
    print("RAPIDOCR_SYNTHETIC_TEXT_ANCHOR=PASS")
    print("RAPIDOCR_OUT_OF_RANGE_FAIL_CLOSED=PASS")
    print("RAPIDOCR_REAL_BOOK_CER=NOT_TESTED")


if __name__ == "__main__":
    run()
