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
    return {"id": target, "expectedSha256": expected_sha, "parentSha256": source_sha, "sourcePages1Based": pages}


def selected_matrix(include_models: bool, models_ready: bool) -> tuple[tuple[str, str, str], ...]:
    if include_models and not models_ready:
        raise ValueError("MODEL_READINESS_CONFIRMATION_REQUIRED")
    return NATIVE + MODELS if include_models else NATIVE


def evidence_row(job: tuple[str, str, str], cp: subprocess.CompletedProcess[str], seconds: float, fixture: dict) -> dict:
    parser, mode, target = job
    try:
        payload = json.loads(cp.stdout)
    except (ValueError, TypeError):
        payload = {}
    rel = payload.get("reliability") if isinstance(payload, dict) else None
    rel = rel if isinstance(rel, dict) else {}
    extraction = payload.get("extraction") if isinstance(payload, dict) else None
    extraction = extraction if isinstance(extraction, dict) else {}
    document = payload.get("document") if isinstance(payload, dict) else None
    document = document if isinstance(document, dict) else {}
    run = payload.get("run") if isinstance(payload, dict) else None
    run = run if isinstance(run, dict) else {}
    reported_status = payload.get("status") if isinstance(payload, dict) else None
    ok = (cp.returncode == 0 and document.get("inputSha256") == fixture["expectedSha256"]
          and rel.get("exitCode") == 0 and not any(rel.get(x) for x in ("crashed", "timeout", "partialOutput", "oom")))
    return {
        "fixtureId": target, "parser": parser, "mode": mode,
        "subsetSha256": fixture["expectedSha256"], "parentSha256": fixture["parentSha256"],
        "sourcePages1Based": fixture["sourcePages1Based"], "status": "OK" if ok else "NOT_ACCEPTED",
        "reportedStatus": reported_status if isinstance(reported_status, str) else None,
        "exitCode": cp.returncode, "runId": run.get("id"), "runtimeSeconds": round(seconds, 2),
        "extractedPages": extraction.get("extractedPages") if ok else None,
        "characters": extraction.get("characters") if ok else None,
        "reasonCode": "NONE" if ok else ("CLI_NONZERO" if cp.returncode else "MISSING_OR_CONFLICTING_EVIDENCE"),
    }


def write_atomic(path: Path, payload: dict) -> None:
    part = path.with_suffix(".json.part")
    with part.open("x", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(part, path)


def run(data_root: Path, *, include_models: bool, models_ready: bool, cli: Path, npx: str) -> dict:
    jobs = selected_matrix(include_models, models_ready)
    if os.name != "nt":
        raise RuntimeError("WINDOWS_HOST_REQUIRED")
    if data_root.is_symlink() or not data_root.is_dir():
        raise ValueError("PRIVATE_DATA_ROOT_NOT_READY")
    if data_root.resolve().is_relative_to(cli.resolve().parents[3]):
        raise ValueError("PRIVATE_DATA_ROOT_INSIDE_REPO")
    fixture_rows = {fixture: manifest_fixture(data_root, fixture) for _, _, fixture in jobs}
    if not cli.is_file():
        raise ValueError("BENCHMARK_CLI_NOT_FOUND")
    if include_models:
        # Opt-in plus installed executables and model-data root. It is not
        # sufficient to infer a model revision, OCR accuracy or zero downloads.
        for exe in (
            data_root / "python" / "docling" / "Scripts" / "python.exe",
            data_root / "python" / "mineru" / "Scripts" / "mineru.exe",
        ):
            if exe.is_symlink() or not exe.is_file():
                raise ValueError("MODEL_EXECUTABLE_NOT_READY")
        if not (data_root / "models").is_dir():
            raise ValueError("MODEL_CACHE_NOT_READY")
    runner = shutil.which(npx)
    if runner is None:
        raise ValueError("NPX_NOT_FOUND")
    report_dir = data_root / "reports"
    if report_dir.is_symlink() or not report_dir.is_dir():
        raise ValueError("PRIVATE_REPORT_DIR_NOT_READY")
    # A separate non-overwriting report per run; never overwrite earlier evidence.
    label = "models" if include_models else "native"
    report_path = report_dir / f"real-book-matrix-{label}-{time.time_ns()}.json"
    if report_path.exists() or report_path.is_symlink():
        raise FileExistsError(f"PRIVATE_REPORT_COLLISION: {report_path}")
    outcomes = []
    server_started = False
    try:
        for job in jobs:
            parser, mode, fixture_id = job
            if parser == "mineru" and not server_started:
                command = [runner, "--no-install", "tsx", str(cli), "mineru-server", "--action", "start"]
                start = subprocess.run(command, cwd=cli.parent.parent, capture_output=True, text=True, timeout=240)
                if start.returncode != 0:
                    raise RuntimeError("MINERU_SERVER_START_FAILED")
                server_started = True
            command = [runner, "--no-install", "tsx", str(cli), "run", "--parser", parser,
                       "--mode", mode, "--fixture", fixture_id, "--cold-only"]
            begun = time.monotonic()
            proc = subprocess.run(command, cwd=cli.parent.parent, capture_output=True, text=True,
                                  timeout=1800 if parser in ("docling", "mineru") else 300)
            item = evidence_row(job, proc, time.monotonic() - begun, fixture_rows[fixture_id])
            outcomes.append(item)
            print(json.dumps({"fixture": fixture_id, "parser": parser, "mode": mode, "status": item["status"],
                              "runtimeSeconds": item["runtimeSeconds"]}, ensure_ascii=False), flush=True)
            # Fail closed: do not consume more RAM / GPU or pretend a later success
            # makes a missing or failed case pass.
            if item["status"] != "OK":
                break
    finally:
        if server_started:
            subprocess.run([runner, "--no-install", "tsx", str(cli), "mineru-server",
                            "--action", "stop"], cwd=cli.parent.parent,
                           capture_output=True, text=True, timeout=240, check=False)
        summary = {
            "schema": "acs-real-book-model-comparison-v1",
            "status": "EXECUTION_PASS_ONLY" if len(outcomes) == len(jobs) and all(x["status"] == "OK" for x in outcomes) else "INCOMPLETE_OR_FAILED",
            "completed": len(outcomes), "planned": len(jobs), "results": outcomes,
            "qualityGroundTruth": "NOT_MEASURED",
            "warning": "No per-page ground truth. Structural/accuracy rankings are unsupported.",
        }
        write_atomic(report_path, summary)
    return summary


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--include-models", action="store_true")
    ap.add_argument("--models-ready", action="store_true", help="Explicitly confirm installed offline model files; no downloads")
    ap.add_argument("--data-root", type=Path, default=Path(os.environ.get("BENCH_DATA_ROOT", r"D:\ai-cognitive-pdf-benchmark-data")))
    ap.add_argument("--npx", default="npx.cmd")
    args = ap.parse_args()
    cli = Path(__file__).resolve().parents[1] / "src" / "cli.ts"
    result = run(args.data_root, include_models=args.include_models, models_ready=args.models_ready, cli=cli, npx=args.npx)
    print(json.dumps({"status": result["status"], "completed": result["completed"],
                      "planned": result["planned"]}, ensure_ascii=False))
    if result["status"] != "EXECUTION_PASS_ONLY":
        sys.exit(1)


if __name__ == "__main__":
    main()
