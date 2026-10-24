#!/usr/bin/env python3
"""Four additional real PDF pages using verified offline Docling Standard+RapidOCR.

B15 p109 is NEVER rerun; reuses immutable successful v4 evidence.  Only the
four other SHA-fenced PDF pages are inferred, sequentially, one subprocess per
page.  Existing private receipts are audited without rerunning an engine.
This records source-bound output quantities, NOT OCR correctness or CER.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from ebook_b15_docling_standard_rapidocr_real import (
    compute as audit_b15, discover_existing_rapidocr, _symlink_ancestor,
    VERSIONS, MAX_RUNTIME, _exclusive,
)
from ebook_b15_docling_standard_layout_real import verify_source as verified_b15_layout
from ebook_b15_threeway_gap_spatial import execute as audit_v6, REPORT as V6
from ebook_fivebook_mineru_basic_matrix import (
    source_contract, ALL_BOOKS,
)
from ebook_fivebook_text_consensus import lexical,mineru_lexical_source
from ebook_multibook_native_matrix import _private_folder
from ebook_private_graph_receipt_audit import no_duplicate_keys,reject_constant
from ebook_private_glm_visual_reference import VisualGateError

NEW_BOOKS=("B03","B08","B29","B31")
REPORT="fivebook_docling_standard_rapidocr_real.v7.private.json"
EVIDENCE="FIVE_REAL_SAME_PAGE_DOCLING_STANDARD_RAPIDOCR_B15_REUSED_FOUR_NEW_NOT_GOLD"
MAX_WORKER=400000
MAX_LOG=180000
MAX_RECEIPT=22000
MAX_PDF=35*1024*1024


def paths(folder,book):
    if book not in NEW_BOOKS:
        raise VisualGateError("FIVE_STD_OCR_BOOK_NOT_ALLOWED")
    stem=f"fivebook_docling_standard_rapidocr_{book}.v7.private"
    return (folder/(stem+".json"),folder/(stem+".worker.json"),
            folder/(stem+".worker.log"))


def read_bytes(path,limit):
    if (path.is_symlink() or not path.is_file()
            or not 0<path.stat().st_size<=limit):
        raise VisualGateError("FIVE_STD_OCR_PRIVATE_FILE_MISSING_OR_UNSAFE")
    return path.read_bytes()


def sha(path,max_bytes):
    return hashlib.sha256(read_bytes(path,max_bytes)).hexdigest()


def json_private(path,limit):
    try:
        return json.loads(read_bytes(path,limit).decode("utf-8"),
                          object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (UnicodeError,ValueError,TypeError):
        raise VisualGateError("FIVE_STD_OCR_PRIVATE_JSON_INVALID") from None


def valid_worker(blob):
    try:
        record=json.loads(blob.decode("utf-8"),
                          object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (UnicodeError,ValueError,TypeError):
        raise VisualGateError("FIVE_STD_OCR_WORKER_JSON_INVALID") from None
    if (not isinstance(record,dict) or
            record.get("pipeline")!="REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU"
            or record.get("ocr_explicitly_enabled") is not True
            or any(type(record.get(k)) is not int or record[k]<0 for k in (
                "duration_ms","text_item_count","picture_item_count",
                "table_item_count")) or
            not isinstance(record.get("private_markdown"),str)):
        raise VisualGateError("FIVE_STD_OCR_WORKER_NOT_REAL_SUCCESS")
    normalized=len(lexical(mineru_lexical_source(record["private_markdown"])))
    if normalized>100000:
        raise VisualGateError("FIVE_STD_OCR_WORKER_TEXT_EXCESSIVE")
    return record,normalized


def audit_one(folder,entry,book):
    receipt,worker,log=paths(folder,book)
    data=json_private(receipt,MAX_RECEIPT)
    if (not isinstance(data,dict) or data.get("schema_version")!=7
            or data.get("evidence")!=EVIDENCE or data.get("book_id")!=book
            or data.get("physical_page")!=entry["physical_page"]
            or data.get("original_pdf_sha256_private")!=entry["original_pdf_sha256"]
            or data.get("single_page_pdf_sha256_private")!=entry["single_pdf_sha256"]
            or data.get("ocr_engine")!="DOCLING_STANDARD_RAPIDOCR_3_9_2"
            or data.get("cer",object()) is not None
            or data.get("new_cloud_calls")!=0
            or data.get("new_model_downloads")!=0):
        raise VisualGateError("FIVE_STD_OCR_RECEIPT_SOURCE_IDENTITY_CHANGED")
    if (data.get("worker_sha256_private") is None)!=(
            data.get("status")!="REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS"):
        raise VisualGateError("FIVE_STD_OCR_RECEIPT_SUCCESS_INCONSISTENT")
    if data.get("worker_sha256_private") is None:
        if worker.exists() or worker.is_symlink() or data.get("normalized_characters") is not None:
            raise VisualGateError("FIVE_STD_OCR_FALSE_WORKER_RESULT")
    else:
        raw=read_bytes(worker,MAX_WORKER)
        if hashlib.sha256(raw).hexdigest()!=data["worker_sha256_private"]:
            raise VisualGateError("FIVE_STD_OCR_FROZEN_WORKER_TAMPERED")
        item,chars=valid_worker(raw)
        for key,value in (("duration_ms",item["duration_ms"]),
                          ("text_item_count",item["text_item_count"]),
                          ("picture_item_count",item["picture_item_count"]),
                          ("table_item_count",item["table_item_count"]),
                          ("normalized_characters",chars)):
            if data.get(key)!=value:
                raise VisualGateError("FIVE_STD_OCR_FROZEN_METRIC_CHANGED")
    digest=data.get("private_log_sha256")
    if digest is None:
        if log.exists() or log.is_symlink():
            raise VisualGateError("FIVE_STD_OCR_UNEXPECTED_LOG")
    elif hashlib.sha256(read_bytes(log,MAX_LOG)).hexdigest()!=digest:
        raise VisualGateError("FIVE_STD_OCR_FROZEN_LOG_CHANGED")
    return data


def run_one(folder,entry,book,model_dir,package,*,runner=subprocess.run):
    receipt,worker,log=paths(folder,book)
    if receipt.exists() or receipt.is_symlink():
        return audit_one(folder,entry,book)
    if any(p.exists() or p.is_symlink() for p in (worker,log)):
        raise VisualGateError("FIVE_STD_OCR_PARTIAL_WORKER_REQUIRES_MANUAL_RECOVERY")
    page=entry["source_file"]
    if (page.is_symlink() or not page.is_file()
            or not page.resolve().is_relative_to(folder.resolve())
            or sha(page,MAX_PDF)!=entry["single_pdf_sha256"]):
        raise VisualGateError("FIVE_STD_OCR_SINGLE_PAGE_PDF_CHANGED")
    if (not isinstance(package.get("site"),Path) or
            package.get("versions")!=VERSIONS or
            not package["site"].is_dir() or
            _symlink_ancestor(folder.parent.parent,package["site"]) or
            not isinstance(package.get("weights"),dict)
            or len(package["weights"])<2):
        raise VisualGateError("FIVE_STD_OCR_PACKAGE_NOT_VERIFIED")
    cmd=[sys.executable,
         str(Path(__file__).with_name("ebook_b15_docling_standard_rapidocr_real.py").resolve()),
         "--worker-pdf",str(page),"--worker-layout",str(model_dir),
         "--worker-out",str(worker)]
    env=os.environ.copy()
    env.update({
        "PYTHONPATH":str(package["site"]),"PYTHONNOUSERSITE":"1",
        "HF_HUB_OFFLINE":"1","TRANSFORMERS_OFFLINE":"1",
        "HF_DATASETS_OFFLINE":"1","HF_HUB_DISABLE_TELEMETRY":"1",
        "HTTP_PROXY":"http://127.0.0.1:1",
        "HTTPS_PROXY":"http://127.0.0.1:1",
        "ALL_PROXY":"http://127.0.0.1:1","NO_PROXY":"",
    })
    try:
        proc=runner(cmd,env=env,stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,timeout=MAX_RUNTIME,check=False)
        diag=((proc.stdout or b"")+(proc.stderr or b""))[:MAX_LOG]
        status=("REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS"
                if proc.returncode==0 and worker.is_file() and not worker.is_symlink()
                else "BLOCKED_STANDARD_RAPIDOCR_REAL_RUNTIME_PRIVATE_ERROR")
    except subprocess.TimeoutExpired as exc:
        diag=((exc.stdout or b"")+(exc.stderr or b""))[:MAX_LOG]
        status="BLOCKED_STANDARD_RAPIDOCR_REAL_TIMEOUT"
    if not diag:
        diag=b"PRIVATE_STDOUT_STDERR_EMPTY\n"
    _exclusive(log,diag)
    stats=None
    if status=="REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS":
        stats,chars=valid_worker(read_bytes(worker,MAX_WORKER))
    else:
        if worker.exists() or worker.is_symlink():
            raise VisualGateError("FIVE_STD_OCR_FAILED_WORKER_PARTIAL_OUTPUT")
        chars=None
    data={
        "schema_version":7,"evidence":EVIDENCE,"book_id":book,
        "physical_page":entry["physical_page"],
        "original_pdf_sha256_private":entry["original_pdf_sha256"],
        "single_page_pdf_sha256_private":entry["single_pdf_sha256"],
        "ocr_engine":"DOCLING_STANDARD_RAPIDOCR_3_9_2",
        "status":status,
        "worker_sha256_private":sha(worker,MAX_WORKER) if stats else None,
        "private_log_sha256":sha(log,MAX_LOG),
        "duration_ms":stats["duration_ms"] if stats else None,
        "text_item_count":stats["text_item_count"] if stats else None,
        "picture_item_count":stats["picture_item_count"] if stats else None,
        "table_item_count":stats["table_item_count"] if stats else None,
        "normalized_characters":chars,
        "cer":None,"quality_winner":None,
        "new_cloud_calls":0,"new_model_downloads":0,
    }
    _exclusive(receipt,(json.dumps(data,ensure_ascii=False,
            sort_keys=True,separators=(",",":"))+"\n").encode("utf-8"))
    return audit_one(folder,entry,book)


def build_summary(folder,entries,baseline,rows):
    b15=entries["B15"]
    if (baseline.get("status")!="REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS"
            or baseline.get("actual_ocr_success") is not True
            or baseline.get("source_single_page_pdf_sha256_private")!=
                b15["single_pdf_sha256"] or baseline.get("cer",object()) is not None):
        raise VisualGateError("FIVE_STD_OCR_B15_BASELINE_INVALID")
    result=[{
        "book_id":"B15","physical_page":b15["physical_page"],
        "source_page_sha256_private":b15["single_pdf_sha256"],
        "execution_basis":"B15_REUSED_FROZEN_V4_NO_NEW_OCR",
        "status":baseline["status"],
        "duration_ms":baseline["duration_ms"],
        "text_item_count":baseline["text_item_count"],
        "picture_item_count":baseline["picture_item_count"],
        "table_item_count":baseline["table_item_count"],
        "normalized_characters":baseline["markdown_normalized_character_count"],
    }]
    for book in NEW_BOOKS:
        e=entries[book]
        record=rows[book]
        result.append({
            "book_id":book,"physical_page":e["physical_page"],
            "source_page_sha256_private":e["single_pdf_sha256"],
            "execution_basis":"V7_NEW_PRIVATE_SUBPROCESS_ATTEMPT",
            "status":record["status"],
            "duration_ms":record["duration_ms"],
            "text_item_count":record["text_item_count"],
            "picture_item_count":record["picture_item_count"],
            "table_item_count":record["table_item_count"],
            "normalized_characters":record["normalized_characters"],
        })
    return {"schema_version":7,"evidence":EVIDENCE,
            "books":5,"same_source_focus_pages":5,
            "b15_reused_no_new_inference":True,
            "other_book_new_attempts":4,
            "actual_standard_ocr_success_pages":sum(
                r["status"]=="REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS" for r in result),
            "all_five_real_standard_ocr_succeeded":all(
                r["status"]=="REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS" for r in result),
            "rows":result,"independent_ocr_gold":None,
            "cer":None,"quality_winner":None,"cloud_calls":0,
            "model_downloads":0}


def execute(root,manifest,*,write=False,audit=False,
            source_fn=source_contract,b15_fn=audit_b15,v6_fn=audit_v6,
            probe=discover_existing_rapidocr,runner=subprocess.run):
    if write==audit:
        raise VisualGateError("FIVE_STD_OCR_EXPLICIT_MODE_REQUIRED")
    root=Path(root)
    entries,_,_,folder,_,_,corpus=source_fn(root,manifest)
    if (set(entries)!=set(ALL_BOOKS) or len(entries)!=5 or
            not isinstance(corpus,str)):
        raise VisualGateError("FIVE_STD_OCR_SOURCE_SET_NOT_FIVE")
    baseline=b15_fn(root,manifest,audit=True)
    prior=v6_fn(root,manifest,audit=True)
    if (prior.get("book_id")!="B15" or prior.get("physical_page")!=109
            or prior.get("corpus_id")!=corpus):
        raise VisualGateError("FIVE_STD_OCR_V6_BASELINE_SOURCE_INVALID")
    root_folder,stage,b15_sha,_,model_paths=verified_b15_layout(root,manifest)
    if (root_folder!=folder or len(model_paths)!=1 or
            stage!=entries["B15"]["source_file"] or
            b15_sha!=entries["B15"]["single_pdf_sha256"]):
        raise VisualGateError("FIVE_STD_OCR_LAYOUT_MODEL_SOURCE_CHANGED")
    report=folder/REPORT
    if audit:
        records={book:audit_one(folder,entries[book],book) for book in NEW_BOOKS}
        summary=build_summary(folder,entries,baseline,records)
        raw=(json.dumps(summary,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
        if report.is_symlink() or not report.is_file() or report.read_bytes()!=raw:
            raise VisualGateError("FIVE_STD_OCR_FROZEN_SUMMARY_CHANGED")
        return summary
    if report.exists() or report.is_symlink():
        raise VisualGateError("FIVE_STD_OCR_SUMMARY_ALREADY_EXISTS")
    candidates=probe(root)
    if not isinstance(candidates,list) or len(candidates)!=1:
        raise VisualGateError("FIVE_STD_OCR_LOCAL_RAPIDOCR_ENV_NOT_UNIQUE")
    package=candidates[0]
    rows={}
    for book in NEW_BOOKS:
        rows[book]=run_one(folder,entries[book],book,model_paths[0][1],
                           package,runner=runner)
    summary=build_summary(folder,entries,baseline,rows)
    raw=(json.dumps(summary,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
    if len(raw)>MAX_RECEIPT:
        raise VisualGateError("FIVE_STD_OCR_FROZEN_SUMMARY_TOO_LARGE")
    _exclusive(report,raw)
    return summary


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    choice=parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--write",action="store_true")
    choice.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    data=execute(Path(args.private_root),manifest,
                 write=args.write,audit=args.audit_only)
    print("ACS_FIVE_STD_STATUS="+("PRIVATE_CREATED" if args.write else "PRIVATE_VERIFIED"))
    print("ACS_FIVE_STD_SAME_SOURCE_PAGES="+str(data["same_source_focus_pages"]))
    print("ACS_FIVE_STD_SUCCESS_PAGES="+str(data["actual_standard_ocr_success_pages"]))
    print("ACS_FIVE_STD_ALL_SUCCEEDED="+str(data["all_five_real_standard_ocr_succeeded"]).upper())
    for row in data["rows"]:
        key="ACS_FIVE_STD_"+row["book_id"]+"_"
        for attr in ("physical_page","status","duration_ms","normalized_characters",
                     "text_item_count","picture_item_count","table_item_count"):
            print(key+attr.upper()+"="+str(row[attr]))
    print("ACS_FIVE_STD_GOLD=UNVERIFIED")
    print("ACS_FIVE_STD_CLOUD_CALLS=0")
    print("ACS_FIVE_STD_MODEL_DOWNLOADS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,TypeError,UnicodeError,OSError,RuntimeError):
        print("ACS_FIVE_STD_REJECTED=PRIVATE_SOURCE_OR_INTEGRITY_GATE")
        sys.exit(2)
