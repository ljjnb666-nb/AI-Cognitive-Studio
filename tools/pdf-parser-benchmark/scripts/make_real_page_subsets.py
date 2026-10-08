"""Prepare a deterministic, private PDF *page-subset* benchmark corpus.

This tool never sends or commits book content. Requirements: Python >=3.10,
pypdf==5.9.0. First import the original private PDF fixtures with the 01A
importer. Then run:
  python scripts/make_real_page_subsets.py --dry-run
  python scripts/make_real_page_subsets.py --include RB-PDF-11,RB-PDF-12,RB-PDF-13

Sample labels 11–13 map to original source page numbers, not PDF printed labels.
No OCR or quality score is inferred from a successful subset generation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path

from pypdf import PdfReader, PdfWriter

MAX_SOURCE_BYTES = 170 * 1024 * 1024
PLANS = {
    "RB-PDF-11": ("RB-PDF-01", (22, 107, 192)),
    "RB-PDF-12": ("RB-PDF-02", (73, 145, 261)),
    "RB-PDF-13": ("RB-PDF-03", (51, 127, 379)),
}
HASH = re.compile(r"^[0-9a-f]{64}$")


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while data := f.read(1024 * 1024):
            digest.update(data)
    return digest.hexdigest()


def regular(path: Path, label: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{label}_NOT_REGULAR_FILE")


def load_manifest(root: Path) -> tuple[Path, dict, dict]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("PRIVATE_ROOT_INVALID")
    here = Path(__file__).resolve()
    checkout = here.parents[3]
    if root.resolve().is_relative_to(checkout):
        raise ValueError("PRIVATE_ROOT_IN_CHECKOUT")
    manifest_path = root / "fixtures.manifest.json"
    regular(manifest_path, "MANIFEST")
    obj = json.loads(manifest_path.read_text("utf-8"))
    if not isinstance(obj, dict) or not isinstance(obj.get("fixtures"), list):
        raise ValueError("MANIFEST_SCHEMA_INVALID")
    by_id = {}
    for row in obj["fixtures"]:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or row["id"] in by_id:
            raise ValueError("MANIFEST_DUPLICATE_OR_INVALID")
        by_id[row["id"]] = row
    return manifest_path, obj, by_id


def validate_source(root: Path, source_id: str, expected: dict) -> tuple[Path, str, int]:
    if expected.get("filename") != f"{source_id}.pdf":
        raise ValueError("SOURCE_FILENAME_INVALID")
    sha = expected.get("expectedSha256")
    size = expected.get("declaredBytes")
    if not isinstance(sha, str) or not HASH.fullmatch(sha) or type(size) is not int or not 0 < size <= MAX_SOURCE_BYTES:
        raise ValueError("SOURCE_IDENTITY_MISSING")
    path = root / expected["filename"]
    regular(path, "SOURCE")
    if path.stat().st_size != size or file_hash(path) != sha:
        raise ValueError(f"SOURCE_IDENTITY_MISMATCH:{source_id}")
    return path, sha, size


def make_entry(target: str, source_id: str, source_sha: str, pages: tuple[int, ...], pdf_path: Path) -> dict:
    return {
        "id": target,
        "filename": f"{target}.pdf",
        "fixtureClass": "private-real-page-subset",
        "generator": "scripts/make_real_page_subsets.py (private; pypdf 5.9.0)",
        "declaredPages": len(pages),
        "declaredBytes": pdf_path.stat().st_size,
        "expectedSha256": file_hash(pdf_path),
        "groundTruth": None,
        "sourceFixtureId": source_id,
        "sourceSha256": source_sha,
        "sourcePages1Based": list(pages),
        "notes": "Nonconsecutive physical source pages; zero-based parser page indexes are subset-local",
    }


def run(root: Path, targets: list[str], dry_run: bool = False) -> dict:
    if not targets or len(targets) != len(set(targets)) or any(t not in PLANS for t in targets):
        raise ValueError("INVALID_TARGET_SET")
    manifest_path, manifest, known = load_manifest(root)
    resolved = []
    for target in targets:
        source_id, pages = PLANS[target]
        row = known.get(source_id)
        if not row:
            raise ValueError(f"SOURCE_NOT_REGISTERED:{source_id}")
        path, sha, _ = validate_source(root, source_id, row)
        with path.open("rb") as f:
            reader = PdfReader(f, strict=False)
            if reader.is_encrypted:
                raise ValueError("SOURCE_ENCRYPTED")
            count = len(reader.pages)
        if row.get("declaredPages") != count or any(p < 1 or p > count for p in pages):
            raise ValueError(f"SOURCE_PAGE_RANGE_MISMATCH:{source_id}")
        dest = root / f"{target}.pdf"
        if dest.is_symlink() or (dest.exists() and not dest.is_file()):
            raise ValueError("TARGET_PATH_UNSAFE")
        if (target in known) != dest.exists():
            raise ValueError(f"SUBSET_MANIFEST_FILE_DRIFT:{target}")
        if target in known:
            previous = known[target]
            if (previous.get("sourceFixtureId") != source_id or previous.get("sourceSha256") != sha
                    or previous.get("sourcePages1Based") != list(pages)
                    or not HASH.fullmatch(previous.get("expectedSha256", ""))
                    or previous.get("declaredBytes") != dest.stat().st_size
                    or file_hash(dest) != previous["expectedSha256"]):
                raise ValueError(f"EXISTING_SUBSET_CONFLICT:{target}")
        resolved.append((target, source_id, pages, path, sha, dest))
    if dry_run:
        return {"status": "DRY_RUN_PASS", "sourcesChecked": len(resolved), "created": 0}

    lock = root / ".real-subset.lock"
    with lock.open("x", encoding="utf-8") as f:
        f.write("subsets in progress; review before clearing a stale lock\n")
    created: list[Path] = []
    partials: list[Path] = []
    manifest_partial_created = False
    try:
        additions = []
        for target, source_id, pages, source_path, sha, dest in resolved:
            if target in known:
                continue
            part = root / f"{target}.pdf.part"
            with part.open("xb") as sink, source_path.open("rb") as source:
                partials.append(part)
                reader = PdfReader(source, strict=False)
                writer = PdfWriter()
                for source_page in pages:
                    writer.add_page(reader.pages[source_page - 1])
                writer.write(sink)
                sink.flush()
                os.fsync(sink.fileno())
            # Re-verify the original source after the lazy PDF reader finishes.
            # Otherwise a source swapped between preflight and extraction would
            # produce a sample falsely attributed to the old SHA-256.
            if file_hash(source_path) != sha:
                raise ValueError(f"SOURCE_CHANGED_DURING_SUBSET:{source_id}")
            entry = make_entry(target, source_id, sha, pages, part)
            # Hard link: same-volume no-clobber publish, never replace a source
            # or a previously registered target. Track rollback immediately.
            os.link(part, dest)
            created.append(dest)
            part.unlink()
            additions.append(entry)
        if additions:
            part_manifest = root / "fixtures.manifest.json.part"
            with part_manifest.open("x", encoding="utf-8") as f:
                manifest_partial_created = True
                json.dump({**manifest, "fixtures": [*manifest["fixtures"], *additions]}, f, indent=2, ensure_ascii=False)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(part_manifest, manifest_path)
        return {"status": "PRIVATE_SUBSETS_READY", "sourcesChecked": len(resolved), "created": len(created),
                "manifestAdditions": len(additions)}
    except BaseException:
        for path in created:
            path.unlink(missing_ok=True)
        raise
    finally:
        for part in partials:
            if part.exists() and not part.is_symlink():
                part.unlink()
        manifest_part = root / "fixtures.manifest.json.part"
        if manifest_partial_created and manifest_part.exists() and not manifest_part.is_symlink():
            manifest_part.unlink()
        lock.unlink()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    default_root = Path(os.environ.get("BENCH_DATA_ROOT", r"D:\ai-cognitive-pdf-benchmark-data")) / "fixtures"
    ap.add_argument("--root", type=Path, default=default_root)
    ap.add_argument("--include", default=",".join(PLANS))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    print(json.dumps(run(args.root, args.include.split(","), args.dry_run), ensure_ascii=False))


if __name__ == "__main__":
    main()
