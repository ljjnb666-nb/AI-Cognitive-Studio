#!/usr/bin/env python3
"""Six SHA-pinned REAL private PDFs: 24 native pages and five OCR sample PNGs.

This is a true multi-book execution baseline, NOT OCR text gold or a ranking.
Original bytes, embedded text and PNGs never leave the user's private D drive.
"""
import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import re
import sys
from ebook_private_native_pages import _raw_sources
from ebook_private_glm_visual_reference import VisualGateError
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant

TARGETS = ("B03", "B08", "B15", "B16", "B29", "B31")
REPORT = "multibook_native_24pages.private.json"
FOLDER = "multibook_matrix_20261023"
MAX_PDF = 200 * 1024 * 1024
MAX_PNG = 4_500_000
MAX_JSON = 150_000
MAX_PIXELS = 4_000_000
EVIDENCE = "SIX_SHA_PINNED_PRIVATE_PDF_NATIVE_AND_OCR_STAGING_NOT_GOLD"


def select_manifest(manifest):
    if (not isinstance(manifest, dict) or
            not isinstance(manifest.get("sources"), list)):
        raise VisualGateError("MATRIX_MANIFEST_INVALID")
    result={}
    for row in manifest["sources"]:
        if not isinstance(row,dict) or row.get("id") not in TARGETS:
            continue
        if row["id"] in result:
            raise VisualGateError("MATRIX_DUPLICATE_BOOK_ID")
        selected,ocr=row.get("selected_physical_pages"),row.get("ocr_physical_pages")
        count=row.get("total_physical_pages")
        if (row.get("format")!="pdf" or
                type(row.get("size")) is not int or not 0<row["size"]<=MAX_PDF or
                type(count) is not int or not 4<=count<=1500 or
                not isinstance(row.get("sha256"),str) or
                not re.fullmatch(r"[0-9a-f]{64}",row["sha256"]) or
                type(selected) is not list or len(selected)!=4 or
                any(type(n) is not int or not 1<=n<=count for n in selected) or
                len(set(selected))!=4 or
                type(ocr) is not list or len(set(ocr))!=len(ocr) or
                any(type(n) is not int or n not in selected for n in ocr) or
                (row["id"]=="B16" and ocr) or
                (row["id"]!="B16" and not ocr)):
            raise VisualGateError("MATRIX_SOURCE_IDENTITY_INVALID")
        result[row["id"]]=row
    if set(result)!=set(TARGETS):
        raise VisualGateError("MATRIX_SOURCE_SET_INCOMPLETE")
    if (manifest.get("corpus_id")=="ACS-EBOOK-20261022-A" and
            sum(len(row["ocr_physical_pages"]) for row in result.values())!=10):
        raise VisualGateError("MATRIX_REAL_CORPUS_OCR_SET_CHANGED")
    return result


