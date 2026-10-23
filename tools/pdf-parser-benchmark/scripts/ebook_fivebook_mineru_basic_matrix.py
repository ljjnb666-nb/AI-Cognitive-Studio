#!/usr/bin/env python3
"""Four additional real OCR-focus PDF pages through cached MinerU Basic ONNX.

B31 original page 126 is re-used (never re-inferred), yielding a five-book
same-source comparison with prior RapidOCR. Only output quantities, NOT OCR
accuracy. All Markdown/logs/per-source SHA stay in private D: receipts.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from ebook_multibook_native_matrix import audit_existing as audit_native, _private_folder
from ebook_multibook_docling_native import audit_existing as audit_docling
from ebook_multibook_rapidocr_matrix import audit_existing as audit_rapidocr
from ebook_b31_mineru_basic_stateless import audit_existing as audit_b31
from ebook_b31_mineru_markdown_structure import audit_existing as audit_b31_structure, count_structure
from ebook_b31_mineru403_reuse import cache_inventory, safe_environment, sha_file
from ebook_mineru403_failure_triage import audit_existing as audit_model_verify
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

BOOKS=("B03","B08","B15","B29")
ALL_BOOKS=("B03","B08","B15","B29","B31")
EVIDENCE="FIVE_REAL_PDFS_FOCUS_PAGES_LOCAL_MINERU_BASIC_VS_RAPIDOCR_NOT_GOLD"
PER_BOOK_EVIDENCE="FOUR_NEW_REAL_PDF_MINERU_BASIC_ONNX_FOCUS_PAGE_NOT_GOLD"
SUMMARY="fivebook_mineru_rapidocr_comparison.private.json"
MAX_REPORT=180_000
MAX_MD=6_000_000
MAX_LOG=3_000_000
MAX_SECONDS=900


def file_names(book):
    if book not in BOOKS:
        raise VisualGateError("FIVEBOOK_INVALID_MINERU_BOOK_ID")
    prefix=f"fivebook_mineru_basic_{book}"
    return prefix+".private.json",prefix+".private.md",prefix+".private.log"


def _exclusive(path,raw):
    flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
    if hasattr(os,"O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as f:
        f.write(raw)


def source_contract(root,manifest):
    native=audit_native(root,manifest)
    docling=audit_docling(root,manifest)
    rapid=audit_rapidocr(root,manifest)
    old=audit_b31(root,manifest)
    b31_structure=audit_b31_structure(root,manifest)
    model_verify=audit_model_verify(root,manifest)
    if (model_verify.get("basic_model_probe",{}).get("basic_models_verified") is not True or
            old.get("real_inference") is not True or
            b31_structure.get("new_model_inference_calls")!=0 or
            native.get("selected_native_pages")!=24 or
            docling.get("docling_native_completed_pages")!=24 or
            rapid.get("ocr_books")!=5 or rapid.get("ocr_pages")!=5):
        raise VisualGateError("FIVEBOOK_VALIDATED_UPSTREAM_READINESS_MISSING")
    exe,_,models=cache_inventory(root)
    kit=exe.with_name("mineru-kit.exe")
    if not kit.is_file() or kit.is_symlink():
        raise VisualGateError("FIVEBOOK_VERIFIED_MINERU_KIT_MISSING")
    index={(row["book_id"],p["physical_page"]):(row,p)
           for row in native["rows"] for p in row["pages"]
           if "ocr_focus_png" in p}
    rapid_index={(p["book_id"],p["physical_page"]):p for p in rapid["pages"]}
    doc_index={(p["book_id"],p["physical_page"]):p for p in docling["pages"]}
    if (len(index)!=5 or set(index)!=set(rapid_index) or
            set(index)!={(book,page) for book,page in doc_index if (book,page) in index} or
            set(book for book,_ in index)!=set(ALL_BOOKS)):
        raise VisualGateError("FIVEBOOK_NOT_IDENTICAL_OCR_FOCUS_PAGE_SET")
    folder=_private_folder(root)
    entries={}
    for (book,physical),(parent,page) in index.items():
        doc=doc_index[(book,physical)]
        rp=rapid_index[(book,physical)]
        single=folder/"docling_native_single_pages"/f"{book}_p{physical:04d}.private.pdf"
        if (single.is_symlink() or not single.is_file() or
                not 0<single.stat().st_size<=35*1024*1024 or
                sha_file(single)!=doc["staged_pdf_sha256"] or
                doc["original_pdf_sha256"]!=parent["source_document_sha256"] or
                rp["source_document_sha256"]!=parent["source_document_sha256"] or
                rp["render_png_sha256"]!=page["ocr_focus_png_sha256"]):
            raise VisualGateError("FIVEBOOK_SAME_SOURCE_PDF_SHA_MISMATCH")
        entries[book]={
            "book_id":book,"physical_page":physical,
            "original_pdf_sha256":parent["source_document_sha256"],
            "single_pdf_sha256":doc["staged_pdf_sha256"],
            "rapidocr_source_png_sha256":rp["render_png_sha256"],
            "rapidocr_line_count":rp["rapidocr_line_count"],
            "rapidocr_character_count":rp["rapidocr_char_count"],
            "rapidocr_duration_ms":rp["duration_ms"],
            "source_file":single,
        }
    if (entries["B31"]["physical_page"]!=126 or
            entries["B31"]["single_pdf_sha256"]!=old["source_page_sha256"] or
            old["source_document_sha256"]!=entries["B31"]["original_pdf_sha256"]):
        raise VisualGateError("FIVEBOOK_B31_SOURCE_REUSE_MISMATCH")
    return entries,kit,models,folder,old,b31_structure,native["corpus_id"]


def _data_path(folder,book):
    names=file_names(book)
    return tuple(folder/name for name in names)


def _receipt_validate(data,entry,models,md,log):
    if (not isinstance(data,dict) or data.get("schema_version")!=1 or
            data.get("evidence")!=PER_BOOK_EVIDENCE or
            data.get("book_id")!=entry["book_id"] or
            type(data.get("physical_page")) is not int or
            data["physical_page"]!=entry["physical_page"] or
            data.get("original_pdf_sha256")!=entry["original_pdf_sha256"] or
            data.get("single_pdf_sha256")!=entry["single_pdf_sha256"] or
            data.get("rapidocr_source_png_sha256")!=entry["rapidocr_source_png_sha256"] or
            data.get("cached_model_sha256_private")!=models or
            data.get("mineru_tier")!="basic" or data.get("ocr_mode")!="ocr" or
            data.get("small_backend")!="onnx" or
            data.get("engine_version")!="4.0.3" or
            data.get("real_inference") is not True or data.get("exit_code")!=0 or
            data.get("paid_provider_calls")!=0 or data.get("model_downloads")!=0 or
            data.get("ocr_quality_gold",object()) is not None or
            data.get("layout_quality_gold",object()) is not None or
            data.get("graph_quality_gold",object()) is not None or
            type(data.get("duration_ms")) is not int or data["duration_ms"]<0 or
            not isinstance(data.get("markdown_counts"),dict)):
        raise VisualGateError("FIVEBOOK_PRIVATE_PROVENANCE_INVALID")
    if (md.is_symlink() or log.is_symlink() or not md.is_file() or
            not log.is_file() or not 0<md.stat().st_size<=MAX_MD or
            log.stat().st_size>MAX_LOG or
            data.get("markdown_sha256_private")!=sha_file(md) or
            data.get("execution_log_sha256_private")!=sha_file(log)):
        raise VisualGateError("FIVEBOOK_PRIVATE_MARKDOWN_OR_LOG_CHANGED")
    try:
        measured=count_structure(md.read_text("utf-8"))
    except UnicodeError:
        raise VisualGateError("FIVEBOOK_PRIVATE_MARKDOWN_DECODE_FAILURE") from None
    if measured!=data["markdown_counts"]:
        raise VisualGateError("FIVEBOOK_PRIVATE_MARKDOWN_ACCOUNTING_CHANGED")
    return data


def audit_book(root,manifest,book,*,contract=None):
    entries,kit,models,folder,old,structure,corpus=(
        source_contract(root,manifest) if contract is None else contract)
    if book not in BOOKS:
        raise VisualGateError("FIVEBOOK_INVALID_MINERU_BOOK_ID")
    receipt,md,log=_data_path(folder,book)
    if (receipt.is_symlink() or not receipt.is_file() or
            not 0<receipt.stat().st_size<=MAX_REPORT):
        raise VisualGateError("FIVEBOOK_PRIVATE_RESULT_MISSING")
    try:
        saved=json.loads(receipt.read_text("utf-8"),
            object_pairs_hook=no_duplicate_keys,parse_constant=reject_constant)
    except (UnicodeError,ValueError,TypeError):
        raise VisualGateError("FIVEBOOK_PRIVATE_RESULT_JSON_INVALID") from None
    if saved.get("corpus_id")!=corpus:
        raise VisualGateError("FIVEBOOK_PRIVATE_CORPUS_CHANGED")
    return _receipt_validate(saved,entries[book],models,md,log)


def run_book(root,manifest,book,*,write=False,runner=None,contract=None):
    entries,kit,models,folder,old,structure,corpus=(
        source_contract(root,manifest) if contract is None else contract)
    if book not in BOOKS:
        raise VisualGateError("FIVEBOOK_INVALID_MINERU_BOOK_ID")
    entry=entries[book]
    receipt,md,log=_data_path(folder,book)
    if any(p.exists() or p.is_symlink() for p in (receipt,md,log)):
        raise VisualGateError("FIVEBOOK_PRIOR_RESULT_OR_PARTIAL_EXISTS")
    if not write:
        return {"book_id":book,"physical_page":entry["physical_page"],
                "actual_inference":False,"model_weights":len(models)}
    env=safe_environment(root)
    env.update({"MINERU_MODEL_SMALL_BACKEND":"onnx",
                "MINERU_TABLE_DEVICE":"cpu"})
    command=[str(kit),"parse",str(entry["source_file"]),"-o",str(md),
             "--tier","basic","--ocr-mode","ocr"]
    before=time.perf_counter()
    try:
        with open(log,"xb") as dst:
            if runner is None:
                rc=subprocess.run(command,cwd=folder,env=env,
                    stdout=dst,stderr=subprocess.STDOUT,
                    timeout=MAX_SECONDS,check=False).returncode
            else:
                rc=runner(command,env,log)
    except subprocess.TimeoutExpired:
        raise VisualGateError("FIVEBOOK_REAL_ONNX_PROCESS_TIMEOUT") from None
    if rc!=0:
        raise VisualGateError("FIVEBOOK_REAL_ONNX_INFERENCE_FAILED")
    elapsed=round((time.perf_counter()-before)*1000)
    if (md.is_symlink() or not md.is_file() or
            not 0<md.stat().st_size<=MAX_MD or
            log.stat().st_size>MAX_LOG):
        raise VisualGateError("FIVEBOOK_REAL_OCR_PRIVATE_OUTPUT_INVALID")
    try:
        measured=count_structure(md.read_text("utf-8"))
    except UnicodeError:
        raise VisualGateError("FIVEBOOK_MARKDOWN_DECODE_FAILURE") from None
    _,_,after=cache_inventory(root)
    if after!=models or sha_file(entry["source_file"])!=entry["single_pdf_sha256"]:
        raise VisualGateError("FIVEBOOK_ORIGINAL_SOURCE_OR_MODEL_CHANGED")
    record={
        "schema_version":1,"evidence":PER_BOOK_EVIDENCE,
        "corpus_id":corpus,
        "book_id":book,"physical_page":entry["physical_page"],
        "original_pdf_sha256":entry["original_pdf_sha256"],
        "single_pdf_sha256":entry["single_pdf_sha256"],
        "rapidocr_source_png_sha256":entry["rapidocr_source_png_sha256"],
        "cached_model_sha256_private":models,
        "engine_version":"4.0.3","mineru_tier":"basic",
        "ocr_mode":"ocr","small_backend":"onnx",
        "real_inference":True,"exit_code":0,"duration_ms":elapsed,
        "markdown_sha256_private":sha_file(md),
        "execution_log_sha256_private":sha_file(log),
        "markdown_counts":measured,
        "ocr_quality_gold":None,"layout_quality_gold":None,
        "graph_quality_gold":None,
        "paid_provider_calls":0,"model_downloads":0,
    }
    _receipt_validate(record,entry,models,md,log)
    payload=(json.dumps(record,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
    if len(payload)>MAX_REPORT:
        raise VisualGateError("FIVEBOOK_PRIVATE_RECEIPT_TOO_LARGE")
    _exclusive(receipt,payload)
    return record


def combined(root,manifest,*,write=False,audit=False):
    contract=source_contract(root,manifest)
    entries,kit,models,folder,b31,b31structure,corpus=contract
    path=folder/SUMMARY
    if not audit and (path.exists() or path.is_symlink()):
        raise VisualGateError("FIVEBOOK_SUMMARY_ALREADY_EXISTS")
    rows=[]
    for book in ALL_BOOKS:
        e=entries[book]
        if book=="B31":
            stats=b31structure["mineru"]
            duration=b31["duration_ms"]
            basis="REUSED_PRIOR_SUCCESS_NOT_REINFERRED"
        else:
            receipt=audit_book(root,manifest,book,contract=contract)
            stats=receipt["markdown_counts"]
            duration=receipt["duration_ms"]
            basis="NEW_BASIC_ONNX_REAL_SOURCE_PAGE"
        rows.append({
            "book_id":book,"physical_page":e["physical_page"],
            "same_original_pdf_page":True,
            "source_pdf_sha256_private":e["single_pdf_sha256"],
            "rapidocr_lines":e["rapidocr_line_count"],
            "rapidocr_characters":e["rapidocr_character_count"],
            "rapidocr_duration_ms":e["rapidocr_duration_ms"],
            "mineru_execution_basis":basis,
            "mineru_basic_duration_ms":duration,
            "mineru_markdown_raw_chars":stats["markdown_raw_character_count"],
            "mineru_image_data_uri_count":stats["embedded_image_data_uri_count"],
            "mineru_base64_image_payload_chars":stats["embedded_image_data_uri_raw_characters"],
            "mineru_nonimage_nonwhitespace_residue":stats[
                "nonwhitespace_nonimage_markdown_residue_chars"],
        })
    result={
        "schema_version":1,"evidence":EVIDENCE,"corpus_id":corpus,
        "pdf_books":5,"identical_focus_pages":5,"new_mineru_inferences":4,
        "b31_mineru_result_reused":True,"rows":rows,
        "ocr_quality_gold":None,"table_quality_gold":None,
        "formula_quality_gold":None,"graph_quality_gold":None,
        "different_engines_output_types_not_equal_ocr_words":True,
        "provider_calls":0,"model_downloads":0,
    }
    blob=(json.dumps(result,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
    if len(blob)>MAX_REPORT:
        raise VisualGateError("FIVEBOOK_SUMMARY_TOO_LARGE")
    if audit:
        if path.is_symlink() or not path.is_file() or path.read_bytes()!=blob:
            raise VisualGateError("FIVEBOOK_SUMMARY_RECHECK_FAILED")
    elif write:
        _exclusive(path,blob)
    return result


def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument("--private-root",required=True)
    p.add_argument("--manifest",required=True)
    p.add_argument("--book",choices=BOOKS)
    action=p.add_mutually_exclusive_group()
    action.add_argument("--write",action="store_true")
    action.add_argument("--audit-only",action="store_true")
    action.add_argument("--summary",action="store_true")
    action.add_argument("--audit-summary",action="store_true")
    args=p.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    root=Path(args.private_root)
    if args.summary or args.audit_summary:
        data=combined(root,manifest,write=args.summary,audit=args.audit_summary)
        print("ACS_FIVEBOOK_MINERU_SUMMARY_STATUS="+(
            "VERIFIED" if args.audit_summary else "PRIVATE_CREATED"))
        print("ACS_FIVEBOOK_MINERU_PAGES="+str(data["identical_focus_pages"]))
        print("ACS_FIVEBOOK_MINERU_NEW_INFERENCE_PAGES="+str(data["new_mineru_inferences"]))
        print("ACS_FIVEBOOK_MINERU_TOTAL_BASE64_CHARS="+str(sum(
            x["mineru_base64_image_payload_chars"] for x in data["rows"])))
    elif args.book is None:
        raise VisualGateError("FIVEBOOK_SELECT_BOOK_REQUIRED")
    else:
        if args.audit_only:
            data=audit_book(root,manifest,args.book)
            status="PRIVATE_RECEIPT_VERIFIED"
        else:
            data=run_book(root,manifest,args.book,write=args.write)
            status="PRIVATE_CREATED" if args.write else "SOURCE_ONLY_PREFLIGHT"
        print("ACS_FIVEBOOK_MINERU_BOOK="+args.book)
        print("ACS_FIVEBOOK_MINERU_PAGE="+str(data["physical_page"]))
        print("ACS_FIVEBOOK_MINERU_STATUS="+status)
        print("ACS_FIVEBOOK_MINERU_INFERENCE="+str(
            data.get("real_inference",data.get("actual_inference"))).upper())
        if "markdown_counts" in data:
            print("ACS_FIVEBOOK_MINERU_RAW_MARKDOWN_CHARS="+str(
                data["markdown_counts"]["markdown_raw_character_count"]))
            print("ACS_FIVEBOOK_MINERU_BASE64_IMAGE_CHARS="+str(
                data["markdown_counts"]["embedded_image_data_uri_raw_characters"]))
    print("ACS_FIVEBOOK_MINERU_QUALITY_GOLD=UNVERIFIED")
    print("ACS_FIVEBOOK_MINERU_PAID_PROVIDER_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,OSError,ValueError,TypeError,RuntimeError):
        print("ACS_FIVEBOOK_MINERU_REJECTED=PRIVATE_SOURCE_OR_RECEIPT_GATE")
        sys.exit(2)
