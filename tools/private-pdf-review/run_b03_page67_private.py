#!/usr/bin/env python3
"""Single-command B03 physical-page-67 private RapidOCR candidate capture.

Searches the known Windows private root by the *pinned* original PDF bytes,
then invokes the existing local OCR runner. Never prints PDF paths or book
content, never uploads a book or installs model packages.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

HERE = Path(__file__).resolve().parent


def module_from_local(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError("LOCAL_MODULE_UNAVAILABLE")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


identity = module_from_local("acs_b03_one_shot_identity", "verify_b03_source_readonly.py")
runner = module_from_local("acs_b03_one_shot_rapidocr", "run_rapidocr_candidate_offline.py")
comp = runner.comp

SCHEMA = "ACS_B03_PRIVATE_PAGE67_OCR_V1"
OUTPUT_DIR = "private-candidates"
STEM = "rapidocr-B03-p0067"


def ensure_private_root(root: Path) -> Path:
    if not root.is_dir() or identity.unsafe_link_or_reparse(root):
        raise comp.Blocked("PRIVATE_ROOT_INVALID")
    return root.resolve()


def ensure_private_output_dir(root: Path) -> None:
    """Create only the known private output folder, without following a link."""
    output = root / OUTPUT_DIR
    try:
        output.mkdir(mode=0o700, exist_ok=True)
        info = output.lstat()
        if (not stat.S_ISDIR(info.st_mode) or output.is_symlink() or
            identity.unsafe_link_or_reparse(output)):
            raise comp.Blocked("UNSAFE_PRIVATE_OUTPUT")
    except OSError:
        raise comp.Blocked("PRIVATE_OUTPUT_DIRECTORY_INVALID") from None


def execute(root: Path, *, ocr=runner.run_candidate) -> dict:
    root = ensure_private_root(root)
    original = identity.identify_exact_original(root)
    # The verifier insists on exact 151,495,200 bytes and the original full
    # SHA256, rejecting multiple identical books rather than guessing a page.
    relative = original.relative_to(root).as_posix()
    source = {
        "book_id": identity.BOOK_ID,
        "pdf": relative,
        "sha256": identity.EXPECTED_SHA256,
        "size_bytes": identity.EXPECTED_SIZE,
        "page_count": identity.EXPECTED_PAGES,
        "physical_page_1_based": identity.TARGET_PAGE_ONE_BASED,
    }
    # Probe/install/configuration errors must not create an apparently
    # completed output artifact. The runner uses exclusive-create files.
    ensure_private_output_dir(root)
    result = ocr(root, source, OUTPUT_DIR, STEM)
    if result.get("status") != "SUCCEEDED":
        raise comp.Blocked("RAPIDOCR_PAGE_FAILED")
    return {
        "schema": SCHEMA,
        "status": "SUCCEEDED",
        "book_id": "B03",
        "physical_page_1_based": identity.TARGET_PAGE_ONE_BASED,
        "original_source_sha256": "PINNED_AND_REVERIFIED",
        "private_candidate": "CREATED",
        "private_receipt": "LOCAL_UNSIGNED_HASH_BOUND",
        "recognition_quality": "NOT_EVALUATED",
        "official_cer": None,
        "engine_ranking": None,
        "production": "UNVERIFIED",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Privately locate B03 original and OCR its PDF physical page 67"
    )
    parser.add_argument("--root", default=identity.DEFAULT_ROOT,
                        help="Existing private benchmark root; never printed")
    args = parser.parse_args(argv)
    try:
        result = execute(Path(args.root))
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except Exception as error:
        reason = str(error) if (
            isinstance(error, (identity.ReviewBlocked, comp.Blocked))
            and re.fullmatch("[A-Z_0-9]+", str(error))
        ) else "PRIVATE_B03_OCR_BLOCKED"
        print(json.dumps({
            "schema": SCHEMA, "status": "BLOCKED", "reason": reason,
            "official_cer": None, "engine_ranking": None,
            "production": "UNVERIFIED",
        }, sort_keys=True, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    sys.exit(main())