def _exclusive(path,content):
    flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
    if hasattr(os,"O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as f:
        f.write(content)


def _private_folder(root):
    root=Path(root)
    if not root.is_dir() or root.is_symlink():
        raise VisualGateError("MATRIX_PRIVATE_ROOT_INVALID")
    parent=root/"semantic_gate"
    if not parent.is_dir() or parent.is_symlink():
        raise VisualGateError("MATRIX_PRIVATE_SEMANTIC_GATE_MISSING")
    output=parent/FOLDER
    if output.is_symlink() or (output.exists() and not output.is_dir()):
        raise VisualGateError("MATRIX_PRIVATE_DIRECTORY_UNSAFE")
    return output


def _native_counts(page):
    # Text is never serialized; counts are not accuracy / semantic gold.
    blocks=page.get_text("blocks", sort=True)
    return {
        "native_char_count":len(page.get_text("text",sort=True).strip()),
        "native_text_blocks":sum(int(len(b)>6 and b[6]==0) for b in blocks),
        "native_image_entries":len(page.get_images(full=True)),
        "native_drawing_paths":len(page.get_drawings()),
        "page_rotation":int(page.rotation),
    }


def _render_png(page, fitz):
    pix=page.get_pixmap(matrix=fitz.Matrix(1.4,1.4),alpha=False,
                        colorspace=fitz.csRGB)
    if pix.width*pix.height>MAX_PIXELS:
        raise VisualGateError("MATRIX_RENDER_PIXELS_EXCEEDED")
    raw=pix.tobytes("png")
    if not 0<len(raw)<=MAX_PNG:
        raise VisualGateError("MATRIX_RENDER_PNG_SIZE_INVALID")
    return raw,(pix.width,pix.height)


def evaluate(root,manifest,fitz,*,write=False):
    entries=select_manifest(manifest)
    folder=_private_folder(root)
    report_path=folder/REPORT
    if report_path.exists() or report_path.is_symlink():
        raise VisualGateError("MATRIX_PREVIOUS_REPORT_EXISTS")
    identities={(v["size"],v["sha256"]):k for k,v in entries.items()}
    rows=[]; images={};observed=set()
    for book,raw in _raw_sources(Path(root),identities):
        if book in observed:
            continue
        expected=entries[book]
        if (len(raw)!=expected["size"] or
                hashlib.sha256(raw).hexdigest()!=expected["sha256"]):
            raise VisualGateError("MATRIX_SOURCE_SHA_CHANGED")
        observed.add(book)
        try:
            with fitz.open(stream=raw,filetype="pdf") as doc:
                if doc.page_count!=expected["total_physical_pages"]:
                    raise VisualGateError("MATRIX_PDF_PAGE_COUNT_CHANGED")
                focus=min(expected["ocr_physical_pages"]) if expected["ocr_physical_pages"] else None
                page_rows=[]
                for physical in expected["selected_physical_pages"]:
                    page=doc[physical-1]
                    item={"physical_page":physical,**_native_counts(page)}
                    if physical==focus:
                        binary,size=_render_png(page,fitz)
                        filename=f"{book}_p{physical:04d}.private.png"
                        if filename in images:
                            raise VisualGateError("MATRIX_STAGING_NAME_COLLISION")
                        images[filename]=binary
                        item["ocr_focus_png"]=filename
                        item["ocr_focus_png_sha256"]=hashlib.sha256(binary).hexdigest()
                        item["ocr_focus_width"],item["ocr_focus_height"]=size
                    page_rows.append(item)
        except VisualGateError:
            raise
        except (ValueError,RuntimeError):
            raise VisualGateError("MATRIX_PDF_SOURCE_DECODE_FAILED") from None
        rows.append({
            "book_id":book,
            "source_document_sha256":expected["sha256"],
            "pages":page_rows,
            "ocr_focus_requested":focus,
        })
        if len(observed)==len(TARGETS):
            break
    if observed!=set(TARGETS):
        raise VisualGateError("MATRIX_PRIVATE_PDF_SOURCES_INCOMPLETE")
    rows.sort(key=lambda r:r["book_id"])
    if sum(len(row["pages"]) for row in rows)!=24 or len(images)!=5:
        raise VisualGateError("MATRIX_PAGE_OR_FOCUS_COUNT_MISMATCH")
    versions={}
    for name in ("docling","mineru","pymupdf"):
        try:
            versions[name]=metadata.version(name)
        except metadata.PackageNotFoundError:
            versions[name]=None
    report={
        "schema_version":1,
        "evidence":EVIDENCE,
        "corpus_id":manifest.get("corpus_id"),
        "pdf_book_count":6,
        "selected_native_pages":24,
        "ocr_focus_image_count":5,
        "rows":rows,
        "installed_versions_in_native_interpreter_only":versions,
        "separate_mineru_runtime_not_probed":True,
        "native_text_is_not_gold":True,
        "ocr_quality_gold":None,
        "layout_quality_gold":None,
        "graph_quality_gold":None,
        "provider_calls":0,
    }
    blob=(json.dumps(report,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
    if len(blob)>MAX_JSON:
        raise VisualGateError("MATRIX_REPORT_TOO_LARGE")
    if write:
        folder.mkdir(exist_ok=True)
        for name,binary in sorted(images.items()):
            _exclusive(folder/name,binary)
        _exclusive(report_path,blob)
    return report


def audit_existing(root,manifest):
    entries=select_manifest(manifest)
    folder=_private_folder(root)
    report_path=folder/REPORT
    if (report_path.is_symlink() or not report_path.is_file() or
            not 0<report_path.stat().st_size<=MAX_JSON):
        raise VisualGateError("MATRIX_RECEIPT_MISSING_OR_UNSAFE")
    try:
        data=json.loads(report_path.read_text("utf-8"),
                        object_pairs_hook=no_duplicate_keys,
                        parse_constant=reject_constant)
    except (ValueError,UnicodeError,TypeError):
        raise VisualGateError("MATRIX_RECEIPT_JSON_INVALID") from None
    if (not isinstance(data,dict) or data.get("schema_version")!=1 or
            data.get("evidence")!=EVIDENCE or
            data.get("corpus_id")!=manifest.get("corpus_id") or
            type(data.get("pdf_book_count")) is not int or data["pdf_book_count"]!=6 or
            type(data.get("selected_native_pages")) is not int or data["selected_native_pages"]!=24 or
            type(data.get("ocr_focus_image_count")) is not int or data["ocr_focus_image_count"]!=5 or
            data.get("provider_calls")!=0 or
            data.get("graph_quality_gold",object()) is not None or
            data.get("ocr_quality_gold",object()) is not None or
            data.get("layout_quality_gold",object()) is not None or
            data.get("native_text_is_not_gold") is not True or
            not isinstance(data.get("rows"),list) or len(data["rows"])!=6):
        raise VisualGateError("MATRIX_RECEIPT_PROVENANCE_INVALID")
    seen=set();focus_count=0
    for row in data["rows"]:
        if not isinstance(row,dict) or row.get("book_id") not in entries or row["book_id"] in seen:
            raise VisualGateError("MATRIX_RECEIPT_BOOK_ID_INVALID")
        seen.add(row["book_id"])
        e=entries[row["book_id"]]
        if (row.get("source_document_sha256")!=e["sha256"] or
                row.get("ocr_focus_requested")!=(
                    min(e["ocr_physical_pages"]) if e["ocr_physical_pages"] else None) or
                not isinstance(row.get("pages"),list) or len(row["pages"])!=4 or
                [p.get("physical_page") for p in row["pages"]] != e["selected_physical_pages"]):
            raise VisualGateError("MATRIX_RECEIPT_PAGE_IDENTITY_INVALID")
        for item in row["pages"]:
            if any(type(item.get(k)) is not int or item[k]<0
                   for k in ("native_char_count","native_text_blocks",
                             "native_image_entries","native_drawing_paths")):
                raise VisualGateError("MATRIX_RECEIPT_NATIVE_COUNTS_INVALID")
            if "ocr_focus_png" in item:
                focus_count+=1
                filename=f"{row['book_id']}_p{item['physical_page']:04d}.private.png"
                p=folder/filename
                if (item["ocr_focus_png"]!=filename or
                        p.is_symlink() or not p.is_file() or
                        not 0<p.stat().st_size<=MAX_PNG or
                        hashlib.sha256(p.read_bytes()).hexdigest()!=item.get("ocr_focus_png_sha256")):
                    raise VisualGateError("MATRIX_RECEIPT_FOCUS_PNG_CORRUPTED")
    if seen!=set(TARGETS) or focus_count!=5:
        raise VisualGateError("MATRIX_RECEIPT_FOCUS_IDENTITY_INVALID")
    return data


def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument("--private-root",required=True)
    p.add_argument("--manifest",required=True)
    x=p.add_mutually_exclusive_group()
    x.add_argument("--write",action="store_true")
    x.add_argument("--audit-only",action="store_true")
    args=p.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    if args.audit_only:
        report=audit_existing(Path(args.private_root),manifest)
    else:
        import fitz
        report=evaluate(Path(args.private_root),manifest,fitz,write=args.write)
    print("ACS_MULTIBOOK_NATIVE_STATUS="+(
        "PRIVATE_WRITTEN" if args.write else
        "PRIVATE_RECEIPT_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_MULTIBOOK_NATIVE_PDF_BOOKS="+str(report["pdf_book_count"]))
    print("ACS_MULTIBOOK_NATIVE_PAGES="+str(report["selected_native_pages"]))
    print("ACS_MULTIBOOK_NATIVE_OCR_FOCUS_PNGS="+str(report["ocr_focus_image_count"]))
    for name,value in report["installed_versions_in_native_interpreter_only"].items():
        print("ACS_MULTIBOOK_NATIVE_INSTALLED_"+name.upper()+"="+(
            "MISSING_IN_THIS_INTERPRETER" if value is None else "PRESENT"))
    print("ACS_MULTIBOOK_NATIVE_GOLD=UNVERIFIED")
    print("ACS_MULTIBOOK_NATIVE_PROVIDER_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,OSError,TypeError,ValueError,ImportError) as err:
        print("ACS_MULTIBOOK_NATIVE_REJECTED="+(
            err.code if isinstance(err,VisualGateError) else type(err).__name__))
        sys.exit(2)
