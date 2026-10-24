#!/usr/bin/env python3
"""First REAL Docling Standard PDF layout conversion on B15 p109 (OCR OFF).

No download, cloud service, OCR model, manual truth, or raw text in public logs.
The only runnable model path is a previously identified private local artifact
directory. Exact source identity from #150/#151/#152 is rechecked first.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from ebook_b15_docling_rapidocr_fallback import execute as audit_fallback, REPORT as PARENT
from ebook_b15_docling_standard_readiness import ARTIFACT_FOLDERS, VERSION
from ebook_multibook_docling_native import audit_existing as audit_native
from ebook_multibook_native_matrix import _private_folder
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b15_docling_standard_layout_real.v3.private.json"
WORKER_JSON="b15_docling_standard_layout_worker.v3.private.json"
WORKER_LOG="b15_docling_standard_layout_worker.v3.private.log"
EVIDENCE="B15_DOCLING_STANDARD_REAL_LAYOUT_TRIAL_OCR_DISABLED_NOT_GOLD"
MAX_JSON=160000
MAX_REPORT=16000
MAX_LOG=200000
MAX_MARKDOWN=100000
RUN_TIMEOUT=150


def _exclusive(path, blob):
    flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
    if hasattr(os,"O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as f:
        f.write(blob)


def fixed_candidate(root, inventory):
    if not isinstance(inventory,list) or len(inventory)!=len(ARTIFACT_FOLDERS):
        raise VisualGateError("STANDARD_LAYOUT_INVENTORY_INVALID")
    selected=[]
    for relative,row in zip(ARTIFACT_FOLDERS,inventory):
        if not isinstance(row,dict) or row.get("candidate")!=relative:
            raise VisualGateError("STANDARD_LAYOUT_ARTIFACT_ORDER_CHANGED")
        if row.get("model_weight_files",0)>0 and row.get("config_files",0)>0:
            path=Path(root)/relative
            if not path.is_dir() or any(
                    (Path(root)/Path(*Path(relative).parts[:j])).is_symlink()
                    for j in range(1,len(Path(relative).parts)+1)):
                raise VisualGateError("STANDARD_LAYOUT_CANDIDATE_UNSAFE")
            if not path.resolve().is_relative_to(Path(root).resolve()):
                raise VisualGateError("STANDARD_LAYOUT_CANDIDATE_OUTSIDE_PRIVATE_ROOT")
            selected.append((relative,path))
    # Multiple caches require explicit selection: never silently pick one.
    return selected


def verify_source(root,manifest):
    parent=audit_fallback(root,manifest,audit=True)
    native=audit_native(root,manifest)
    if (parent.get("book_id")!="B15" or parent.get("physical_page")!=109
            or parent.get("standard_ocr_pages_executed")!=0
            or parent.get("standard_pipeline_initialized") is not False
            or parent.get("cer",object()) is not None
            or parent.get("corpus_id")!=native.get("corpus_id")):
        raise VisualGateError("STANDARD_LAYOUT_UPSTREAM_IDENTITY_CHANGED")
    matched=[x for x in native.get("pages",[])
             if (x.get("book_id"),x.get("physical_page"))==("B15",109)]
    if len(matched)!=1:
        raise VisualGateError("STANDARD_LAYOUT_SOURCE_PAGE_NOT_UNIQUE")
    folder=_private_folder(root)
    staged=folder/"docling_native_single_pages"/"B15_p0109.private.pdf"
    if (staged.is_symlink() or not staged.is_file() or
            not 0<staged.stat().st_size<=35_000_000 or
            hashlib.sha256(staged.read_bytes()).hexdigest()!=matched[0].get(
                "staged_pdf_sha256") or
            matched[0].get("staged_pdf_sha256")!=parent.get(
                "original_single_page_pdf_sha256_private")):
        raise VisualGateError("STANDARD_LAYOUT_SAME_PAGE_SHA_CHANGED")
    v1_path=folder/"b15_docling_standard_offline_readiness.private.json"
    if v1_path.is_symlink() or not v1_path.is_file():
        raise VisualGateError("STANDARD_LAYOUT_V1_RECEIPT_MISSING")
    v1=json.loads(v1_path.read_text(encoding="utf-8"))
    if v1.get("docling_installed_version")!=VERSION:
        raise VisualGateError("STANDARD_LAYOUT_DOCLING_VERSION_INVALID")
    candidates=fixed_candidate(root,v1["private_candidate_artifact_inventory"])
    return folder,staged,matched[0]["staged_pdf_sha256"],parent,candidates


def worker(pdf,models,result_file):
    # Only use the pinned private artifact path: never allow implicit HF downloads.
    if (os.environ.get("HF_HUB_OFFLINE")!="1" or
            os.environ.get("TRANSFORMERS_OFFLINE")!="1"):
        raise VisualGateError("STANDARD_LAYOUT_WORKER_NOT_OFFLINE")
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    options=PdfPipelineOptions(
        artifacts_path=Path(models),
        do_ocr=False,
        do_table_structure=False,
        generate_page_images=False,
        generate_picture_images=False,
        enable_remote_services=False,
        allow_external_plugins=False,
        document_timeout=110.0,
    )
    options.accelerator_options=AcceleratorOptions(
        num_threads=2,device=AcceleratorDevice.CPU)
    converter=DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={InputFormat.PDF:PdfFormatOption(pipeline_options=options)})
    t0=time.perf_counter()
    converted=converter.convert(str(pdf),max_num_pages=1)
    duration=round((time.perf_counter()-t0)*1000)
    if (getattr(converted.status,"name",str(converted.status))!="SUCCESS"
            or converted.document is None):
        raise VisualGateError("STANDARD_LAYOUT_CONVERSION_NOT_SUCCESS")
    doc=converted.document
    markdown=doc.export_to_markdown()
    if not isinstance(markdown,str) or len(markdown)>MAX_MARKDOWN:
        raise VisualGateError("STANDARD_LAYOUT_MARKDOWN_LIMIT")
    result={"kind":"REAL_DOCLING_STANDARD_OCR_OFF_LAYOUT_EXECUTED",
            "duration_ms":duration,"markdown_private":markdown,
            "text_item_count":len(doc.texts),
            "picture_item_count":len(doc.pictures),
            "table_item_count":len(doc.tables)}
    _exclusive(Path(result_file),
        (json.dumps(result,ensure_ascii=False,sort_keys=True)+"\n").encode("utf-8"))


def trial(root,manifest,*,write=False,audit=False,runner=None):
    folder,pdf,page_sha,parent,candidates=verify_source(root,manifest)
    output=folder/REPORT
    worker_out=folder/WORKER_JSON
    log_path=folder/WORKER_LOG
    if audit:
        if output.is_symlink() or not output.is_file():
            raise VisualGateError("STANDARD_LAYOUT_REPORT_MISSING")
        report=json.loads(output.read_text(encoding="utf-8"))
        if (report.get("schema_version")!=3 or report.get("evidence")!=EVIDENCE
                or report.get("same_page_sha256_private")!=page_sha
                or report.get("upstream_fallback_receipt_sha256_private")!=
                    hashlib.sha256((folder/PARENT).read_bytes()).hexdigest()
                or report.get("ocr_enabled") is not False or
                report.get("ocr_page_count")!=0 or
                report.get("cer",object()) is not None):
            raise VisualGateError("STANDARD_LAYOUT_FROZEN_REPORT_IDENTITY_CHANGED")
        for file,key in ((worker_out,"private_worker_record_sha256"),
                         (log_path,"private_worker_log_sha256")):
            expected=report.get(key)
            if expected is None:
                if file.exists() or file.is_symlink():
                    raise VisualGateError("STANDARD_LAYOUT_UNEXPECTED_WORKER_FILE")
            elif (file.is_symlink() or not file.is_file() or
                  hashlib.sha256(file.read_bytes()).hexdigest()!=expected):
                raise VisualGateError("STANDARD_LAYOUT_FROZEN_WORKER_TAMPERED")
        return report
    if (output.exists() or output.is_symlink() or worker_out.exists()
            or worker_out.is_symlink() or log_path.exists() or log_path.is_symlink()):
        raise VisualGateError("STANDARD_LAYOUT_FROZEN_OUTPUT_ALREADY_EXISTS")
    if len(candidates)==0:
        status="BLOCKED_OFFLINE_LAYOUT_MODEL_CANDIDATE"
        rawlog=None
    elif len(candidates)!=1:
        status="BLOCKED_MULTIPLE_LAYOUT_CANDIDATES_AMBIGUOUS"
        rawlog=None
    else:
        status="OFFLINE_LAYOUT_TRIAL_NOT_EXECUTED"
        rawlog=None
        if write:
            call=[sys.executable,str(Path(__file__).resolve()),
                  "--worker-pdf",str(pdf),
                  "--worker-artifacts",str(candidates[0][1]),
                  "--worker-result",str(worker_out)]
            env=os.environ.copy()
            env.update({"HF_HUB_OFFLINE":"1","TRANSFORMERS_OFFLINE":"1",
                        "HF_DATASETS_OFFLINE":"1","HF_HUB_DISABLE_TELEMETRY":"1",
                        "HTTP_PROXY":"http://127.0.0.1:1",
                        "HTTPS_PROXY":"http://127.0.0.1:1",
                        "ALL_PROXY":"http://127.0.0.1:1","NO_PROXY":""})
            try:
                p=(runner or subprocess.run)(
                    call,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                    timeout=RUN_TIMEOUT,env=env,check=False)
                rawlog=(p.stdout or b"")+(p.stderr or b"")
                if len(rawlog)>MAX_LOG:
                    rawlog=rawlog[:MAX_LOG]
                status=("REAL_STANDARD_LAYOUT_SUCCESS_OCR_DISABLED"
                        if p.returncode==0 and worker_out.is_file()
                        else "BLOCKED_STANDARD_LAYOUT_RUNTIME_PRIVATE_ERROR")
            except subprocess.TimeoutExpired as exc:
                rawlog=(exc.stdout or b"")+(exc.stderr or b"")
                rawlog=rawlog[:MAX_LOG]
                status="BLOCKED_STANDARD_LAYOUT_RUNTIME_TIMEOUT"
    details=None
    if status=="REAL_STANDARD_LAYOUT_SUCCESS_OCR_DISABLED":
        if worker_out.is_symlink() or worker_out.stat().st_size>MAX_JSON:
            raise VisualGateError("STANDARD_LAYOUT_WORKER_REPORT_UNSAFE")
        details=json.loads(worker_out.read_text("utf-8"))
        if (details.get("kind")!="REAL_DOCLING_STANDARD_OCR_OFF_LAYOUT_EXECUTED"
                or any(type(details.get(k)) is not int or details[k]<0 for k in
                       ("duration_ms","text_item_count","picture_item_count",
                        "table_item_count"))
                or not isinstance(details.get("markdown_private"),str)):
            raise VisualGateError("STANDARD_LAYOUT_WORKER_REPORT_INVALID")
    if rawlog is not None:
        _exclusive(log_path,rawlog)
    data={
        "schema_version":3,"evidence":EVIDENCE,"book_id":"B15",
        "physical_page":109,"corpus_id":parent["corpus_id"],
        "same_page_sha256_private":page_sha,
        "upstream_fallback_receipt_sha256_private":
            hashlib.sha256((folder/PARENT).read_bytes()).hexdigest(),
        "candidate_directory_count":len(candidates),
        "candidate_directory_label":candidates[0][0] if len(candidates)==1 else None,
        "status":status,
        "pipeline":"DOCLING_STANDARD_WITH_LAYOUT_MODEL_OCR_DISABLED",
        "ocr_enabled":False,"ocr_page_count":0,
        "actual_layout_success":status=="REAL_STANDARD_LAYOUT_SUCCESS_OCR_DISABLED",
        "private_worker_record_sha256":(
            hashlib.sha256(worker_out.read_bytes()).hexdigest()
            if worker_out.is_file() else None),
        "private_worker_log_sha256":(
            hashlib.sha256(log_path.read_bytes()).hexdigest()
            if log_path.is_file() else None),
        "duration_ms":details["duration_ms"] if details else None,
        "text_item_count":details["text_item_count"] if details else None,
        "picture_item_count":details["picture_item_count"] if details else None,
        "table_item_count":details["table_item_count"] if details else None,
        "markdown_character_count":len(details["markdown_private"]) if details else None,
        "markdown_sha256_private":hashlib.sha256(
            details["markdown_private"].encode("utf-8")).hexdigest() if details else None,
        "ground_truth":None,"cer":None,
        "layout_accuracy":None,
        "model_downloads":0,"provider_calls":0,
    }
    if write:
        _exclusive(output,(json.dumps(data,ensure_ascii=False,
                  sort_keys=True,separators=(",",":"))+"\n").encode("utf-8"))
    return data


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--private-root")
    p.add_argument("--manifest")
    p.add_argument("--write",action="store_true")
    p.add_argument("--audit-only",action="store_true")
    p.add_argument("--worker-pdf")
    p.add_argument("--worker-artifacts")
    p.add_argument("--worker-result")
    args=p.parse_args()
    if args.worker_pdf:
        if not args.worker_artifacts or not args.worker_result:
            raise VisualGateError("STANDARD_LAYOUT_WORKER_MISSING_ARGS")
        worker(args.worker_pdf,args.worker_artifacts,args.worker_result)
        return
    if not args.private_root or not args.manifest or args.write and args.audit_only:
        raise VisualGateError("STANDARD_LAYOUT_ARGUMENT_INVALID")
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    x=trial(Path(args.private_root),manifest,
            write=args.write,audit=args.audit_only)
    print("ACS_B15_LAYOUT_STATUS="+x["status"])
    print("ACS_B15_LAYOUT_CANDIDATE_COUNT="+str(x["candidate_directory_count"]))
    print("ACS_B15_LAYOUT_REAL_SUCCESS="+str(x["actual_layout_success"]).upper())
    # Only aggregate counts and duration: no OCR text, model paths, SHA or boxes.
    for key,label in (("duration_ms","DURATION_MS"),
                      ("text_item_count","TEXT_ITEMS"),
                      ("picture_item_count","PICTURE_ITEMS"),
                      ("table_item_count","TABLE_ITEMS"),
                      ("markdown_character_count","MARKDOWN_CHARACTERS")):
        value=x.get(key)
        print("ACS_B15_LAYOUT_"+label+"="+(
            str(value) if value is not None else "UNAVAILABLE"))
    print("ACS_B15_LAYOUT_OCR_PAGES=0")
    print("ACS_B15_LAYOUT_GOLD=UNVERIFIED")
    print("ACS_B15_LAYOUT_PAID_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,TypeError,ValueError,OSError,RuntimeError):
        print("ACS_B15_LAYOUT_REJECTED=PRIVATE_SOURCE_OR_RUNTIME_GATE")
        sys.exit(2)
