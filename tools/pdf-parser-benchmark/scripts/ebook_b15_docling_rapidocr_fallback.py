#!/usr/bin/env python3
"""Offline Docling Standard+RapidOCR candidate audit; no inference/download.

Works around missing Tesseract prerequisite, but STILL requires independently
verified Docling Standard layout model assets and an actual conversion run.
"""
import argparse
import hashlib
from importlib import metadata, util
import json
import os
from pathlib import Path
import sys

from ebook_b15_docling_standard_readiness import (
    execute as audit_standard, VERSION as DOCLING_VERSION,
    REPORT as STANDARD_REPORT,
)
from ebook_multibook_native_matrix import _private_folder
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b15_docling_standard_rapidocr_fallback.v2.private.json"
EVIDENCE="B15_DOCLING_STANDARD_RAPIDOCR_ALTERNATIVE_READINESS_NOT_ACTUAL_OCR"
MAX_REPORT=25000
EXPECTED_RAPID="3.9.2"
EXPECTED_ONNX="1.22.1"
MAX_WEIGHT=150_000_000


def _version(name):
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def rapidocr_probe(root):
    versions={"rapidocr":_version("rapidocr"),
              "onnxruntime":_version("onnxruntime")}
    spec=util.find_spec("rapidocr")
    output={"versions":versions,"package_on_private_volume":False,
            "bundled_det":False,"bundled_rec":False,
            "bundled_model_count":0}
    if spec is None or not spec.origin:
        return output
    file=Path(spec.origin)
    # Verify package remains inside the private root/explicit Docling
    # environment. Do not follow injected symlink package paths.
    if (file.is_symlink() or any(x.is_symlink() for x in file.parents
                                if x!=Path(root) and Path(root) in x.parents)
            or not file.is_file()):
        raise VisualGateError("DOCLING_RAPID_PACKAGE_PATH_UNSAFE")
    if not file.resolve().is_relative_to(Path(root).resolve()):
        return output
    output["package_on_private_volume"]=True
    models=file.parent/"models"
    if models.is_symlink() or not models.is_dir():
        return output
    items=list(models.glob("*.onnx"))
    if len(items)>32:
        raise VisualGateError("DOCLING_RAPID_MODEL_COUNT_EXCEEDED")
    labels=set()
    for model in items:
        if (model.is_symlink() or not model.is_file() or
                not 10000<model.stat().st_size<=MAX_WEIGHT):
            raise VisualGateError("DOCLING_RAPID_WEIGHT_UNSAFE")
        for kind in ("det","rec"):
            if kind in model.name.lower():
                labels.add(kind)
    output["bundled_model_count"]=len(items)
    output["bundled_det"]="det" in labels
    output["bundled_rec"]="rec" in labels
    return output


def calculate_status(standard,rapid):
    if standard.get("docling_installed_version")!=DOCLING_VERSION:
        return "BLOCKED_DOCLING_PACKAGE_VERSION"
    if rapid.get("versions",{}).get("rapidocr")!=EXPECTED_RAPID:
        return "BLOCKED_DOCLING_ENV_RAPIDOCR_PACKAGE_VERSION"
    if rapid["versions"].get("onnxruntime")!=EXPECTED_ONNX:
        return "BLOCKED_DOCLING_ENV_ONNXRUNTIME_PACKAGE_VERSION"
    if not (rapid.get("package_on_private_volume") and
            rapid.get("bundled_det") and rapid.get("bundled_rec")):
        return "BLOCKED_DOCLING_ENV_BUNDLED_RAPIDOCR_MODELS"
    inventory=standard.get("private_candidate_artifact_inventory")
    if not isinstance(inventory,list):
        raise VisualGateError("DOCLING_RAPID_LAYOUT_INVENTORY_MISSING")
    if not any(x.get("model_weight_files",0)>0 and x.get("config_files",0)>0
               for x in inventory if isinstance(x,dict)):
        return "BLOCKED_DOCLING_STANDARD_LAYOUT_ARTIFACTS"
    return "CANDIDATE_ONLY_STANDARD_PIPELINE_RUNTIME_UNVERIFIED"


