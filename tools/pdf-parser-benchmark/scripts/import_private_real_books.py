"""Register private real PDF fixtures outside Git (Python 3.10+; stdlib only).

Usage:
  python scripts/import_private_real_books.py --zip D:\Books\ebooks.zip --selection D:\private\real_book_selection.json --dry-run
  python scripts/import_private_real_books.py --zip D:\Books\ebooks.zip --selection D:\private\real_book_selection.json

Generate the benchmark's synthetic fixtures first (npm run fixtures).
Never commit the private manifest, books, extracted text, or run artifacts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import zipfile
from pathlib import Path

MAX_BOOK_BYTES = 170 * 1024 * 1024
CHUNK = 1024 * 1024
ID_PATTERN = re.compile(r"^RB-PDF-[0-9]{2}$")
SHA_PATTERN = re.compile(r"^[0-9a-f]{64}$")
PRIORITY = {"P0": 0, "P1": 1, "P2": 2}


def checked_file(path: Path, label: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{label}_NOT_REGULAR_FILE: {path}")


def digest_stream(source, dest=None) -> tuple[str, int]:
    sha = hashlib.sha256()
    length = 0
    while chunk := source.read(CHUNK):
        length += len(chunk)
        if length > MAX_BOOK_BYTES:
            raise ValueError("PDF_EXCEEDS_MAX_BYTES")
        sha.update(chunk)
        if dest is not None:
            dest.write(chunk)
    return sha.hexdigest(), length


def entry_for(sample: dict) -> dict:
    return {
        "id": sample["id"],
        "filename": sample["id"] + ".pdf",
        "fixtureClass": "private-real-book",
        "generator": "private-local-user-supplied (not for redistribution)",
        "declaredPages": sample["pages"],
        "declaredBytes": sample["bytes"],
        "expectedSha256": sample["sha256"],
        "groundTruth": None,
        "notes": "private benchmark; independent ground truth not yet annotated",
    }


def validate_samples(raw: dict, tier: str) -> list[dict]:
    if not isinstance(raw, dict) or raw.get("schema_version") != "acs-real-book-fixtures-v1" or not isinstance(raw.get("selection"), list):
        raise ValueError("SELECTION_SCHEMA_INVALID")
    chosen: list[dict] = []
    ids: set[str] = set()
    for sample in raw["selection"]:
        if not isinstance(sample, dict) or sample.get("format") != "pdf":
            continue
        sample_id = sample.get("id")
        if not isinstance(sample_id, str) or not ID_PATTERN.fullmatch(sample_id) or sample_id in ids:
            raise ValueError("SELECTION_ID_INVALID_OR_DUPLICATE")
        ids.add(sample_id)
        if sample.get("priority") not in PRIORITY:
            raise ValueError("SELECTION_PRIORITY_INVALID")
        if PRIORITY[sample["priority"]] > PRIORITY[tier]:
            continue
        member = sample.get("archive_member")
        if not isinstance(member, str) or not member.lower().endswith(".pdf") or not member or "\0" in member or "\\" in member or any(p in ("", ".", "..") for p in member.split("/")):
            raise ValueError("ARCHIVE_MEMBER_PATH_INVALID")
        if not isinstance(sample.get("sha256"), str) or not SHA_PATTERN.fullmatch(sample["sha256"]):
            raise ValueError("SELECTION_SHA256_INVALID")
        if type(sample.get("bytes")) is not int or not 0 < sample["bytes"] <= MAX_BOOK_BYTES:
            raise ValueError("SELECTION_BYTES_INVALID")
        if type(sample.get("pages")) is not int or not 1 <= sample["pages"] <= 5000:
            raise ValueError("SELECTION_PAGES_INVALID")
        chosen.append(sample)
    if not chosen:
        raise ValueError("NO_PDF_SAMPLES_SELECTED")
    return chosen


def run(archive: Path, selection: Path, fixtures_root: Path, tier: str, dry_run: bool) -> dict:
    checked_file(archive, "SOURCE_ARCHIVE")
    checked_file(selection, "PRIVATE_SELECTION")
    samples = validate_samples(json.loads(selection.read_text(encoding="utf-8")), tier)
    # Only install into an EXISTING private benchmark root; never create an
    # arbitrary destination or rewrite the committed synthetic manifest.
    if fixtures_root.is_symlink() or not fixtures_root.is_dir():
        raise ValueError("PRIVATE_FIXTURE_ROOT_MISSING_OR_SYMLINK")
    here = Path(__file__).resolve()
    if here.parent.name == "scripts" and here.parent.parent.name == "pdf-parser-benchmark":
        checkout_root = here.parents[3]
        if fixtures_root.resolve().is_relative_to(checkout_root):
            raise ValueError("PRIVATE_FIXTURE_ROOT_INSIDE_GIT_CHECKOUT")
    manifest_path = fixtures_root / "fixtures.manifest.json"
    checked_file(manifest_path, "FIXTURE_MANIFEST")
    existing = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(existing, dict) or not isinstance(existing.get("fixtures"), list):
        raise ValueError("FIXTURE_MANIFEST_INVALID")
    known = {}
    for item in existing["fixtures"]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or item["id"] in known:
            raise ValueError("FIXTURE_MANIFEST_DUPLICATE_OR_INVALID")
        known[item["id"]] = item
    for sample in samples:
        entry = entry_for(sample)
        if sample["id"] in known and known[sample["id"]] != entry:
            raise ValueError(f"FIXTURE_ID_CONFLICT:{sample['id']}")
        dest = fixtures_root / entry["filename"]
        if dest.is_symlink() or (dest.exists() and not dest.is_file()):
            raise ValueError(f"FIXTURE_PATH_UNSAFE:{sample['id']}")

    # Validate every archive member, including complete SHA-256 in dry run,
    # before writing any fixture or manifest.
    with zipfile.ZipFile(archive) as z:
        for sample in samples:
            info = z.getinfo(sample["archive_member"])
            if info.is_dir() or (info.flag_bits & 1) or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError(f"ZIP_MEMBER_UNSAFE:{sample['id']}")
            if info.file_size != sample["bytes"] or info.file_size > MAX_BOOK_BYTES:
                raise ValueError(f"ZIP_SIZE_MISMATCH:{sample['id']}")
            if info.compress_size == 0 or info.file_size > max(1, info.compress_size) * 1000:
                raise ValueError(f"ZIP_COMPRESSION_LIMIT:{sample['id']}")
            with z.open(info) as source:
                sha, n = digest_stream(source)
            if sha != sample["sha256"] or n != sample["bytes"]:
                raise ValueError(f"ZIP_SHA256_MISMATCH:{sample['id']}")
            print(f"VERIFIED {sample['id']} {n} bytes")
        if dry_run:
            return {"status": "DRY_RUN_PASS", "verified": len(samples), "installed": 0}

        # Reserve one atomic manifest update; a stale lock needs operator review.
        lock = fixtures_root / ".real-book-import.lock"
        with lock.open("x", encoding="utf-8") as f:
            f.write("private benchmark import; do not delete while running\n")
        created: list[Path] = []
        partials_created: list[Path] = []
        manifest_partial_created = False
        try:
            for sample in samples:
                dest = fixtures_root / (sample["id"] + ".pdf")
                if dest.exists():
                    checked_file(dest, "FIXTURE_DESTINATION")
                    with dest.open("rb") as src:
                        sha, n = digest_stream(src)
                    if sha != sample["sha256"] or n != sample["bytes"]:
                        raise ValueError(f"EXISTING_FIXTURE_CHANGED:{sample['id']}")
                    continue
                part = fixtures_root / (sample["id"] + ".pdf.part")
                with z.open(sample["archive_member"]) as src, part.open("xb") as dst:
                    partials_created.append(part)
                    sha, n = digest_stream(src, dst)
                if sha != sample["sha256"] or n != sample["bytes"]:
                    raise ValueError(f"COPY_SHA256_MISMATCH:{sample['id']}")
                # Same-volume atomic no-clobber: never overwrite an existing file.
                os.link(part, dest)
                # Once the destination exists, rollback owns it even if
                # removing the staging link fails unexpectedly.
                created.append(dest)
                part.unlink()
            additions = [entry_for(sample) for sample in samples if sample["id"] not in known]
            if additions:
                part_manifest = fixtures_root / "fixtures.manifest.json.part"
                with part_manifest.open("x", encoding="utf-8") as f:
                    manifest_partial_created = True
                    json.dump({**existing, "fixtures": [*existing["fixtures"], *additions]}, f, ensure_ascii=False, indent=2)
                    f.write("\n")
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(part_manifest, manifest_path)
            return {"status": "PRIVATE_FIXTURES_READY", "verified": len(samples), "installed": len(created), "manifest_additions": len(additions)}
        except Exception:
            for dest in created:
                dest.unlink(missing_ok=True)
            raise
        finally:
            # Never remove a pre-existing .part owned by somebody else.
            for part in partials_created:
                if part.exists() and not part.is_symlink():
                    part.unlink()
            temporary_manifest = fixtures_root / "fixtures.manifest.json.part"
            if manifest_partial_created and temporary_manifest.exists() and not temporary_manifest.is_symlink():
                temporary_manifest.unlink()
            lock.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", required=True, type=Path, dest="archive")
    parser.add_argument("--selection", required=True, type=Path)
    default_root = Path(os.environ.get("BENCH_DATA_ROOT", r"D:\ai-cognitive-pdf-benchmark-data")) / "fixtures"
    parser.add_argument("--root", type=Path, default=default_root)
    parser.add_argument("--priority", choices=tuple(PRIORITY), default="P0")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run(args.archive, args.selection, args.root, args.priority, args.dry_run), ensure_ascii=False))


if __name__ == "__main__":
    main()
