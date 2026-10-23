#!/usr/bin/env python3
"""True six-PDF/24-page Docling NATIVE (model-free) baseline.

Inputs are the exact SHA-pinned source books and selected physical pages in
ebook-20261022.manifest.json, NOT a different PDF, OCR text or image.
Docling NativePdfPipeline is intentionally NOT Docling StandardPdfPipeline:
no OCR, layout or table detection model is loaded, so it cannot rank those.
All single-page PDFs and per-page extracted text stay ONLY on private D:.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

from ebook_multibook_native_matrix import (
    TARGETS, select_manifest, _private_folder, audit_existing as audit_native,
)
from ebook_private_native_pages import _raw_sources
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT = "multibook_docling_native_24pages.private.json"
PDF_SUBDIR = "docling_native_single_pages"
EVIDENCE = "SAME_ORIGINAL_24_PAGES_DOCLING_NATIVE_MODEL_FREE_NOT_LAYOUT_GOLD"
MAX_JSON = 180_000
MAX_PDF = 35 * 1024 * 1024
MAX_MARKDOWN_CHARS = 100_000


def _exclusive(path, payload):
    flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as output:
        output.write(payload)


def _single_page_pdf(source_doc, page_index, fitz):
    out=fitz.open()
    try:
        out.insert_pdf(source_doc,from_page=page_index,to_page=page_index)
        blob=out.tobytes(garbage=3,deflate=True)
        if not 100<len(blob)<=MAX_PDF:
            raise VisualGateError("DOCLING_NATIVE_SINGLE_PDF_SIZE_INVALID")
        with fitz.open(stream=blob,filetype="pdf") as check:
            if check.page_count!=1:
                raise VisualGateError("DOCLING_NATIVE_SINGLE_PDF_PAGE_COUNT")
        return blob
    finally:
        out.close()


def build_pages(root,manifest,fitz):
    """Check source SHA AND exact original page index before any write."""
    expected=select_manifest(manifest)
    by_id={(row["size"],row["sha256"]):book for book,row in expected.items()}
    output={}
    rows=[]
    for book,raw in _raw_sources(Path(root),by_id):
        if book in output:
            continue
        row=expected[book]
        if (len(raw)!=row["size"] or
                hashlib.sha256(raw).hexdigest()!=row["sha256"]):
            raise VisualGateError("DOCLING_NATIVE_ORIGINAL_SHA_INVALID")
        pdfs={}
        try:
            with fitz.open(stream=raw,filetype="pdf") as doc:
                if doc.page_count!=row["total_physical_pages"]:
                    raise VisualGateError("DOCLING_NATIVE_SOURCE_PAGE_COUNT_INVALID")
                for page in row["selected_physical_pages"]:
                    name=f"{book}_p{page:04d}.private.pdf"
                    if name in pdfs:
                        raise VisualGateError("DOCLING_NATIVE_DUPLICATE_STAGING_NAME")
                    blob=_single_page_pdf(doc,page-1,fitz)
                    pdfs[name]=blob
                    rows.append({
                        "book_id":book,
                        "physical_page":page,
                        "original_pdf_sha256":row["sha256"],
                        "staged_single_page_pdf":name,
                        "staged_pdf_sha256":hashlib.sha256(blob).hexdigest(),
                    })
        except (RuntimeError,ValueError) as err:
            if isinstance(err,VisualGateError):
                raise
            raise VisualGateError("DOCLING_NATIVE_PDF_DECODE_ERROR") from None
        output[book]=pdfs
    if set(output)!=set(TARGETS) or len(rows)!=24:
        raise VisualGateError("DOCLING_NATIVE_ORIGINAL_24_PAGES_MISSING")
    rows.sort(key=lambda x:(x["book_id"],x["physical_page"]))
    return rows,{name:pdf for pdfs in output.values() for name,pdf in pdfs.items()}


def _real_converter():
    # Explicit model-free pipeline; no auto model download and no cloud.
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import NativePdfPipelineOptions
    from docling.document_converter import DocumentConverter, NativePdfFormatOption
    options=NativePdfPipelineOptions(
        parser_threads=2,
        generate_page_images=False,
        generate_picture_images=False,
        enable_remote_services=False,
        allow_external_plugins=False,
        document_timeout=120.0,
    )
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={InputFormat.PDF:NativePdfFormatOption(pipeline_options=options)},
    )


def _extract(converter,pdf_path):
    t0=time.perf_counter()
    # No use of external API or any provider; stdout/stderr are redirected
    # to private logs by the Windows runner rather than GitHub.
    result=converter.convert(str(pdf_path))
    ms=round((time.perf_counter()-t0)*1000)
    if result.status is None or getattr(result.status,"name",str(result.status))!="SUCCESS":
        raise VisualGateError("DOCLING_NATIVE_CONVERSION_NOT_SUCCESS")
    doc=result.document
    if doc is None:
        raise VisualGateError("DOCLING_NATIVE_DOCUMENT_NULL")
    md=doc.export_to_markdown()
    if not isinstance(md,str) or len(md)>MAX_MARKDOWN_CHARS:
        raise VisualGateError("DOCLING_NATIVE_MARKDOWN_EXCEEDS_BUDGET")
    return {
        "duration_ms":ms,
        "text_item_count":len(doc.texts),
        "picture_item_count":len(doc.pictures),
        "markdown_char_count":len(md),
        "private_markdown_sha256":hashlib.sha256(md.encode("utf-8")).hexdigest(),
        "private_markdown_text":md,
        "pipeline":"DOCLING_NATIVE_MODEL_FREE_NO_OCR_NO_LAYOUT_NO_TABLE_MODELS",
    }


def execute(root,manifest,fitz,*,converter=None,write=False):
    native=audit_native(root,manifest)  # 6 actual PDFs / 24 fixed pages
    folder=_private_folder(root)
    report=folder/REPORT
    sub=folder/PDF_SUBDIR
    if report.exists() or report.is_symlink() or sub.exists() or sub.is_symlink():
        raise VisualGateError("DOCLING_NATIVE_PREVIOUS_OUTPUT_EXISTS")
    stage,source=build_pages(root,manifest,fitz)
    if len(stage)!=native["selected_native_pages"]:
        raise VisualGateError("DOCLING_NATIVE_NOT_SAME_24_PAGES")
    expected_pairs={(r["book_id"],p["physical_page"])
                    for r in native["rows"] for p in r["pages"]}
    actual_pairs={(r["book_id"],r["physical_page"]) for r in stage}
    if expected_pairs!=actual_pairs:
        raise VisualGateError("DOCLING_NATIVE_PAGE_SET_CHANGED")
    if write:
        sub.mkdir(parents=False,exist_ok=False)
        for name,raw in sorted(source.items()):
            _exclusive(sub/name,raw)
        scan_paths={name:sub/name for name in source}
    else:
        # During default dry-run, use a temporary PRIVATE folder inside D:.
        import tempfile
        temp_ctx=tempfile.TemporaryDirectory(prefix="docling_native_",dir=folder)
        tmp=Path(temp_ctx.name)
        try:
            for name,raw in source.items():
                (tmp/name).write_bytes(raw)
            result=_run_all(stage,scan_paths={n:tmp/n for n in source},
                            converter=converter,corpus_id=native["corpus_id"])
        finally:
            temp_ctx.cleanup()
        return result
    result=_run_all(stage,scan_paths=scan_paths,converter=converter,
                    corpus_id=native["corpus_id"])
    blob=(json.dumps(result,ensure_ascii=False,
                     sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
    if len(blob)>MAX_JSON:
        raise VisualGateError("DOCLING_NATIVE_REPORT_TOO_LARGE")
    _exclusive(report,blob)
    return result


def _run_all(stage,scan_paths,converter,corpus_id):
    if converter is None:
        converter=_real_converter()
    allrows=[]
    for row in stage:
        record={**row,**_extract(converter,scan_paths[row["staged_single_page_pdf"]])}
        allrows.append(record)
    if len(allrows)!=24:
        raise VisualGateError("DOCLING_NATIVE_RESULT_COUNT_INCOMPLETE")
    return {
        "schema_version":1,
        "evidence":EVIDENCE,
        "corpus_id":corpus_id,
        "pdf_books":6,
        "native_selected_pages":24,
        "docling_native_completed_pages":24,
        "engine":"Docling NativePdfPipeline",
        "model_free":True,
        "actual_docling_standard_pipeline_tested":False,
        "mineru_tested":False,
        "pages":allrows,
        "layout_quality_gold":None,
        "ocr_quality_gold":None,
        "graph_quality_gold":None,
        "provider_calls":0,
        "model_downloads":0,
    }


def audit_existing(root,manifest):
    native=audit_native(root,manifest)
    folder=_private_folder(root)
    report=folder/REPORT
    sub=folder/PDF_SUBDIR
    if (report.is_symlink() or sub.is_symlink() or not report.is_file() or
            not sub.is_dir() or not 0<report.stat().st_size<=MAX_JSON):
        raise VisualGateError("DOCLING_NATIVE_RECEIPT_MISSING")
    try:
        data=json.loads(report.read_text("utf-8"),object_pairs_hook=no_duplicate_keys,
                        parse_constant=reject_constant)
    except (UnicodeError,TypeError,ValueError):
        raise VisualGateError("DOCLING_NATIVE_RECEIPT_JSON_INVALID") from None
    if (not isinstance(data,dict) or data.get("schema_version")!=1 or
            data.get("evidence")!=EVIDENCE or
            data.get("corpus_id")!=native["corpus_id"] or
            data.get("pdf_books")!=6 or data.get("native_selected_pages")!=24 or
            data.get("docling_native_completed_pages")!=24 or
            data.get("engine")!="Docling NativePdfPipeline" or
            data.get("model_free") is not True or
            data.get("actual_docling_standard_pipeline_tested") is not False or
            data.get("mineru_tested") is not False or
            data.get("layout_quality_gold",object()) is not None or
            data.get("ocr_quality_gold",object()) is not None or
            data.get("graph_quality_gold",object()) is not None or
            data.get("provider_calls")!=0 or data.get("model_downloads")!=0 or
            not isinstance(data.get("pages"),list) or len(data["pages"])!=24):
        raise VisualGateError("DOCLING_NATIVE_RECEIPT_PROVENANCE_INVALID")
    expected_pairs={(r["book_id"],p["physical_page"])
                    for r in native["rows"] for p in r["pages"]}
    seen=set()
    for row in data["pages"]:
        if not isinstance(row,dict):
            raise VisualGateError("DOCLING_NATIVE_RECEIPT_ROW_INVALID")
        key=(row.get("book_id"),row.get("physical_page"))
        if key in seen or key not in expected_pairs:
            raise VisualGateError("DOCLING_NATIVE_RECEIPT_SOURCE_IDENTITY_INVALID")
        seen.add(key)
        e=next(r for r in native["rows"] if r["book_id"]==key[0])
        if row.get("original_pdf_sha256")!=e["source_document_sha256"]:
            raise VisualGateError("DOCLING_NATIVE_ORIGINAL_SHA_CHANGED")
        name=f"{key[0]}_p{key[1]:04d}.private.pdf"
        page=sub/name
        if (row.get("staged_single_page_pdf")!=name or
                page.is_symlink() or not page.is_file() or
                not 0<page.stat().st_size<=MAX_PDF or
                hashlib.sha256(page.read_bytes()).hexdigest()!=row.get("staged_pdf_sha256")):
            raise VisualGateError("DOCLING_NATIVE_STAGED_PDF_TAMPERED")
        txt=row.get("private_markdown_text")
        if (not isinstance(txt,str) or len(txt)>MAX_MARKDOWN_CHARS or
                hashlib.sha256(txt.encode("utf-8")).hexdigest()!=row.get("private_markdown_sha256") or
                len(txt)!=row.get("markdown_char_count") or
                any(type(row.get(k)) is not int or row[k]<0 for k in
                    ("duration_ms","text_item_count","picture_item_count")) or
                row.get("pipeline")!="DOCLING_NATIVE_MODEL_FREE_NO_OCR_NO_LAYOUT_NO_TABLE_MODELS"):
            raise VisualGateError("DOCLING_NATIVE_PRIVATE_OUTPUT_TAMPERED")
    if seen!=expected_pairs or len(list(sub.glob("*.private.pdf")))!=24:
        raise VisualGateError("DOCLING_NATIVE_RECEIPT_PAGE_COVERAGE_INVALID")
    return data


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument("--write",action="store_true")
    mode.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    if args.audit_only:
        r=audit_existing(Path(args.private_root),manifest)
    else:
        import fitz
        r=execute(Path(args.private_root),manifest,fitz,write=args.write)
    print("ACS_DOCLING_NATIVE_STATUS="+(
        "PRIVATE_WRITTEN" if args.write else
        "PRIVATE_RECEIPT_VERIFIED" if args.audit_only else "READONLY_PREVIEW"))
    print("ACS_DOCLING_NATIVE_BOOKS="+str(r["pdf_books"]))
    print("ACS_DOCLING_NATIVE_PAGES="+str(r["docling_native_completed_pages"]))
    print("ACS_DOCLING_NATIVE_TEXT_ITEMS="+str(sum(p["text_item_count"] for p in r["pages"])))
    print("ACS_DOCLING_NATIVE_PICTURES="+str(sum(p["picture_item_count"] for p in r["pages"])))
    print("ACS_DOCLING_NATIVE_TOTAL_DURATION_MS="+str(sum(p["duration_ms"] for p in r["pages"])))
    print("ACS_DOCLING_NATIVE_STANDARD_AI_TESTED=FALSE")
    print("ACS_DOCLING_NATIVE_MINERU_TESTED=FALSE")
    print("ACS_DOCLING_NATIVE_GOLD=UNVERIFIED")
    print("ACS_DOCLING_NATIVE_PROVIDER_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError, OSError, TypeError, ValueError, ImportError) as e:
        print("ACS_DOCLING_NATIVE_REJECTED="+(
            e.code if isinstance(e,VisualGateError) else type(e).__name__))
        sys.exit(2)
