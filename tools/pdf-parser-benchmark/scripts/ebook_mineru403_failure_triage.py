#!/usr/bin/env python3
"""Offline, non-inference diagnosis of TWO preserved failed MinerU 4.0.3 runs.

Never prints raw CLI output, source paths, page text, provider keys or
model filenames. Cannot change or delete either preserved failure log.
May run ONLY MinerU's offline 'models verify' introspection, not 'parse'.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from ebook_b31_mineru403_reuse import (
    find_source,cache_inventory,safe_environment,sha_file
)
from ebook_multibook_native_matrix import _private_folder
from ebook_private_graph_receipt_audit import no_duplicate_keys,reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b31_mineru403_failure_triage.private.json"
VERIFY_LOG="b31_mineru403_basic_models_verify.private.log"
PREVIOUS_LOGS=(
    "b31_mineru403_flash_execution.private.log",
    "b31_mineru403_flash_execution.v2.private.log",
)
EVIDENCE="B31_TWO_FAILED_MINERU403_RUNS_OFFLINE_READONLY_TRIAGE"
MAX_LOG=3_000_000
MAX_REPORT=25_000

# Fixed names only: even malformed/private model paths cannot become output.
CLASSES=(
    ("CLI_ARGUMENT_REJECTED",r"no such option|unrecognized arguments|unexpected extra argument|unknown option|invalid (choice|option)|bad parameter"),
    ("MISSING_IMPORT_OR_DLL",r"ModuleNotFoundError|No module named|ImportError|DLL load failed|cannot import name"),
    ("MISSING_MODEL_OR_CONFIG",r"model.+(not found|does not exist|missing|unavailable)|missing.+model|config.+(not found|missing)|No such file or directory"),
    ("OFFLINE_NETWORK_REQUEST_ATTEMPTED",r"ConnectionError|ConnectError|ProxyError|Failed to establish a new connection|https?://.*(timeout|failed)"),
    ("UNSUPPORTED_RUNTIME_BACKEND",r"ExecutionProvider.+(unavailable|missing|failed)|CUDA.+(not available|failed)|backend.+(unavailable|unsupported)"),
    ("PERMISSION_OR_FILE_ACCESS",r"PermissionError|Access is denied|access denied|Permission denied"),
    ("OUTPUT_EXISTS_OR_INVALID",r"(output|target).+(exists|invalid|directory|file)"),
    ("PARSER_EXECUTION_FAILURE",r"RuntimeError|ParseError|parsing failed|document parsing failed"),
)
EXCEPTION_NAMES=(
    "ModuleNotFoundError","ImportError","FileNotFoundError","PermissionError",
    "RuntimeError","ValueError","TypeError","KeyError","IndexError",
    "AttributeError","OSError","AssertionError","SystemExit","ValidationError",
    "BadParameter","BadOptionUsage","CalledProcessError","ConfigError",
)


def _fingerprint(path,*,allow_empty=False):
    if (path.is_symlink() or not path.is_file() or
            not (0 if allow_empty else 1)<=path.stat().st_size<=MAX_LOG):
        raise VisualGateError("MINERU_TRIAGE_FAILURE_LOG_MISSING_OR_UNSAFE")
    return sha_file(path)


def classify_private_bytes(content):
    """Text never leaves this function. Public statuses are allowlisted."""
    if len(content)>MAX_LOG:
        raise VisualGateError("MINERU_TRIAGE_LOG_EXCEEDS_LIMIT")
    s=content.decode("utf-8",errors="replace")
    matched=[label for label,pattern in CLASSES
             if re.search(pattern,s,re.IGNORECASE)]
    exception_names=[name for name in EXCEPTION_NAMES
                     if re.search(r"(?<![A-Za-z])"+re.escape(name)+r"(?![A-Za-z])",s)]
    return {
        "categories":matched or ["UNKNOWN_FAILURE_PRIVATE_DETAILS_ONLY"],
        "known_exception_classes":exception_names,
        "contains_traceback":("Traceback (most recent call last)" in s),
        "contains_cli_usage":bool(re.search(r"\busage:\s*(mineru|mineru-kit)",s,re.I)),
        "utf8_decoding_errors":s.count("\ufffd"),
        "log_byte_count":len(content),
        # Source SHA stored ONLY in private file, not GitHub.
        "private_log_sha256":hashlib.sha256(content).hexdigest(),
    }


def find_old_failures(root):
    folder=_private_folder(root)
    logs=[]
    for name in PREVIOUS_LOGS:
        p=folder/name
        digest=_fingerprint(p)
        rows=classify_private_bytes(p.read_bytes())
        if rows["private_log_sha256"]!=digest:
            raise VisualGateError("MINERU_TRIAGE_LOG_CHANGED_DURING_READ")
        logs.append({"attempt":len(logs)+1,**rows})
    for successful in (
        "b31_mineru403_flash_source_only.private.json",
        "b31_mineru403_flash_source_only.v2.private.json",
    ):
        if (folder/successful).exists():
            raise VisualGateError("MINERU_TRIAGE_PREVIOUS_RUN_WAS_SUCCESSFUL")
    return logs


def model_probe(root,exe,*,write=False,runner=None):
    folder=_private_folder(root)
    kit=exe.with_name("mineru-kit.exe")
    log=folder/VERIFY_LOG
    if log.exists() or log.is_symlink():
        raise VisualGateError("MINERU_TRIAGE_VERIFY_LOG_ALREADY_EXISTS")
    if not kit.is_file() or kit.is_symlink():
        return {"kit_present":False,"models_verify_ran":False,
                "basic_models_verified":False,
                "verify_exit_code":None,"private_verify_log_sha256":None}
    if not write:
        return {"kit_present":True,"models_verify_ran":False,
                "basic_models_verified":False,
                "verify_exit_code":None,"private_verify_log_sha256":None}
    # Documented 'models verify' is read-only and returns nonzero for missing
    # cached assets. No '--download', 'parse', 'index' or network provider.
    argv=[str(kit),"models","verify","--tier","basic",
          "--small-backend","onnx"]
    env=safe_environment(root)
    env["MINERU_MODEL_SMALL_BACKEND"]="onnx"
    with open(log,"xb") as output:
        if runner is None:
            try:
                completed=subprocess.run(argv,env=env,cwd=folder,
                    stdout=output,stderr=subprocess.STDOUT,timeout=120,check=False)
            except subprocess.TimeoutExpired:
                raise VisualGateError("MINERU_TRIAGE_MODELS_VERIFY_TIMEOUT") from None
            code=completed.returncode
        else:
            code=runner(argv,env,log)
    if type(code) is not int or not -128<=code<=255:
        raise VisualGateError("MINERU_TRIAGE_VERIFY_STATUS_INVALID")
    return {
        "kit_present":True,"models_verify_ran":True,
        "basic_models_verified":code==0,
        "verify_exit_code":code,
        "private_verify_log_sha256":_fingerprint(log,allow_empty=True),
        "verify_diagnostic":classify_private_bytes(log.read_bytes())["categories"]
    }


def run(root,manifest,*,write=False,runner=None):
    _,native,_=find_source(root,manifest)
    exe,_,initial_models=cache_inventory(root)
    folder=_private_folder(root)
    report=folder/REPORT
    if report.exists() or report.is_symlink():
        raise VisualGateError("MINERU_TRIAGE_REPORT_ALREADY_EXISTS")
    earlier=find_old_failures(root)
    probe=model_probe(root,exe,write=write,runner=runner)
    _,_,after_models=cache_inventory(root)
    if initial_models!=after_models:
        raise VisualGateError("MINERU_TRIAGE_MODEL_WEIGHTS_CHANGED")
    if earlier!=find_old_failures(root):
        raise VisualGateError("MINERU_TRIAGE_HISTORICAL_LOGS_CHANGED")
    result={
        "schema_version":1,
        "evidence":EVIDENCE,
        "corpus_id":native["corpus_id"],
        "book_id":"B31","physical_page":126,
        "model_weight_count":len(initial_models),
        "model_onnx_sha256_private":initial_models,
        "old_failures":earlier,
        "basic_model_probe":probe,
        "source_book_text_read":False,
        "new_mineru_parse_calls":0,
        "model_downloads":0,
        "paid_provider_calls":0,
        "ocr_accuracy_gold":None,
        "graph_accuracy_gold":None,
    }
    raw=(json.dumps(result,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
    if len(raw)>MAX_REPORT:
        raise VisualGateError("MINERU_TRIAGE_REPORT_TOO_LARGE")
    if write:
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(report,flags,0o600),"wb") as f:
            f.write(raw)
    return result


def audit_existing(root,manifest):
    _,native,_=find_source(root,manifest)
    exe,_,weights=cache_inventory(root)
    folder=_private_folder(root)
    p=folder/REPORT
    if p.is_symlink() or not p.is_file() or not 0<p.stat().st_size<=MAX_REPORT:
        raise VisualGateError("MINERU_TRIAGE_PRIVATE_REPORT_MISSING")
    try:
        data=json.loads(p.read_text("utf-8"),object_pairs_hook=no_duplicate_keys,
                        parse_constant=reject_constant)
    except (ValueError,TypeError,UnicodeError):
        raise VisualGateError("MINERU_TRIAGE_REPORT_JSON_INVALID") from None
    if (not isinstance(data,dict) or data.get("schema_version")!=1 or
            data.get("evidence")!=EVIDENCE or
            data.get("corpus_id")!=native["corpus_id"] or
            data.get("book_id")!="B31" or
            data.get("physical_page")!=126 or
            data.get("model_onnx_sha256_private")!=weights or
            data.get("model_weight_count")!=len(weights) or
            data.get("old_failures")!=find_old_failures(root) or
            data.get("new_mineru_parse_calls")!=0 or
            data.get("model_downloads")!=0 or
            data.get("paid_provider_calls")!=0 or
            data.get("source_book_text_read") is not False or
            data.get("ocr_accuracy_gold",object()) is not None or
            data.get("graph_accuracy_gold",object()) is not None):
        raise VisualGateError("MINERU_TRIAGE_PRIVATE_RECEIPT_INVALID")
    probe=data.get("basic_model_probe")
    if not isinstance(probe,dict) or type(probe.get("kit_present")) is not bool or type(probe.get("models_verify_ran")) is not bool:
        raise VisualGateError("MINERU_TRIAGE_VERIFY_PROVENANCE_INVALID")
    if probe.get("models_verify_ran"):
        logfile=folder/VERIFY_LOG
        if (not logfile.is_file() or logfile.is_symlink() or
                probe.get("private_verify_log_sha256")!=_fingerprint(logfile,allow_empty=True)):
            raise VisualGateError("MINERU_TRIAGE_VERIFY_LOG_CHANGED")
    return data


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    ops=parser.add_mutually_exclusive_group()
    ops.add_argument("--write",action="store_true")
    ops.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    if args.audit_only:
        report=audit_existing(Path(args.private_root),manifest)
    else:
        report=run(Path(args.private_root),manifest,write=args.write)
    print("ACS_MINERU_TRIAGE_STATUS="+(
        "PRIVATE_CREATED" if args.write else
        "RECEIPT_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_MINERU_TRIAGE_PRIOR_FAILED_RUNS="+str(len(report["old_failures"])))
    for row in report["old_failures"]:
        print("ACS_MINERU_TRIAGE_ATTEMPT_"+str(row["attempt"])+"_CLASS="+
              "|".join(row["categories"]))
        print("ACS_MINERU_TRIAGE_ATTEMPT_"+str(row["attempt"])+"_EXCEPTIONS="+
              "|".join(row["known_exception_classes"]))
    probe=report["basic_model_probe"]
    print("ACS_MINERU_TRIAGE_KIT_AVAILABLE="+str(probe["kit_present"]).upper())
    print("ACS_MINERU_TRIAGE_BASIC_MODEL_VERIFY_RAN="+str(probe["models_verify_ran"]).upper())
    print("ACS_MINERU_TRIAGE_BASIC_MODELS_VERIFIED="+str(probe["basic_models_verified"]).upper())
    print("ACS_MINERU_TRIAGE_NEW_PARSE_CALLS=0")
    print("ACS_MINERU_TRIAGE_MODEL_DOWNLOADS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,TypeError,ValueError,OSError,RuntimeError) as e:
        print("ACS_MINERU_TRIAGE_REJECTED="+(
            e.code if isinstance(e,VisualGateError) else type(e).__name__))
        sys.exit(2)