def compute(root,manifest,*,probe_fn=rapidocr_probe):
    parent=audit_standard(root,manifest,audit=True)
    if (parent.get("book_id")!="B15" or parent.get("physical_page")!=109
            or parent.get("docling_standard_ocr_pages_executed")!=0
            or parent.get("docling_native_is_not_standard") is not True
            or parent.get("cer",object()) is not None or
            parent.get("provider_calls")!=0):
        raise VisualGateError("DOCLING_RAPID_PRIOR_SOURCE_INVALID")
    rapid=probe_fn(Path(root))
    if (not isinstance(rapid,dict) or
            set(rapid)!={"versions","package_on_private_volume",
                         "bundled_det","bundled_rec","bundled_model_count"} or
            not isinstance(rapid["versions"],dict) or
            set(rapid["versions"])!={"rapidocr","onnxruntime"} or
            any(not isinstance(rapid[k],bool) for k in (
                "package_on_private_volume","bundled_det","bundled_rec")) or
            type(rapid["bundled_model_count"]) is not int or
            not 0<=rapid["bundled_model_count"]<=32):
        raise VisualGateError("DOCLING_RAPID_PROBE_SHAPE_INVALID")
    status=calculate_status(parent,rapid)
    folder=_private_folder(root)
    return {"schema_version":2,"evidence":EVIDENCE,
            "book_id":"B15","physical_page":109,
            "corpus_id":parent["corpus_id"],
            "original_single_page_pdf_sha256_private":
                parent["same_single_page_pdf_sha256_private"],
            "v1_readiness_sha256_private":hashlib.sha256(
                (folder/STANDARD_REPORT).read_bytes()).hexdigest(),
            "rapidocr_candidate":rapid,
            "standard_layout_artifact_count_candidates":sum(
                int(x.get("model_weight_files",0)>0 and
                    x.get("config_files",0)>0)
                for x in parent["private_candidate_artifact_inventory"]),
            "status":status,"standard_pipeline_initialized":False,
            "standard_ocr_pages_executed":0,
            "rapidocr_models_inference_executed":False,
            "independent_reference":None,"cer":None,
            "which_engine_is_correct":None,
            "new_model_inference_calls":0,"model_downloads":0,
            "provider_calls":0}


def execute(root,manifest,*,write=False,audit=False,**kwargs):
    folder=_private_folder(root)
    path=folder/REPORT
    if not audit and (path.exists() or path.is_symlink()):
        raise VisualGateError("DOCLING_RAPID_V2_ALREADY_EXISTS")
    data=compute(root,manifest,**kwargs)
    raw=(json.dumps(data,sort_keys=True,separators=(",",":"),
                    ensure_ascii=False)+"\n").encode("utf-8")
    if len(raw)>MAX_REPORT:
        raise VisualGateError("DOCLING_RAPID_V2_TOO_LARGE")
    if audit:
        if path.is_symlink() or not path.is_file() or path.read_bytes()!=raw:
            raise VisualGateError("DOCLING_RAPID_V2_FROZEN_RECEIPT_CHANGED")
    elif write:
        flags=os.O_EXCL|os.O_CREAT|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(path,flags,0o600),"wb") as target:
            target.write(raw)
    return data


def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument("--private-root",required=True)
    p.add_argument("--manifest",required=True)
    modes=p.add_mutually_exclusive_group()
    modes.add_argument("--write",action="store_true")
    modes.add_argument("--audit-only",action="store_true")
    a=p.parse_args(argv)
    manifest=json.loads(Path(a.manifest).read_text("utf-8"))
    info=execute(Path(a.private_root),manifest,write=a.write,audit=a.audit_only)
    print("ACS_DOCLING_RAPID_FALLBACK_STATUS="+info["status"])
    print("ACS_DOCLING_RAPID_LAYOUT_CANDIDATE_COUNT="+str(
        info["standard_layout_artifact_count_candidates"]))
    print("ACS_DOCLING_RAPID_RECEIPT="+(
        "PRIVATE_CREATED" if a.write else "RECEIPT_VERIFIED" if a.audit_only
        else "READONLY_READY"))
    print("ACS_DOCLING_RAPID_ACTUAL_STANDARD_OCR_PAGES=0")
    print("ACS_DOCLING_RAPID_GOLD=UNVERIFIED")
    print("ACS_DOCLING_RAPID_NEW_MODEL_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,OSError,TypeError,ValueError,RuntimeError):
        print("ACS_DOCLING_RAPID_FALLBACK_REJECTED=PROVENANCE_OR_PACKAGE_GATE")
        sys.exit(2)
