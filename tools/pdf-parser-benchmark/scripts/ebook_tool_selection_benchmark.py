#!/usr/bin/env python3
"""Offline, metadata-only PDF/EPUB tool baseline. Do not export book text."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import zipfile
import xml.etree.ElementTree as ET

MAX_FILE_BYTES = 200 * 1024 * 1024


def corpus_members(archive=None, directory=None):
    if archive:
        with zipfile.ZipFile(archive) as z:
            for member in z.infolist():
                if member.is_dir() or member.file_size > MAX_FILE_BYTES:
                    continue
                yield z.read(member)
    else:
        for path in Path(directory).rglob("*"):
            if path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_FILE_BYTES:
                yield path.read_bytes()


def metrics(book_id, page, engine, start, content=None, extra=None, failure=None):
    item = {"book_id": book_id, "physical_page": page, "engine": engine,
            "wall_ms": round((time.perf_counter() - start) * 1000, 2)}
    if content is not None:
        compact = re.sub(r"\\s+", "", content)
        item["character_count"] = len(compact)
        item["cjk_count"] = len(re.findall(r"[\\u4e00-\\u9fff]", compact))
        item["output_sha256"] = hashlib.sha256(content.encode("utf-8")).hexdigest()
    if extra:
        item.update(extra)
    if failure:
        item["failure"] = str(failure)[:150]
    return item


def pdf_benchmark(book, raw, skip_ocr=False):
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("PyMuPDF is required for PDF benchmark") from exc
    doc = fitz.open(stream=raw, filetype="pdf")
    if len(doc) != book["total_physical_pages"]:
        raise ValueError(f'{book["id"]}: changed physical page count')
    results = []
    for physical in book["selected_physical_pages"]:
        if not 1 <= physical <= len(doc):
            raise ValueError(f'{book["id"]}: page out of range')
        page = doc[physical - 1]
        part = fitz.open()
        part.insert_pdf(doc, from_page=physical - 1, to_page=physical - 1)
        payload = part.tobytes()
        part.close()
        t = time.perf_counter()
        results.append(metrics(book["id"], physical, "PyMuPDF", t,
                               content=page.get_text("text", sort=True)))
        for engine in ("pypdf", "pdfplumber", "poppler_layout"):
            t = time.perf_counter()
            try:
                if engine == "pypdf":
                    from pypdf import PdfReader
                    content = PdfReader(io.BytesIO(payload)).pages[0].extract_text() or ""
                elif engine == "pdfplumber":
                    import pdfplumber
                    with pdfplumber.open(io.BytesIO(payload)) as opened:
                        content = opened.pages[0].extract_text() or ""
                else:
                    if not shutil.which("pdftotext"):
                        raise RuntimeError("NOT_INSTALLED: pdftotext")
                    done = subprocess.run(["pdftotext", "-layout", "-", "-"], input=payload,
                                          capture_output=True, timeout=30, check=True)
                    content = done.stdout.decode("utf-8", errors="replace")
                results.append(metrics(book["id"], physical, engine, t, content=content))
            except Exception as exc:
                results.append(metrics(book["id"], physical, engine, t, failure=exc))
        if not skip_ocr and physical in book["ocr_physical_pages"]:
            t = time.perf_counter()
            try:
                if not shutil.which("tesseract"):
                    raise RuntimeError("NOT_INSTALLED: tesseract")
                pix = page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6), colorspace=fitz.csRGB, alpha=False)
                done = subprocess.run(["tesseract", "stdin", "stdout", "-l", "chi_sim+eng", "--psm", "3"],
                                      input=pix.tobytes("png"), capture_output=True, timeout=90, check=True)
                results.append(metrics(book["id"], physical, "Tesseract_5_chi_sim+eng", t,
                                       content=done.stdout.decode("utf-8", errors="replace")))
            except Exception as exc:
                results.append(metrics(book["id"], physical, "Tesseract_5_chi_sim+eng", t, failure=exc))
    doc.close()
    return results


def epub_benchmark(book, raw):
    from urllib.parse import unquote
    from bs4 import BeautifulSoup
    t = time.perf_counter()
    with zipfile.ZipFile(io.BytesIO(raw)) as epub:
        filenames = set(epub.namelist())
        opfs = [name for name in filenames if name.lower().endswith(".opf")]
        if len(opfs) != 1:
            raise ValueError(f'{book["id"]}: expected one OPF, got {len(opfs)}')
        opf = opfs[0]
        root = ET.fromstring(epub.read(opf))
        ns = {"p": "http://www.idpf.org/2007/opf"}
        items = {i.attrib["id"]: i.attrib for i in root.findall(".//p:manifest/p:item", ns)}
        spine = [s.attrib.get("idref") for s in root.findall(".//p:spine/p:itemref", ns)]
        html_count = 0
        chars = 0
        image_refs = 0
        missing = 0
        for item_id in spine:
            href = items.get(item_id, {}).get("href")
            if not href:
                missing += 1
                continue
            path = os.path.normpath(os.path.join(os.path.dirname(opf), unquote(href).split("#")[0])).replace("\\\\", "/")
            if path not in filenames:
                missing += 1
                continue
            if not path.lower().endswith((".html", ".htm", ".xhtml")):
                continue
            soup = BeautifulSoup(epub.read(path), "lxml")
            for tag in soup(["style", "script"]):
                tag.decompose()
            chars += len(re.sub(r"\\s+", "", soup.get_text(" ", strip=True)))
            image_refs += len(soup.find_all(["img", "image"]))
            html_count += 1
    return [metrics(book["id"], None, "EPUB_OPF_spine+lxml", t,
                    extra={"spine_entries": len(spine), "html_in_spine": html_count,
                           "spine_missing_targets": missing, "nonspace_chars": chars,
                           "image_references": image_refs})]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--archive", help="Private ZIP path; read in memory without extracting")
    inputs.add_argument("--directory", help="Private folder containing original electronic books")
    parser.add_argument("--manifest", required=True, help="Public SHA-256 selection manifest")
    parser.add_argument("--output", required=True, help="Write ONLY metadata JSON into a private directory")
    parser.add_argument("--skip-ocr", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text("utf-8"))
    if manifest.get("schema_version") != 1:
        raise ValueError("unsupported manifest")
    index = {}
    for raw in corpus_members(args.archive, args.directory):
        digest = hashlib.sha256(raw).hexdigest()
        index[digest] = raw
    results = []
    matched = []
    for book in manifest["sources"]:
        raw = index.get(book["sha256"])
        if raw is None:
            raise FileNotFoundError(f'fixture {book["id"]}: expected SHA-256 missing')
        if len(raw) != book["size"]:
            raise ValueError(f'fixture {book["id"]}: size mismatch')
        matched.append(book["id"])
        if book["format"] == "pdf":
            results.extend(pdf_benchmark(book, raw, args.skip_ocr))
        elif book["format"] == "epub":
            results.extend(epub_benchmark(book, raw))
        else:
            raise ValueError("format is not within the PDF/EPUB evaluation scope")
    record = {"schema_version": 1, "corpus_id": manifest["corpus_id"],
              "status": "EXECUTED_BASELINE_NOT_ACCURACY_EVALUATION",
              "matched_book_ids": matched, "records": results}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")
    print(f"Matched {len(matched)} documents, {len(results)} engine runs; metadata only.")


if __name__ == "__main__":
    main()
