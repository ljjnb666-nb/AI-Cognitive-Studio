#!/usr/bin/env python3
"""Real B31 physical page 126, reusing validated historical MinerU 4.0.3.

Only uses the SHA-pinned *same original* single-page PDF already used by
Docling, the known old MinerU venv, and cached original ONNX weights in D:.
Does not install, download, call GLM or publish source page contents.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from ebook_multibook_native_matrix import audit_existing as audit_native, _private_folder
from ebook_multibook_docling_native import audit_existing as audit_docling
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b31_mineru403_flash_source_only.v2.private.json"
MARKDOWN="b31_mineru403_flash_p0126.v2.private.md"
PRIVATE_LOG="b31_mineru403_flash_execution.v2.private.log"
EVIDENCE="B31_ORIGINAL_PAGE126_MINERU403_LOCAL_FLASH_V2_NOT_GOLD"
MODEL_SUBDIR="MinerU-4_models_onnx"
MAX_REPORT=120_000
MAX_MARKDOWN=750_000
MAX_LOG=3_000_000
MAX_MODEL_FILES=32
MODEL_MIN_BYTES=100_000_000
MAX_TIME=720


def sha_file(path):
    digest=hashlib.sha256()
    with open(path,"rb") as f:
        while True:
            b=f.read(4*1024*1024)
            if not b: break
            digest.update(b)
    return digest.hexdigest()


def find_source(root,manifest):
    native=audit_native(root,manifest)
    docling=audit_docling(root,manifest)
    if native.get("selected_native_pages")!=24 or docling.get("docling_native_completed_pages")!=24:
        raise VisualGateError("MINERU403_SAME_SOURCE_BASELINE_NOT_VERIFIED")
    rows=[p for r in native["rows"] if r["book_id"]=="B31"
          for p in r["pages"] if p.get("physical_page")==126]
    docrows=[p for p in docling["pages"]
             if p.get("book_id")=="B31" and p.get("physical_page")==126]
    if len(rows)!=1 or len(docrows)!=1 or rows[0].get("ocr_focus_png") is None:
        raise VisualGateError("MINERU403_B31_PAGE126_NOT_SAME_FOCUS")
    stage=_private_folder(root)/"docling_native_single_pages"/"B31_p0126.private.pdf"
    if (not stage.is_file() or stage.is_symlink() or
            stage.stat().st_size<100 or stage.stat().st_size>35*1024*1024 or
            sha_file(stage)!=docrows[0]["staged_pdf_sha256"]):
        raise VisualGateError("MINERU403_B31_STAGE_PDF_SHA_MISMATCH")
    return stage, native, docrows[0]


def cache_inventory(root):
    root=Path(root)
    exe=root/"python"/"mineru"/"Scripts"/"mineru.exe"
    model=root/"cache"/"mineru"/"home"/"models"/MODEL_SUBDIR
    if (not exe.is_file() or exe.is_symlink() or
            not model.is_dir() or model.is_symlink()):
        raise VisualGateError("MINERU403_HISTORIC_RUNTIME_OR_CACHE_MISSING")
    candidates=[]
    for p in model.rglob("*.onnx"):
        if p.is_symlink() or not p.is_file():
            raise VisualGateError("MINERU403_CACHED_MODEL_SYMLINK_INVALID")
        if len(p.relative_to(model).parts)>5:
            continue
        if not 0<p.stat().st_size<3*1024*1024*1024:
            raise VisualGateError("MINERU403_MODEL_FILE_SIZE_INVALID")
        candidates.append(p)
        if len(candidates)>MAX_MODEL_FILES:
            raise VisualGateError("MINERU403_TOO_MANY_CACHED_WEIGHTS")
    if len(candidates)<5 or sum(p.stat().st_size for p in candidates)<MODEL_MIN_BYTES:
        raise VisualGateError("MINERU403_HISTORIC_ONNX_WEIGHTS_INCOMPLETE")
    digests={str(p.relative_to(model)).replace("\\","/"):sha_file(p)
             for p in sorted(candidates)}
    return exe,model,digests


def safe_environment(root):
    env=os.environ.copy()
    env.update({
        "MINERU_HOME":str(Path(root)/"cache"/"mineru"/"home"),
        "MINERU_MODEL_BASE_DIR":str(Path(root)/"cache"/"mineru"/"home"/"models"),
        "MINERU_MODEL_SOURCE":"local",
        "HF_HUB_OFFLINE":"1",
        "TRANSFORMERS_OFFLINE":"1",
        "HF_HUB_DISABLE_TELEMETRY":"1",
        "DO_NOT_TRACK":"1",
        "HTTP_PROXY":"http://127.0.0.1:1",
        "HTTPS_PROXY":"http://127.0.0.1:1",
        "ALL_PROXY":"http://127.0.0.1:1",
        "NO_PROXY":"",
        "PYTHONNOUSERSITE":"1",
    })
    return env


def _exclusive(path,raw):
    flags=os.O_CREAT|os.O_WRONLY|os.O_EXCL
    if hasattr(os,"O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as f:
        f.write(raw)


def capture(root,manifest,*,write=False,runner=None):
    stage,native,docling_page=find_source(root,manifest)
    exe,model,before=cache_inventory(root)
    folder=_private_folder(root)
    output=folder/REPORT
    mdfile=folder/MARKDOWN
    logfile=folder/PRIVATE_LOG
    if any(f.exists() or f.is_symlink() for f in (output,mdfile,logfile)):
        raise VisualGateError("MINERU403_PRIOR_RESULT_OR_PARTIAL_OUTPUT_EXISTS")
    if not write:
        return {
            "preflight":"HISTORICAL_MINERU403_EXECUTABLE_AND_MODELS_PRESENT",
            "page":126,"cached_onnx_weight_count":len(before),
            "actual_inference":False,
        }
    start=time.perf_counter()
    env=safe_environment(root)
    command=[
        str(exe),"parse",str(stage),"--tier","flash",
        "--pages","all","--output",str(mdfile),
    ]
    try:
        # The actual MinerU 4.0.3 process reads a single-page PDF ONLY.
        # Both stdout and stderr go to private D:, never GitHub logs.
        with open(logfile,"xb") as log:
            if runner is None:
                proc=subprocess.run(command,env=env,cwd=folder,
                    stdout=log,stderr=subprocess.STDOUT,timeout=MAX_TIME,
                    check=False)
                rc=proc.returncode
            else:
                rc=runner(command,env,logfile)
    except subprocess.TimeoutExpired as exc:
        raise VisualGateError("MINERU403_TRUE_OFFLINE_INFERENCE_TIMEOUT") from exc
    if rc!=0:
        raise VisualGateError("MINERU403_TRUE_OFFLINE_INFERENCE_FAILED")
    duration=round((time.perf_counter()-start)*1000)
    if (not mdfile.is_file() or mdfile.is_symlink() or
            not 0<mdfile.stat().st_size<=MAX_MARKDOWN or
            logfile.stat().st_size>MAX_LOG):
        raise VisualGateError("MINERU403_EXPECTED_MARKDOWN_MISSING_OR_LARGE")
    after={str(p.relative_to(model)).replace("\\","/"):sha_file(p)
           for p in model.rglob("*.onnx") if p.is_file()}
    if before!=after:
        raise VisualGateError("MINERU403_CACHED_MODELS_CHANGED_DURING_INFERENCE")
    markdown=mdfile.read_text("utf-8")
    if any(ord(c)==0 for c in markdown):
        raise VisualGateError("MINERU403_NON_TEXT_MARKDOWN")
    report={
        "schema_version":1,
        "evidence":EVIDENCE,
        "corpus_id":native["corpus_id"],
        "book_id":"B31",
        "physical_page":126,
        "original_document_sha256":docling_page["original_pdf_sha256"],
        "staged_page_sha256":sha_file(stage),
        "same_source_as_docling_native":True,
        "historical_executable_sha256":sha_file(exe),
        "model_file_sha256_private":before,
        "model_file_count":len(before),
        "model_cache_unchanged":True,
        "tier":"flash",
        "model_source":"local",
        "duration_ms":duration,
        "markdown_size_bytes":mdfile.stat().st_size,
        "markdown_sha256":sha_file(mdfile),
        "stdout_stderr_sha256":sha_file(logfile),
        "exit_code":0,
        "actual_inference":True,
        "source_text_stays_private":True,
        "ocr_quality_gold":None,
        "layout_quality_gold":None,
        "graph_quality_gold":None,
        "provider_calls":0,
        "model_downloads":0,
    }
    raw=(json.dumps(report,ensure_ascii=False,sort_keys=True,
                    separators=(",",":"))+"\n").encode("utf-8")
    if len(raw)>MAX_REPORT:
        raise VisualGateError("MINERU403_PRIVATE_RECEIPT_TOO_LARGE")
    _exclusive(output,raw)
    return report


def audit_existing(root,manifest):
    stage,native,docling_page=find_source(root,manifest)
    folder=_private_folder(root)
    receipt,md,log=(folder/REPORT,folder/MARKDOWN,folder/PRIVATE_LOG)
    if any(p.is_symlink() or not p.is_file() for p in (receipt,md,log)):
        raise VisualGateError("MINERU403_COMPLETE_PRIVATE_RECEIPT_MISSING")
    if (not 0<receipt.stat().st_size<=MAX_REPORT or
            not 0<md.stat().st_size<=MAX_MARKDOWN or
            log.stat().st_size>MAX_LOG):
        raise VisualGateError("MINERU403_PRIVATE_OUTPUT_SIZE_INVALID")
    try:
        data=json.loads(receipt.read_text("utf-8"),
                        object_pairs_hook=no_duplicate_keys,
                        parse_constant=reject_constant)
    except (TypeError,UnicodeError,ValueError):
        raise VisualGateError("MINERU403_PRIVATE_RECEIPT_JSON_INVALID") from None
    if (not isinstance(data,dict) or
            data.get("schema_version")!=1 or data.get("evidence")!=EVIDENCE or
            data.get("corpus_id")!=native["corpus_id"] or
            data.get("book_id")!="B31" or
            type(data.get("physical_page")) is not int or data["physical_page"]!=126 or
            data.get("original_document_sha256")!=docling_page["original_pdf_sha256"] or
            data.get("staged_page_sha256")!=sha_file(stage) or
            data.get("markdown_sha256")!=sha_file(md) or
            data.get("stdout_stderr_sha256")!=sha_file(log) or
            data.get("markdown_size_bytes")!=md.stat().st_size or
            data.get("exit_code")!=0 or
            data.get("tier")!="flash" or data.get("model_source")!="local" or
            data.get("same_source_as_docling_native") is not True or
            data.get("actual_inference") is not True or
            data.get("model_cache_unchanged") is not True or
            data.get("source_text_stays_private") is not True or
            data.get("provider_calls")!=0 or data.get("model_downloads")!=0 or
            data.get("ocr_quality_gold",object()) is not None or
            data.get("layout_quality_gold",object()) is not None or
            data.get("graph_quality_gold",object()) is not None):
        raise VisualGateError("MINERU403_RECEIPT_PROVENANCE_INVALID")
    exe,model,files=cache_inventory(root)
    if (data.get("historical_executable_sha256")!=sha_file(exe) or
            data.get("model_file_sha256_private")!=files or
            data.get("model_file_count")!=len(files)):
        raise VisualGateError("MINERU403_RECEIPT_MODEL_SOURCE_CHANGED")
    return data


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    x=parser.add_mutually_exclusive_group()
    x.add_argument("--write",action="store_true")
    x.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    result=(audit_existing(Path(args.private_root),manifest)
            if args.audit_only
            else capture(Path(args.private_root),manifest,write=args.write))
    if args.audit_only:
        status="PRIVATE_RECEIPT_VERIFIED"
    elif args.write:
        status="REAL_OFFLINE_INFERENCE_CREATED"
    else:
        status="READONLY_MODEL_AND_SOURCE_PREFLIGHT"
    print("ACS_MINERU403_STATUS="+status)
    print("ACS_MINERU403_SAME_ORIGINAL_PHYSICAL_PAGE=126")
    print("ACS_MINERU403_BUNDLED_ONNX_MODELS="+str(
        result.get("model_file_count",result.get("cached_onnx_weight_count"))))
    print("ACS_MINERU403_INFERENCE_VERIFIED="+str(
        result.get("actual_inference",False)).upper())
    if "duration_ms" in result:
        print("ACS_MINERU403_DURATION_MS="+str(result["duration_ms"]))
        print("ACS_MINERU403_PRIVATE_MARKDOWN_BYTES="+str(result["markdown_size_bytes"]))
    print("ACS_MINERU403_GOLD=UNVERIFIED")
    print("ACS_MINERU403_CLOUD_PROVIDER_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,OSError,TypeError,ValueError,RuntimeError) as e:
        print("ACS_MINERU403_REJECTED="+(
            e.code if isinstance(e,VisualGateError) else type(e).__name__))
        sys.exit(2)
