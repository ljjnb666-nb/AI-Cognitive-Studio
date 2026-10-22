#!/usr/bin/env python3
"""SHA-selected MinerU 4 Flash text-layer test and offline Basic model diagnostics.

All document bytes, extracted Markdown and raw subprocess logs stay on the private
Windows D: drive. Public Actions output contains only sanitized IDs and counters.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import zipfile

PAGES = {"B16": 53, "B15": 109, "B31": 126}
MAX_SOURCE_BYTES = 200 * 1024 * 1024
ASCII_CJK = re.compile(r"[\u4e00-\u9fffA-Za-z0-9]+")


def normalize(value):
    return "".join(ASCII_CJK.findall(value)).lower()


def levenshtein(a, b):
    if len(a) < len(b):
        a, b = b, a
    prior = list(range(len(b) + 1))
    for i, char_a in enumerate(a, 1):
        curr = [i]
        for j, char_b in enumerate(b, 1):
            curr.append(min(prior[j] + 1, curr[j - 1] + 1, prior[j - 1] + (char_a != char_b)))
        prior = curr
    return prior[-1]


def candidates(root):
    for path in Path(root).rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        if path.suffix.lower() == ".pdf" and path.stat().st_size <= MAX_SOURCE_BYTES:
            yield path.read_bytes()
        elif path.suffix.lower() == ".zip":
            try:
                with zipfile.ZipFile(path) as zf:
                    for entry in zf.infolist():
                        if (entry.is_dir() or entry.file_size > MAX_SOURCE_BYTES
                                or not entry.filename.lower().endswith(".pdf")):
                            continue
                        with zf.open(entry) as stream:
                            data = stream.read(MAX_SOURCE_BYTES + 1)
                        if len(data) <= MAX_SOURCE_BYTES:
                            yield data
            except (OSError, zipfile.BadZipFile):
                continue


def offline_environment(private_root):
    env = os.environ.copy()
    env.update({
        "MINERU_MODEL_SOURCE": "local",
        "MINERU_MODEL_BASE_DIR": str(Path(private_root) / "models"),
        "HF_HUB_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1", "MODELSCOPE_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://127.0.0.1:9",
        "ALL_PROXY": "http://127.0.0.1:9",
        "NO_PROXY": "",
        "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2",
        "MINERU_INTRA_OP_NUM_THREADS": "2",
        "MINERU_INTER_OP_NUM_THREADS": "1",
    })
    return env


def run_private(command, env, workdir, prefix, timeout):
    started = time.perf_counter()
    stdout = Path(workdir) / (prefix + ".stdout.private.log")
    stderr = Path(workdir) / (prefix + ".stderr.private.log")
    try:
        with stdout.open("wb") as o, stderr.open("wb") as e:
            result = subprocess.run(command, stdout=o, stderr=e, env=env, timeout=timeout,
                                    shell=False, check=False)
        return {"exit_code": result.returncode,
                "wall_ms": round((time.perf_counter() - started) * 1000, 1)}
    except subprocess.TimeoutExpired:
        return {"exit_code": None,
                "status": "TIMEOUT",
                "wall_ms": round((time.perf_counter() - started) * 1000, 1)}


def classify_verify(result, stderr_log, stdout_log):
    if result["exit_code"] == 0:
        return "BASIC_ONNX_FILES_READY_NOT_INFERENCE_VERIFIED"
    if result.get("status") == "TIMEOUT":
        return "MODEL_VERIFY_TIMEOUT"
    text = ""
    for filename in (stderr_log, stdout_log):
        if Path(filename).is_file():
            text += Path(filename).read_text(encoding="utf-8", errors="replace")[-6000:].lower()
    if any(t in text for t in ("no such option", "unrecognized arguments", "unexpected argument", "no such command")):
        return "MODEL_VERIFY_CLI_ARGUMENT_UNSUPPORTED"
    if any(t in text for t in ("modulenotfounderror", "importerror", "no module named")):
        return "MODEL_VERIFY_RUNTIME_DEPENDENCY_MISSING"
    if any(t in text for t in ("missing", "not ready", "not found", "incomplete", "does not exist")):
        return "MODEL_VERIFY_ASSETS_MISSING_OR_WRONG_BASE_DIR"
    if any(t in text for t in ("permission denied", "access is denied")):
        return "MODEL_VERIFY_FILE_ACCESS_DENIED"
    return "MODEL_VERIFY_NONZERO_UNCLASSIFIED_PRIVATE_LOG"


def evaluate(book, payload, kit, temp_root, env):
    import fitz
    physical = PAGES[book["id"]]
    with fitz.open(stream=payload, filetype="pdf") as doc:
        if len(doc) != book["total_physical_pages"]:
            raise ValueError("SHA-selected source has changed physical page count")
        page = doc[physical - 1]
        reference = normalize(page.get_text("text", sort=True))
        single = fitz.open()
        single.insert_pdf(doc, from_page=physical - 1, to_page=physical - 1)
        data = single.tobytes()
        single.close()
    with tempfile.TemporaryDirectory(prefix="acs-mineru-flash-", dir=temp_root) as tmp:
        source = Path(tmp) / (book["id"] + "_physical_" + str(physical) + ".pdf")
        target = Path(tmp) / "output.md"
        source.write_bytes(data)
        private_logs = Path(env["ACS_MINERU_PRIVATE_LOG_DIR"])
        result = run_private(
            [str(kit), "parse", str(source), "-o", str(target),
             "--tier", "flash", "--ocr-mode", "txt"],
            env, private_logs, env["ACS_MINERU_RUN_ID"] + "-flash-" + book["id"], 120,
        )
        row = {"book_id": book["id"], "physical_page": physical,
               "engine": "MinerU4_Flash_native_txt",
               "wall_ms": result["wall_ms"], "exit_code": result["exit_code"],
               "reference_layer_characters": len(reference)}
        if result.get("status") == "TIMEOUT":
            row["status"] = "TIMEOUT"
        elif result["exit_code"] == 0 and target.is_file():
            extracted = normalize(target.read_text(encoding="utf-8", errors="replace"))
            row.update({
                "status": "SUCCESS", "characters": len(extracted),
                "text_sha256": hashlib.sha256(extracted.encode("utf-8")).hexdigest(),
            })
            if reference:
                row["reference_layer_cer"] = round(levenshtein(reference, extracted) / len(reference), 4)
                row["reference_quality"] = "NATIVE_PDF_TEXT_LAYER_PROXY_NOT_HUMAN_GROUND_TRUTH"
            else:
                row["reference_quality"] = "NO_TEXT_LAYER; FLASH_TXT_DOES_NOT_TEST_SCANNED_OCR"
        else:
            row["status"] = "CLI_FAILED_OR_NO_OUTPUT"
    return row


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--kit", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    root = Path(args.root).resolve()
    target = Path(args.output).resolve()
    if not target.is_relative_to(root):
        raise ValueError("Report must remain in private root")
    kit = Path(args.kit)
    if not kit.is_file():
        raise FileNotFoundError("Verified existing mineru-kit.exe absent")
    manifest = json.loads(Path(args.manifest).read_text("utf-8"))
    if manifest.get("schema_version") != 1:
        raise ValueError("Unsupported corpus manifest")
    required = {item["sha256"]: item for item in manifest["sources"] if item["id"] in PAGES}
    if len(required) != len(PAGES):
        raise ValueError("Required book fixtures absent")
    private_temp = root / "temp"
    private_temp.mkdir(parents=True, exist_ok=True)
    env = offline_environment(root)
    private_logs = root / "reports" / "mineru-flash-private-logs"
    private_logs.mkdir(parents=True, exist_ok=True)
    from uuid import uuid4
    run_id = uuid4().hex
    env["ACS_MINERU_PRIVATE_LOG_DIR"] = str(private_logs)
    env["ACS_MINERU_RUN_ID"] = run_id
    rows = {}
    prefix = run_id + "-basic-onnx-verify"
    cmd = [str(kit), "models", "verify", "--tier", "basic", "--small-backend", "onnx"]
    verification = run_private(cmd, env, private_logs, prefix, 90)
    verified = classify_verify(
        verification, private_logs / (prefix + ".stderr.private.log"),
        private_logs / (prefix + ".stdout.private.log"),
    )
    print("ACS_MINERU_BASIC_ONNX_CLASS=" + verified, flush=True)
    for data in candidates(root):
        item = required.get(hashlib.sha256(data).hexdigest())
        if item is None or item["id"] in rows:
            continue
        if len(data) != item["size"]:
            raise ValueError("SHA matched but byte count changed")
        try:
            rows[item["id"]] = evaluate(item, data, kit, private_temp, env)
        except Exception as err:
            rows[item["id"]] = {"book_id": item["id"], "physical_page": PAGES[item["id"]],
                                "status": "FAILED", "error_type": type(err).__name__}
        print("ACS_MINERU_FLASH_PAGE_STATUS=" + item["id"] + ":" + rows[item["id"]]["status"],
              flush=True)
        del data
    missing = sorted(set(PAGES).difference(rows))
    failed = sorted(id for id, item in rows.items() if item["status"] != "SUCCESS")
    kit_python = kit.parent / "python.exe"
    if not kit_python.is_file():
        raise FileNotFoundError("Companion MinerU interpreter missing")
    version_check = subprocess.run(
        [str(kit_python), "-c", "import importlib.metadata; print(importlib.metadata.version('mineru'))"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False,
        env=env,
    )
    if version_check.returncode != 0:
        raise RuntimeError("Unable to verify installed MinerU version")
    mineru_version = version_check.stdout.decode("utf-8", errors="replace").strip()
    if not mineru_version.startswith("4."):
        raise ValueError("Expected verified MinerU 4 runtime")
    report = {
        "schema_version": 1,
        "corpus_id": manifest["corpus_id"],
        "evidence_level": "ACTUAL_WINDOWS_MINERU_FLASH_NATIVE_ONLY",
        "mineru_version": mineru_version,
        "model_verification_class": verified,
        "model_verification_exit_code": verification["exit_code"],
        "model_verification_ms": verification["wall_ms"],
        "missing": missing, "failed": failed,
        "rows": [rows[key] for key in sorted(rows)],
        "limits": [
            "Flash --ocr-mode txt does not test OCR on scanned pages",
            "Basic/ONNX verification is independent of Flash parsing and does not download weights",
            "Book sources and converted PDF/Markdown never leave the private D: drive; temporary parses are deleted",
            "Raw subprocess logs are preserved only in D: private reports; no raw stdout/stderr is printed to GitHub",
            "Text-layer CER is a proxy, not independently adjudicated truth",
        ],
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_suffix(".tmp")
    staging.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    staging.replace(target)
    if missing or failed:
        raise SystemExit("MINERU_FLASH_BENCHMARK_INCOMPLETE missing="
                         + ",".join(missing) + " failed=" + ",".join(failed))
    print("ACS_MINERU_FLASH_REAL_PRIVATE_PASS=3", flush=True)


if __name__ == "__main__":
    main()
