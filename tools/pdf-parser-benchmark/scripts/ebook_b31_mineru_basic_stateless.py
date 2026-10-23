#!/usr/bin/env python3
"""One original B31 physical page through MinerU 4.0.3 stateless Basic ONNX OCR.

Unlike the failed 'mineru parse' doc-library attempts, this uses the
documented 'mineru-kit parse' direct conversion entrypoint. A previously
verified local Basic ONNX bundle is mandatory. No download, cloud or GLM.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from ebook_b31_mineru403_reuse import (
    find_source, cache_inventory, safe_environment, sha_file
)
from ebook_mineru403_failure_triage import audit_existing as audit_triage
from ebook_multibook_native_matrix import _private_folder
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b31_mineru403_basic_onnx_stateless.private.json"
MARKDOWN="b31_mineru403_basic_onnx_stateless.private.md"
LOG="b31_mineru403_basic_onnx_stateless.private.log"
EVIDENCE="B31_REAL_PAGE126_MINERU403_KIT_BASIC_ONNX_OCR_NOT_GOLD"
MAX_REPORT=150_000
MAX_MD=1_500_000
MAX_LOG=2_000_000
MAX_TIME=900


def _exclusive(path, raw):
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
    if hasattr(os,"O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as f:
        f.write(raw)


def prerequisites(root,manifest):
    source,native,docrow=find_source(root,manifest)
    triage=audit_triage(root,manifest)
    basic=triage.get("basic_model_probe")
    if (not isinstance(basic,dict) or basic.get("kit_present") is not True or
            basic.get("models_verify_ran") is not True or
            basic.get("basic_models_verified") is not True or
            triage.get("new_mineru_parse_calls")!=0):
        raise VisualGateError("MINERU_BASIC_OFFLINE_MODEL_VERIFICATION_REQUIRED")
    exe,_,models=cache_inventory(root)
    kit=exe.with_name("mineru-kit.exe")
    if not kit.is_file() or kit.is_symlink():
        raise VisualGateError("MINERU_BASIC_STATELESS_KIT_NOT_FOUND")
    folder=_private_folder(root)
    report=folder/REPORT
    md=folder/MARKDOWN
    log=folder/LOG
    if any(p.exists() or p.is_symlink() for p in (report,md,log)):
        raise VisualGateError("MINERU_BASIC_PRIOR_OR_PARTIAL_OUTPUT_EXISTS")
    return source,native,docrow,kit,models,folder


def run(root,manifest,*,write=False,runner=None):
    src,native,docrow,kit,models,folder=prerequisites(root,manifest)
    if not write:
        return {"real_inference":False,"basic_models_verified":True,
                "book_id":"B31","physical_page":126,"onnx_weight_count":len(models)}
    md,log,report=folder/MARKDOWN,folder/LOG,folder/REPORT
    env=safe_environment(root)
    env["MINERU_MODEL_SMALL_BACKEND"]="onnx"
    env["MINERU_TABLE_DEVICE"]="cpu"
    cmd=[str(kit),"parse",str(src),"-o",str(md),
         "--tier","basic","--ocr-mode","ocr"]
    start=time.perf_counter()
    try:
        with open(log,"xb") as output:
            if runner is None:
                rc=subprocess.run(cmd,cwd=folder,env=env,stdout=output,
                    stderr=subprocess.STDOUT,timeout=MAX_TIME,check=False).returncode
            else:
                rc=runner(cmd,env,log)
    except subprocess.TimeoutExpired:
        raise VisualGateError("MINERU_BASIC_OFFLINE_PROCESS_TIMEOUT") from None
    if rc!=0:
        raise VisualGateError("MINERU_BASIC_REAL_INFERENCE_FAILED")
    duration=round((time.perf_counter()-start)*1000)
    if (not md.is_file() or md.is_symlink() or
            not 0<md.stat().st_size<=MAX_MD or
            log.stat().st_size>MAX_LOG):
        raise VisualGateError("MINERU_BASIC_OUTPUT_MISSING_OR_OVERSIZE")
    content=md.read_text("utf-8")
    if not content.strip() or "\x00" in content:
        raise VisualGateError("MINERU_BASIC_MARKDOWN_EMPTY_OR_NOT_TEXT")
    _,_,after=cache_inventory(root)
    if after!=models:
        raise VisualGateError("MINERU_BASIC_ORIGINAL_MODEL_CACHE_CHANGED")
    if sha_file(src)!=docrow["staged_pdf_sha256"]:
        raise VisualGateError("MINERU_BASIC_ORIGINAL_PAGE_CHANGED")
    data={
        "schema_version":1,
        "evidence":EVIDENCE,
        "corpus_id":native["corpus_id"],
        "book_id":"B31","physical_page":126,
        "source_document_sha256":docrow["original_pdf_sha256"],
        "same_source_as_docling_native":True,
        "source_page_sha256":docrow["staged_pdf_sha256"],
        "engine_version":"4.0.3",
        "entrypoint":"mineru-kit parse",
        "tier":"basic",
        "ocr_mode":"ocr",
        "small_backend":"onnx",
        "model_source":"local",
        "verified_basic_onnx_models":True,
        "cached_model_sha256_private":models,
        "model_files_count":len(models),
        "real_inference":True,
        "duration_ms":duration,
        "markdown_byte_count":md.stat().st_size,
        "markdown_character_count":len(content),
        "markdown_sha256_private":sha_file(md),
        "private_execution_log_sha256":sha_file(log),
        "exit_code":0,
        "model_downloads":0,
        "paid_provider_calls":0,
        "ocr_quality_gold":None,
        "layout_quality_gold":None,
        "graph_quality_gold":None,
    }
    payload=(json.dumps(data,ensure_ascii=False,
                        sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
    if len(payload)>MAX_REPORT:
        raise VisualGateError("MINERU_BASIC_RECEIPT_TOO_LARGE")
    _exclusive(report,payload)
    return data


def audit_existing(root,manifest):
    src,native,docrow=find_source(root,manifest)
    triage=audit_triage(root,manifest)
    if triage.get("basic_model_probe",{}).get("basic_models_verified") is not True:
        raise VisualGateError("MINERU_BASIC_MODEL_VERIFY_STATE_CHANGED")
    _,_,models=cache_inventory(root)
    folder=_private_folder(root)
    p,md,log=folder/REPORT,folder/MARKDOWN,folder/LOG
    if any(x.is_symlink() or not x.is_file() for x in (p,md,log)):
        raise VisualGateError("MINERU_BASIC_PRIVATE_RECEIPT_MISSING")
    if (not 0<p.stat().st_size<=MAX_REPORT or
            not 0<md.stat().st_size<=MAX_MD or
            log.stat().st_size>MAX_LOG):
        raise VisualGateError("MINERU_BASIC_PRIVATE_RECEIPT_SIZE_INVALID")
    try:
        data=json.loads(p.read_text("utf-8"),object_pairs_hook=no_duplicate_keys,
                        parse_constant=reject_constant)
    except (ValueError,UnicodeError,TypeError):
        raise VisualGateError("MINERU_BASIC_PRIVATE_RECEIPT_JSON_INVALID") from None
    if (not isinstance(data,dict) or data.get("schema_version")!=1 or
            data.get("evidence")!=EVIDENCE or
            data.get("corpus_id")!=native["corpus_id"] or
            data.get("book_id")!="B31" or
            type(data.get("physical_page")) is not int or data["physical_page"]!=126 or
            data.get("source_document_sha256")!=docrow["original_pdf_sha256"] or
            data.get("source_page_sha256")!=sha_file(src) or
            data.get("same_source_as_docling_native") is not True or
            data.get("engine_version")!="4.0.3" or
            data.get("entrypoint")!="mineru-kit parse" or
            data.get("tier")!="basic" or data.get("ocr_mode")!="ocr" or
            data.get("small_backend")!="onnx" or data.get("model_source")!="local" or
            data.get("verified_basic_onnx_models") is not True or
            data.get("cached_model_sha256_private")!=models or
            data.get("model_files_count")!=len(models) or
            data.get("real_inference") is not True or
            data.get("exit_code")!=0 or
            type(data.get("duration_ms")) is not int or data["duration_ms"]<0 or
            data.get("markdown_byte_count")!=md.stat().st_size or
            data.get("markdown_sha256_private")!=sha_file(md) or
            data.get("private_execution_log_sha256")!=sha_file(log) or
            data.get("model_downloads")!=0 or data.get("paid_provider_calls")!=0 or
            data.get("ocr_quality_gold",object()) is not None or
            data.get("layout_quality_gold",object()) is not None or
            data.get("graph_quality_gold",object()) is not None):
        raise VisualGateError("MINERU_BASIC_PRIVATE_PROVENANCE_INVALID")
    if (data.get("markdown_character_count")!=len(md.read_text("utf-8")) or
            not md.read_text("utf-8").strip()):
        raise VisualGateError("MINERU_BASIC_PRIVATE_MARKDOWN_COUNT_INVALID")
    return data


def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument("--private-root",required=True)
    p.add_argument("--manifest",required=True)
    opts=p.add_mutually_exclusive_group()
    opts.add_argument("--write",action="store_true")
    opts.add_argument("--audit-only",action="store_true")
    args=p.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    if args.audit_only:
        data=audit_existing(Path(args.private_root),manifest)
    else:
        data=run(Path(args.private_root),manifest,write=args.write)
    print("ACS_MINERU_BASIC_STATUS="+(
        "REAL_INFERENCE_CREATED" if args.write else
        "RECEIPT_VERIFIED" if args.audit_only else "READONLY_MODELS_READY"))
    print("ACS_MINERU_BASIC_SOURCE_PAGE=126")
    print("ACS_MINERU_BASIC_MODEL_FILES="+str(
        data.get("model_files_count",data.get("onnx_weight_count"))))
    print("ACS_MINERU_BASIC_REAL_INFERENCE="+str(data["real_inference"]).upper())
    if "markdown_character_count" in data:
        print("ACS_MINERU_BASIC_MARKDOWN_CHARS="+str(data["markdown_character_count"]))
        print("ACS_MINERU_BASIC_DURATION_MS="+str(data["duration_ms"]))
    print("ACS_MINERU_BASIC_OCR_ACCURACY=UNVERIFIED")
    print("ACS_MINERU_BASIC_CLOUD_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,TypeError,OSError,RuntimeError) as e:
        print("ACS_MINERU_BASIC_REJECTED="+(
            e.code if isinstance(e,VisualGateError) else type(e).__name__))
        sys.exit(2)
