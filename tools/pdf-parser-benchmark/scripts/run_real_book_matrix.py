"""Serial private real-book comparison runner for the existing benchmark CLI.

Works only from an installed Windows benchmark worktree. It does not install
dependencies or download models. Before executing real books:
  1. Run the 01A importer and 01B page-subset generator into private D: root.
  2. Run: python scripts/run_real_book_matrix.py
  3. After explicit model installation and readiness review:
     python scripts/run_real_book_matrix.py --include-models --models-ready

No private PDF bytes, full text or OCR content are written to the source tree.
The CLI performs the authoritative C:/D:/RAM preflight on EVERY parser run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

MODELS = (
    ("docling", "ocr", "RB-PDF-12"),
    ("docling", "ocr", "RB-PDF-13"),
    ("mineru", "flash", "RB-PDF-12"),
    ("mineru", "flash", "RB-PDF-13"),
)
NATIVE = tuple((parser, "default", fixture) for fixture in ("RB-PDF-11", "RB-PDF-12", "RB-PDF-13") for parser in ("pdfjs", "liteparse"))
SHA_LEN = 64
LINEAGE = {"RB-PDF-11": ("RB-PDF-01", [22, 107, 192]),
           "RB-PDF-12": ("RB-PDF-02", [73, 145, 261]),
           "RB-PDF-13": ("RB-PDF-03", [51, 127, 379])}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def manifest_fixture(root: Path, target: str) -> dict:
    manifest_path = root / "fixtures" / "fixtures.manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("PRIVATE_MANIFEST_MISSING_OR_SYMLINK")
    rows = json.loads(manifest_path.read_text(encoding="utf-8"))["fixtures"]
    matching = [r for r in rows if isinstance(r, dict) and r.get("id") == target]
    if len(matching) != 1 or matching[0].get("filename") != target + ".pdf":
        raise ValueError(f"PRIVATE_FIXTURE_MISSING_OR_DUPLICATE:{target}")
    row = matching[0]
    expected_sha = row.get("expectedSha256")
    bytes_expected = row.get("declaredBytes")
    if not isinstance(expected_sha, str) or len(expected_sha) != SHA_LEN or any(c not in "0123456789abcdef" for c in expected_sha):
        raise ValueError(f"PRIVATE_FIXTURE_SHA_NOT_PINNED:{target}")
    if type(bytes_expected) is not int or bytes_expected < 1:
        raise ValueError(f"PRIVATE_FIXTURE_SIZE_INVALID:{target}")
    path = manifest_path.parent / (target + ".pdf")
    if path.is_symlink() or not path.is_file() or path.stat().st_size != bytes_expected or sha256_file(path) != expected_sha:
        raise ValueError(f"PRIVATE_FIXTURE_INTEGRITY_FAILURE:{target}")
    if row.get("fixtureClass") != "private-real-page-subset":
        raise ValueError(f"PRIVATE_FIXTURE_CLASS_INVALID:{target}")
    source_id = row.get("sourceFixtureId")
    source_sha = row.get("sourceSha256")
    pages = row.get("sourcePages1Based")
    if not isinstance(source_id, str) or not isinstance(source_sha, str) or len(source_sha) != SHA_LEN or not isinstance(pages, list) or len(pages) != 3 or any(type(x) is not int or x < 1 for x in pages):
        raise ValueError(f"PRIVATE_SUBSET_LINEAGE_INVALID:{target}")
    origin_rows = [r for r in rows if isinstance(r, dict) and r.get("id") == source_id]
    if len(origin_rows) != 1 or origin_rows[0].get("expectedSha256") != source_sha:
        raise ValueError(f"PRIVATE_SUBSET_PARENT_CONFLICT:{target}")
    if (source_id, pages) != LINEAGE.get(target):
        raise ValueError(f"PRIVATE_SUBSET_PAGE_MAP_CONFLICT:{target}")
    parent = manifest_path.parent / (source_id + ".pdf")
    if (parent.is_symlink() or not parent.is_file() or
            parent.stat().st_size != origin_rows[0].get("declaredBytes") or
            sha256_file(parent) != source_sha):
        raise ValueError(f"PRIVATE_SUBSET_PARENT_FILE_CHANGED:{target}")
    return {"id": target, "expectedSha256": expected_sha, "parentSha256": source_sha, "sourcePages1Based": pages}


SUITES = ("native", "mineru-flash", "docling-ocr", "all")


def selected_matrix(include_models: bool, models_ready: bool, suite: str = "native") -> tuple[tuple[str, str, str], ...]:
    if suite not in SUITES or (include_models and suite != "native"):
        raise ValueError("INVALID_OR_AMBIGUOUS_SUITE")
    active = "all" if include_models else suite
    if active != "native" and not models_ready:
        raise ValueError("MODEL_READINESS_CONFIRMATION_REQUIRED")
    if active == "native":
        return NATIVE
    if active == "mineru-flash":
        return tuple(job for job in MODELS if job[0] == "mineru")
    if active == "docling-ocr":
        return tuple(job for job in MODELS if job[0] == "docling")
    return NATIVE + MODELS


def evidence_row(job: tuple[str, str, str], cp: subprocess.CompletedProcess[str], seconds: float, fixture: dict) -> dict:
    parser, mode, target = job
    try:
        payload = json.loads(cp.stdout)
    except (ValueError, TypeError):
        payload = {}
    payload = payload if isinstance(payload, dict) else {}
    rel = payload.get("reliability")
    rel = rel if isinstance(rel, dict) else {}
    extraction = payload.get("extraction")
    extraction = extraction if isinstance(extraction, dict) else {}
    document = payload.get("document")
    document = document if isinstance(document, dict) else {}
    run = payload.get("run")
    run = run if isinstance(run, dict) else {}
    warnings = rel.get("warnings")
    warnings = warnings if isinstance(warnings, list) else []
    identity_ok = (document.get("inputSha256") == fixture["expectedSha256"]
                   and document.get("fixtureId") == target)
    child_exit = rel.get("exitCode")
    safe_failure = not any(rel.get(x) for x in ("timeout", "partialOutput", "oom"))
    kind = rel.get("failureKind")
    ok = (identity_ok and cp.returncode == 0 and child_exit == 0 and safe_failure
          and rel.get("crashed") is False and kind in (None, False))
    # This is a documented negative control: the production PDF.js parser
    # rejects image-only source. Never treat it as a successful extraction.
    expected = (identity_ok and parser == "pdfjs" and mode == "default"
                and target in ("RB-PDF-12", "RB-PDF-13")
                and cp.returncode != 0 and child_exit == 3
                and rel.get("crashed") is False and safe_failure
                and kind == "EXPECTED_CAPABILITY_REJECTION"
                and "PARSER_ERROR: SOURCE_OCR_REQUIRED" in warnings
                and extraction.get("extractedPages") == 0
                and extraction.get("characters") == 0)
    classification = "EXECUTION_OK" if ok else "EXPECTED_CAPABILITY_REJECTION" if expected else "NOT_ACCEPTED"
    return {
        "fixtureId": target, "parser": parser, "mode": mode,
        "subsetSha256": fixture["expectedSha256"], "parentSha256": fixture["parentSha256"],
        "sourcePages1Based": fixture["sourcePages1Based"], "status": classification,
        "failureKind": kind if isinstance(kind, str) else None,
        "childExitCode": child_exit if type(child_exit) is int else None,
        "cliExitCode": cp.returncode, "runId": run.get("id"), "runtimeSeconds": round(seconds, 2),
        "extractedPages": extraction.get("extractedPages") if ok else None,
        "characters": extraction.get("characters") if ok else None,
        "reasonCode": ("NONE" if ok else "SOURCE_OCR_REQUIRED" if expected
                       else "CLI_NONZERO" if cp.returncode else "MISSING_OR_CONFLICTING_EVIDENCE"),
    }


def report_status(outcomes: list[dict], jobs: tuple, server_shutdown_ok: bool) -> str:
    if (not server_shutdown_ok or len(outcomes) != len(jobs)
            or any(row["status"] not in ("EXECUTION_OK", "EXPECTED_CAPABILITY_REJECTION") for row in outcomes)):
        return "INCOMPLETE_OR_FAILED"
    if any(row["status"] == "EXPECTED_CAPABILITY_REJECTION" for row in outcomes):
        return "BASELINE_COMPLETE_WITH_EXPECTED_REJECTIONS"
    return "EXECUTION_PASS_ONLY"


def write_atomic(path: Path, payload: dict) -> None:
    part = path.with_suffix(".json.part")
    with part.open("x", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(part, path)


def model_resource_preflight(data_root: Path) -> None:
    """Fail closed BEFORE starting MinerU; parser gates re-check resources later."""
    import ctypes
    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]
    status = MemoryStatus()
    status.dwLength = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise RuntimeError("MODEL_PHYSICAL_RAM_UNKNOWN")
    if status.ullAvailPhys < 4 * 1024 ** 3:
        raise RuntimeError("MODEL_RAM_PRESSURE_MIN_4_GB")
    if shutil.disk_usage("C:\\").free < 15 * 1024 ** 3:
        raise RuntimeError("MODEL_C_DRIVE_PRESSURE")
    if shutil.disk_usage(data_root).free < 30 * 1024 ** 3:
        raise RuntimeError("MODEL_DATA_DRIVE_PRESSURE")


def run(data_root: Path, *, include_models: bool, models_ready: bool, cli: Path, npx: str,
        suite: str = "native", offline_confirmed: bool = False) -> dict:
    jobs = selected_matrix(include_models, models_ready, suite)
    active_suite = "all" if include_models else suite
    active_models = {parser for parser, _, _ in jobs if parser in ("mineru", "docling")}
    if active_models and not offline_confirmed:
        raise ValueError("OFFLINE_MODEL_EXECUTION_CONFIRMATION_REQUIRED")
    if os.name != "nt":
        raise RuntimeError("WINDOWS_HOST_REQUIRED")
    if data_root.is_symlink() or not data_root.is_dir():
        raise ValueError("PRIVATE_DATA_ROOT_NOT_READY")
    if data_root.resolve().is_relative_to(cli.resolve().parents[3]):
        raise ValueError("PRIVATE_DATA_ROOT_INSIDE_REPO")
    fixture_rows = {fixture: manifest_fixture(data_root, fixture) for _, _, fixture in jobs}
    if not cli.is_file():
        raise ValueError("BENCHMARK_CLI_NOT_FOUND")
    if active_models:
        model_resource_preflight(data_root)
        # Verify ONLY selected model runtimes; do not require Docling to run MinerU.
        executables = {
            "docling": data_root / "python" / "docling" / "Scripts" / "python.exe",
            "mineru": data_root / "python" / "mineru" / "Scripts" / "mineru.exe",
        }
        for parser in active_models:
            exe = executables[parser]
            if exe.is_symlink() or not exe.is_file():
                raise ValueError(f"MODEL_EXECUTABLE_NOT_READY:{parser}")
        if (data_root / "models").is_symlink() or not (data_root / "models").is_dir():
            raise ValueError("MODEL_CACHE_ROOT_NOT_READY")
        # A folder existing does NOT prove weights are complete/offline safe.
        # The operator must additionally verify models and block outbound networking.
    runner = shutil.which(npx)
    if runner is None:
        raise ValueError("NPX_NOT_FOUND")
    report_dir = data_root / "reports"
    if report_dir.is_symlink() or not report_dir.is_dir():
        raise ValueError("PRIVATE_REPORT_DIR_NOT_READY")
    # A separate non-overwriting report per run; never overwrite earlier evidence.
    label = active_suite
    report_path = report_dir / f"real-book-matrix-{label}-{time.time_ns()}.json"
    if report_path.exists() or report_path.is_symlink():
        raise FileExistsError(f"PRIVATE_REPORT_COLLISION: {report_path}")
    # Offline switches constrain common model clients. The operator must also
    # block outbound networking: not every model loader honors these switches.
    child_env = dict(os.environ)
    if active_models:
        child_env.update({
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
            "MODELSCOPE_OFFLINE": "1",
        })
    outcomes = []
    server_started = False
    server_shutdown_ok = True
    try:
        for job in jobs:
            parser, mode, fixture_id = job
            if parser == "mineru" and not server_started:
                command = [runner, "--no-install", "tsx", str(cli), "mineru-server", "--action", "start"]
                start = subprocess.run(command, cwd=cli.parent.parent, capture_output=True, text=True, timeout=240, env=child_env)
                if start.returncode != 0:
                    raise RuntimeError("MINERU_SERVER_START_FAILED")
                server_started = True
            command = [runner, "--no-install", "tsx", str(cli), "run", "--parser", parser,
                       "--mode", mode, "--fixture", fixture_id, "--cold-only"]
            begun = time.monotonic()
            proc = subprocess.run(command, cwd=cli.parent.parent, capture_output=True, text=True, env=child_env,
                                  timeout=1800 if parser in ("docling", "mineru") else 300)
            item = evidence_row(job, proc, time.monotonic() - begun, fixture_rows[fixture_id])
            outcomes.append(item)
            print(json.dumps({"fixture": fixture_id, "parser": parser, "mode": mode, "status": item["status"],
                              "runtimeSeconds": item["runtimeSeconds"]}, ensure_ascii=False), flush=True)
            # Fail closed: do not consume more RAM / GPU or pretend a later success
            # makes a missing or failed case pass.
            if item["status"] not in ("EXECUTION_OK", "EXPECTED_CAPABILITY_REJECTION"):
                break
    finally:
        if server_started:
            try:
                stop = subprocess.run([runner, "--no-install", "tsx", str(cli), "mineru-server",
                                       "--action", "stop"], cwd=cli.parent.parent,
                                      capture_output=True, text=True, timeout=240, check=False, env=child_env)
                server_shutdown_ok = stop.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                server_shutdown_ok = False
        summary = {
            "schema": "acs-real-book-model-comparison-v1",
            "status": report_status(outcomes, jobs, server_shutdown_ok),
            "selectedSuite": active_suite,
            "executionPasses": sum(x["status"] == "EXECUTION_OK" for x in outcomes),
            "expectedRejections": sum(x["status"] == "EXPECTED_CAPABILITY_REJECTION" for x in outcomes),
            "unexpectedFailures": sum(x["status"] == "NOT_ACCEPTED" for x in outcomes),
            "serverShutdownOk": server_shutdown_ok,
            "completed": len(outcomes), "planned": len(jobs), "results": outcomes,
            "qualityGroundTruth": "NOT_MEASURED",
            "warning": "No per-page ground truth. Structural/accuracy rankings are unsupported.",
        }
        write_atomic(report_path, summary)
    return summary


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--include-models", action="store_true", help="Legacy alias for --suite all")
    ap.add_argument("--suite", choices=SUITES, default="native",
                    help="Select native, mineru-flash, docling-ocr, or all; native remains default")
    ap.add_argument("--models-ready", action="store_true",
                    help="Confirm selected pinned model runtime and weights were independently verified")
    ap.add_argument("--offline-confirmed", action="store_true",
                    help="Confirm host outbound network is blocked during model run (not enforced by this switch)")
    ap.add_argument("--data-root", type=Path, default=Path(os.environ.get("BENCH_DATA_ROOT", r"D:\ai-cognitive-pdf-benchmark-data")))
    ap.add_argument("--npx", default="npx.cmd")
    args = ap.parse_args()
    cli = Path(__file__).resolve().parents[1] / "src" / "cli.ts"
    result = run(args.data_root, include_models=args.include_models, models_ready=args.models_ready,
                 cli=cli, npx=args.npx, suite=args.suite, offline_confirmed=args.offline_confirmed)
    print(json.dumps({"status": result["status"], "completed": result["completed"],
                      "planned": result["planned"]}, ensure_ascii=False))
    if result["status"] not in ("EXECUTION_PASS_ONLY", "BASELINE_COMPLETE_WITH_EXPECTED_REJECTIONS"):
        sys.exit(1)


if __name__ == "__main__":
    main()
