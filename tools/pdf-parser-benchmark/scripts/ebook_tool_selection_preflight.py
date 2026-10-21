#!/usr/bin/env python3
"""Read-only Windows corpus/model preflight; emits counts only, never book names or bytes."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import zipfile

MAX_BYTES = 200 * 1024 * 1024
PACKAGES = ("fitz", "pypdf", "pdfplumber", "bs4", "lxml", "docling",
            "marker", "surya", "paddleocr", "mineru", "torch")


def hash_stream(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        h.update(chunk)
    return h.hexdigest()


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--root", required=True)
    cli.add_argument("--manifest", required=True)
    args = cli.parse_args()
    root = Path(args.root)
    manifest = json.loads(Path(args.manifest).read_text("utf-8"))
    expected = {f["sha256"]: f["id"] for f in manifest["sources"]}
    found = set()
    scanned = 0
    skipped = 0
    if root.is_dir():
        for item in root.rglob("*"):
            if not item.is_file() or item.is_symlink():
                continue
            if item.suffix.lower() in (".pdf", ".epub"):
                if item.stat().st_size > MAX_BYTES:
                    skipped += 1
                    continue
                with item.open("rb") as fp:
                    digest = hash_stream(fp)
                scanned += 1
                if digest in expected:
                    found.add(expected[digest])
            elif item.suffix.lower() == ".zip":
                try:
                    with zipfile.ZipFile(item) as z:
                        for member in z.infolist():
                            if member.is_dir() or member.file_size > MAX_BYTES:
                                continue
                            if Path(member.filename).suffix.lower() not in (".pdf", ".epub"):
                                continue
                            with z.open(member) as fp:
                                digest = hash_stream(fp)
                            scanned += 1
                            if digest in expected:
                                found.add(expected[digest])
                except (OSError, zipfile.BadZipFile):
                    skipped += 1
    print("ACS_BENCHMARK_ROOT_PRESENT=" + str(root.is_dir()).lower())
    print("ACS_BENCHMARK_FILE_CANDIDATES_CHECKED=" + str(scanned))
    print("ACS_BENCHMARK_CORPUS_SHA_MATCHED=" + str(len(found)))
    print("ACS_BENCHMARK_CORPUS_SHA_EXPECTED=" + str(len(expected)))
    print("ACS_BENCHMARK_CORPUS_SKIPPED=" + str(skipped))
    for package in PACKAGES:
        print("ACS_BENCHMARK_PACKAGE_" + package.upper() + "=" +
              ("PRESENT" if importlib.util.find_spec(package) else "ABSENT"))
    # Absence is not CI success for a full evaluation; this script is preflight only.


if __name__ == "__main__":
    main()
