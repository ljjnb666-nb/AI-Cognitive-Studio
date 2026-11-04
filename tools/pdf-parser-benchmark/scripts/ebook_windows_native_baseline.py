#!/usr/bin/env python3
"""Read-only 27-book PDF/EPUB Windows baseline. Writes private metadata, never body text."""
import argparse
import difflib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import unquote
import xml.etree.ElementTree as ET
import zipfile

MAX_BYTES = 200 * 1024 * 1024


def each_candidate(root):
    for path in Path(root).rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        suffix = path.suffix.lower()
        if suffix in (".pdf", ".epub"):
            if path.stat().st_size <= MAX_BYTES:
                yield path.read_bytes()
        elif suffix == ".zip":
            try:
                with zipfile.ZipFile(path) as src:
                    for item in src.infolist():
                        if (item.is_dir() or item.file_size > MAX_BYTES
                                or Path(item.filename).suffix.lower() not in (".pdf", ".epub")):
                            continue
                        with src.open(item) as stream:
                            payload = stream.read(MAX_BYTES + 1)
                        if len(payload) <= MAX_BYTES:
                            yield payload
            except (OSError, zipfile.BadZipFile):
                continue


def clean(value):
    return "".join(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]+", value)).lower()


def pdf_metrics(book, raw):
    import fitz
    from pypdf import PdfReader
    rows = []
    with fitz.open(stream=raw, filetype="pdf") as source:
        if len(source) != book["total_physical_pages"]:
            raise ValueError(f'{book["id"]}: physical page mismatch')
        for physical in book["selected_physical_pages"]:
            index = physical - 1
            if index < 0 or index >= len(source):
                raise ValueError("page outside source")
            t = time.perf_counter()
            fitz_content = clean(source[index].get_text("text", sort=True))
            fitz_ms = (time.perf_counter() - t) * 1000
            part = fitz.open()
            part.insert_pdf(source, from_page=index, to_page=index)
            single = part.tobytes()
            part.close()
            t = time.perf_counter()
            pypdf_content = clean(PdfReader(io.BytesIO(single)).pages[0].extract_text() or "")
            pypdf_ms = (time.perf_counter() - t) * 1000
            rows.append({
                "physical_page": physical,
                "pymupdf": {"nonspace_characters": len(fitz_content),
                            "wall_ms": round(fitz_ms, 2),
                            "sha256": hashlib.sha256(fitz_content.encode("utf-8")).hexdigest()},
                "pypdf": {"nonspace_characters": len(pypdf_content),
                          "wall_ms": round(pypdf_ms, 2),
                          "sha256": hashlib.sha256(pypdf_content.encode("utf-8")).hexdigest()},
                "normalized_similarity_proxy": round(
                    difflib.SequenceMatcher(None, fitz_content[:4000],
                                            pypdf_content[:4000], autojunk=True).ratio(), 3),
            })
    return {"book_id": book["id"], "format": "pdf",
            "total_pages": book["total_physical_pages"], "pages": rows}


def epub_metrics(book, raw):
    t = time.perf_counter()
    with zipfile.ZipFile(io.BytesIO(raw)) as ebook:
        filenames = set(ebook.namelist())
        opfs = [x for x in filenames if x.lower().endswith(".opf")]
        if len(opfs) != 1:
            raise ValueError(f'{book["id"]}: expected exactly one OPF')
        opf = opfs[0]
        root = ET.fromstring(ebook.read(opf))
        ns = {"p": "http://www.idpf.org/2007/opf"}
        items = {x.attrib["id"]: x.attrib for x in root.findall(".//p:manifest/p:item", ns)}
        spine = [x.attrib.get("idref") for x in root.findall(".//p:spine/p:itemref", ns)]
        missing = 0
        xhtml_count = 0
        for item_id in spine:
            item = items.get(item_id, {})
            href = item.get("href", "").split("#")[0]
            if not href:
                missing += 1
                continue
            local = os.path.normpath(
                os.path.join(os.path.dirname(opf), unquote(href))).replace("\\", "/")
            if local not in filenames:
                missing += 1
            elif local.lower().endswith((".xhtml", ".html", ".htm")):
                xhtml_count += 1
        return {"book_id": book["id"], "format": "epub",
                "spine_items": len(spine), "resolved_html_items": xhtml_count,
                "missing_spine_targets": missing,
                "wall_ms": round((time.perf_counter() - t) * 1000, 2)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1:
        raise ValueError("Unsupported corpus version")
    targets = {item["sha256"]: item for item in manifest["sources"]}
    matches = {}
    for raw in each_candidate(args.root):
        item = targets.get(hashlib.sha256(raw).hexdigest())
        if not item or item["id"] in matches:
            continue
        if len(raw) != item["size"]:
            raise ValueError("Matched SHA but unexpected byte size")
        matches[item["id"]] = pdf_metrics(item, raw) if item["format"] == "pdf" else epub_metrics(item, raw)
    missing = sorted(x["id"] for x in targets.values() if x["id"] not in matches)
    report = {
        "schema_version": 1, "corpus_id": manifest["corpus_id"],
        "evidence_level": "EXECUTED_WINDOWS_NATIVE_BASELINE_NOT_INDEPENDENT_ACCURACY",
        "source_count": len(matches), "missing_book_ids": missing,
        "pdf_pages": sum(len(v["pages"]) for v in matches.values() if v["format"] == "pdf"),
        "engine_runs": sum(2 * len(v["pages"]) if v["format"] == "pdf" else 1
                           for v in matches.values()),
        "errors": 0, "results": [matches[key] for key in sorted(matches)],
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f'ACS_EBOOK_NATIVE_MATCHED={len(matches)}')
    print(f'ACS_EBOOK_NATIVE_PDF_PAGES={report["pdf_pages"]}')
    print(f'ACS_EBOOK_NATIVE_ENGINE_RUNS={report["engine_runs"]}')
    print(f'ACS_EBOOK_NATIVE_MISSING={len(missing)}')
    if missing:
        raise SystemExit("FAIL: Missing book input; benchmark is not complete")


if __name__ == "__main__":
    main()
