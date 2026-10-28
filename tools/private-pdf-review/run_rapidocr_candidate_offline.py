#!/usr/bin/env python3
"""Run genuine local pinned RapidOCR against one SHA-verified private PDF page.

Writes private OCR text plus a hash-bound local receipt. Nothing containing
original text, file paths or PDF pixels is printed or uploaded. The receipt
is UNSIGNED and is not a trusted provenance attestation or Gold reference.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import unicodedata

SCRIPT_ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "acs_ocr_private_comparator", SCRIPT_ROOT / "compare_ocr_candidates_offline.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("PRIVATE_COMPARISON_MODULE_MISSING")
comp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(comp)

CHILD = SCRIPT_ROOT.parents[1] / "packages" / "ingestion" / "src" / "rapidocr" / "rapidocr-child.py"
ENGINE_VERSION = "3.9.2"
ONNX_VERSION = "1.22.1"
RECEIPT_RUNNER = "ACS_PRIVATE_LOCAL_OCR_V1"
MAX_CHILD_OUTPUT = 512_000


def directory_inside(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or len(relative) > 260 or not relative:
        raise comp.Blocked("UNSAFE_PRIVATE_OUTPUT")
    if any(x in relative for x in ("\\", "\0", ":")):
        raise comp.Blocked("UNSAFE_PRIVATE_OUTPUT")
    parts = Path(relative).parts
    if not parts or any(x in (".", "..", "") for x in parts) or Path(relative).is_absolute():
        raise comp.Blocked("UNSAFE_PRIVATE_OUTPUT")
    current = root
    for part in parts:
        current = current / part
        try:
            info = current.lstat()
        except OSError:
            raise comp.Blocked("PRIVATE_OUTPUT_DIRECTORY_MISSING") from None
        if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or
            getattr(info, "st_file_attributes", 0) &
            getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)):
            raise comp.Blocked("UNSAFE_PRIVATE_OUTPUT")
    if not current.resolve().is_relative_to(root.resolve()):
        raise comp.Blocked("UNSAFE_PRIVATE_OUTPUT")
    return current


def minimal_offline_environment() -> dict[str, str]:
    allowed = ("PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR",
               "PATHEXT", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR",
               "LOCALAPPDATA", "APPDATA", "LD_LIBRARY_PATH", "LANG")
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env.update({
        "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1",
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
        "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2", "MKL_NUM_THREADS": "2",
        "HTTP_PROXY": "http://127.0.0.1:1",
        "HTTPS_PROXY": "http://127.0.0.1:1",
        "ALL_PROXY": "http://127.0.0.1:1",
        "http_proxy": "http://127.0.0.1:1",
        "https_proxy": "http://127.0.0.1:1",
        "all_proxy": "http://127.0.0.1:1",
        "NO_PROXY": "*", "no_proxy": "*",
    })
    return env


def invoke_child(*args: str, timeout: int) -> dict:
    try:
        completed = subprocess.run(
            [sys.executable, str(CHILD), *args], cwd=str(SCRIPT_ROOT),
            env=minimal_offline_environment(), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            check=False, timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise comp.Blocked("RAPIDOCR_PROCESS_FAILED") from None
    if completed.returncode != 0 or len(completed.stdout) > MAX_CHILD_OUTPUT:
        raise comp.Blocked("RAPIDOCR_PROCESS_FAILED")
    try:
        data = completed.stdout.decode("utf-8")
        if len(data.splitlines()) != 1:
            raise ValueError("MULTILINE")
        record = json.loads(data)
    except (ValueError, UnicodeError):
        raise comp.Blocked("RAPIDOCR_PROTOCOL_INVALID") from None
    if not isinstance(record, dict) or record.get("schemaVersion") != 1:
        raise comp.Blocked("RAPIDOCR_PROTOCOL_INVALID")
    return record


def checked_source(root: Path, source: dict) -> tuple[Path, os.stat_result]:
    comp.validate_source(root, source)
    path = comp.require_relative(root, source["pdf"])
    return path, path.stat()


def run_candidate(
    root: Path, source: dict, output_dir: str, stem: str, runner=invoke_child
) -> dict:
    if not root.is_dir() or root.is_symlink():
        raise comp.Blocked("PRIVATE_ROOT_INVALID")
    if not isinstance(stem, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", stem) is None:
        raise comp.Blocked("PRIVATE_OUTPUT_NAME_INVALID")
    outputs = directory_inside(root, output_dir)
    text_path = outputs / (stem + ".txt")
    receipt_path = outputs / (stem + ".receipt.json")
    if text_path.exists() or receipt_path.exists() or text_path.is_symlink() or receipt_path.is_symlink():
        raise comp.Blocked("PRIVATE_OUTPUT_ALREADY_EXISTS")

    path, first = checked_source(root, source)
    probe = runner("--probe", timeout=30)
    if set(probe) != {"schemaVersion", "status", "rapidocr", "onnxruntime", "modelSha256"}:
        raise comp.Blocked("RAPIDOCR_PROBE_INVALID")
    model = probe["modelSha256"]
    if (probe["status"] != "READY" or probe["rapidocr"] != ENGINE_VERSION or
        probe["onnxruntime"] != ONNX_VERSION or
        not isinstance(model, str) or re.fullmatch("[0-9a-f]{64}", model) is None):
        raise comp.Blocked("RAPIDOCR_PROBE_INVALID")
    page = source["physical_page_1_based"]
    response = runner("--pdf", str(path), "--page", str(page - 1), timeout=120)
    if set(response) != {"schemaVersion", "status", "text"} or response["status"] != "SUCCEEDED":
        raise comp.Blocked("RAPIDOCR_PAGE_FAILED")
    text = response["text"]
    if not isinstance(text, str):
        raise comp.Blocked("RAPIDOCR_TEXT_INVALID")
    text = unicodedata.normalize("NFC", text.replace("\r\n", "\n"))
    if not text.strip() or "\0" in text or len(text) > comp.MAX_PAGE_CHARS:
        raise comp.Blocked("RAPIDOCR_TEXT_INVALID")
    # Independently hash the original again after the model has read it.
    second = path.stat()
    if (first.st_size != second.st_size or first.st_mtime_ns != second.st_mtime_ns or
        comp.sha_of(path, comp.MAX_PDF_BYTES) != source["sha256"]):
        raise comp.Blocked("SOURCE_CHANGED_DURING_OCR")
    encoded = text.encode("utf-8")
    if len(encoded) > comp.MAX_FILE_BYTES:
        raise comp.Blocked("RAPIDOCR_TEXT_INVALID")
    receipt = {
        "schema_version": 1, "status": "SUCCEEDED", "runner": RECEIPT_RUNNER,
        "engine": "rapidocr", "engine_version": ENGINE_VERSION,
        "source_sha256": source["sha256"], "source_size_bytes": source["size_bytes"],
        "physical_page_1_based": page,
        "text_sha256": hashlib.sha256(encoded).hexdigest(),
        "text_chars": len(text), "model_sha256": model,
    }
    payload = (json.dumps(receipt, ensure_ascii=True, sort_keys=True,
                          separators=(",", ":")) + "\n").encode("utf-8")
    created: list[Path] = []
    try:
        for target, data in ((text_path, encoded), (receipt_path, payload)):
            with target.open("xb") as stream:
                created.append(target)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
    except OSError:
        for target in created:
            try:
                target.unlink()
            except OSError:
                pass
        raise comp.Blocked("PRIVATE_OUTPUT_WRITE_FAILED") from None

    return {
        "status": "SUCCEEDED", "runner": RECEIPT_RUNNER,
        "engine": "rapidocr", "model_sha256": model,
        "physical_page_1_based": page,
        "local_text_receipt": "WRITTEN_NOT_INDEPENDENTLY_ATTESTED",
        "official_cer": None, "engine_ranking": None,
    }


def main(argv: list[str] | None = None) -> int:
    args = argparse.ArgumentParser(description="Private SHA-matched RapidOCR single-page runner")
    args.add_argument("--root", required=True)
    args.add_argument("--source-manifest", required=True,
                      help="Root-relative JSON with source keys only")
    args.add_argument("--output-dir", required=True,
                      help="Existing root-relative private directory")
    args.add_argument("--stem", required=True)
    options = args.parse_args(argv)
    try:
        root = Path(options.root)
        if not root.is_dir() or root.is_symlink():
            raise comp.Blocked("PRIVATE_ROOT_INVALID")
        source = json.loads(comp.read_bounded(
            comp.require_relative(root, options.source_manifest), comp.MAX_MANIFEST_BYTES
        ))
        result = run_candidate(root, source, options.output_dir, options.stem)
        print(json.dumps(result, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, comp.Blocked) and re.fullmatch(
            "[A-Z_]+", str(error)
        ) else "PRIVATE_OCR_BLOCKED"
        print(json.dumps({
            "status": "BLOCKED", "reason": code, "official_cer": None,
            "engine_ranking": None, "production": "UNVERIFIED",
        }, sort_keys=True, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    sys.exit(main())
