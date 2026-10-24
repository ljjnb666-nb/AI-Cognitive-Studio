#!/usr/bin/env python3
"""Source-bound, read-only Docling STANDARD offline prerequisite inventory.

This intentionally does NOT instantiate StandardPdfPipeline, execute OCR,
download models, modify D: inputs, or claim Standard accuracy. The existing
Docling NATIVE (model-free) receipt must never be relabeled as Standard.
"""
import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from ebook_b15_spatial_disagreement import execute as audit_spatial
from ebook_multibook_docling_native import audit_existing as audit_docling_native
from ebook_multibook_native_matrix import _private_folder
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b15_docling_standard_offline_readiness.private.json"
EVIDENCE="B15_DOCLING_STANDARD_OFFLINE_ASSET_PREFLIGHT_NO_INFERENCE"
VERSION="2.141.0"
# Whitelisted private-root-relative candidates, never environment-dependent
# home downloads, user-supplied arbitrary paths or remote model repositories.
ARTIFACT_FOLDERS=(
    "tool-env/docling-standard-artifacts",
    "tool-env/docling-models",
    "models/docling-standard",
    "models/docling",
)
MODEL_SUFFIXES={".safetensors",".onnx",".bin",".pt",".pth"}
CONFIG_SUFFIXES={".json",".yaml",".yml"}
MAX_FILES=10000
MAX_REPORT=25000


def discover_assets(root):
    """Inventory possible model caches; file presence is NOT run readiness."""
    evidence=[]
    for relative in ARTIFACT_FOLDERS:
        candidate=root/relative
        # A symlink at any ancestor (for example, tool-env/) can also
        # redirect discovery outside the sanctioned private evidence root.
        if any((root/Path(*Path(relative).parts[:j])).is_symlink()
               for j in range(1,len(Path(relative).parts)+1)):
            raise VisualGateError("DOCLING_STANDARD_ARTIFACT_SYMLINK")
        if not candidate.is_dir():
            evidence.append({"candidate":relative,"exists":False,
                             "model_weight_files":0,"config_files":0,
                             "model_weight_bytes":0})
            continue
        weights=configs=files=bytes_total=0
        for current,dirs,names in os.walk(candidate,followlinks=False):
            folder=Path(current)
            for name in dirs:
                if (folder/name).is_symlink():
                    raise VisualGateError("DOCLING_STANDARD_ARTIFACT_SYMLINK")
            for name in names:
                item=folder/name
                if item.is_symlink() or not item.is_file():
                    raise VisualGateError("DOCLING_STANDARD_ARTIFACT_UNSAFE_FILE")
                files+=1
                if files>MAX_FILES:
                    raise VisualGateError("DOCLING_STANDARD_ASSET_COUNT_EXCEEDED")
                n=item.stat().st_size
                if n>12_000_000_000 or n<0:
                    raise VisualGateError("DOCLING_STANDARD_ASSET_SIZE_INVALID")
                if item.suffix.lower() in MODEL_SUFFIXES and n>10000:
                    weights+=1
                    bytes_total+=n
                if item.suffix.lower() in CONFIG_SUFFIXES and n>0:
                    configs+=1
        evidence.append({"candidate":relative,"exists":True,
                         "model_weight_files":weights,
                         "config_files":configs,
                         "model_weight_bytes":bytes_total})
    return evidence


def tesseract_probe():
    exe=shutil.which("tesseract")
    if not exe:
        candidate=Path(os.environ.get("ProgramFiles", "C:/Program Files"))/"Tesseract-OCR"/"tesseract.exe"
        if candidate.is_file() and not candidate.is_symlink():
            exe=str(candidate)
    if not exe:
        return {"binary_available":False,"chi_sim_available":False,
                "eng_available":False}
    try:
        completed=subprocess.run([exe,"--list-langs"],capture_output=True,
                                 text=True,check=False,timeout=8)
    except (OSError,subprocess.TimeoutExpired):
        return {"binary_available":False,"chi_sim_available":False,
                "eng_available":False}
    # Tesseract prints only installed language names, never OCR content.
    tokens=set(completed.stdout.splitlines()+completed.stderr.splitlines())
    tokens={t.strip() for t in tokens}
    return {"binary_available":completed.returncode==0,
            "chi_sim_available":completed.returncode==0 and "chi_sim" in tokens,
            "eng_available":completed.returncode==0 and "eng" in tokens}


def version_probe():
    try:
        return metadata.version("docling")
    except metadata.PackageNotFoundError:
        return None


def calculate_status(version,tesseract,artifacts):
    if version!=VERSION:
        return "BLOCKED_DOCLING_VERSION"
    if not (tesseract["binary_available"] and
            tesseract["chi_sim_available"] and tesseract["eng_available"]):
        return "BLOCKED_TESSERACT_CHINESE_ENGLISH_OCR"
    if not any(p["model_weight_files"]>0 and p["config_files"]>0
               for p in artifacts):
        return "BLOCKED_STANDARD_MODEL_ARTIFACTS"
    # Existing candidates alone do not prove a complete Docling Standard
    # model tree or successful offline pipeline initialization.
    return "CANDIDATE_ASSETS_ONLY_RUNTIME_UNVERIFIED"


def compute(root,manifest,*,assets_fn=discover_assets,
            ocr_fn=tesseract_probe,package_fn=version_probe):
    folder=_private_folder(root)
    spatial=audit_spatial(root,manifest,audit=True)
    native=audit_docling_native(root,manifest)
    if (spatial.get("book_id")!="B15" or spatial.get("physical_page")!=109
            or spatial.get("root_cause_verified") is not False
            or spatial.get("cer",object()) is not None
            or native.get("model_free") is not True
            or native.get("docling_native_completed_pages")!=24
            or spatial.get("corpus_id")!=native.get("corpus_id")):
        raise VisualGateError("DOCLING_STANDARD_SOURCE_LINEAGE_MISSING")
    p=[x for x in native["pages"]
       if (x.get("book_id"),x.get("physical_page"))==("B15",109)]
    if len(p)!=1 or p[0].get("original_pdf_sha256")!=spatial.get(
            "original_source_pdf_sha256_private"):
        raise VisualGateError("DOCLING_STANDARD_NOT_SAME_SOURCE_OR_PAGE")
    staged=folder/"docling_native_single_pages"/"B15_p0109.private.pdf"
    if (staged.is_symlink() or not staged.is_file() or
            not 0<staged.stat().st_size<=35*1024*1024 or
            hashlib.sha256(staged.read_bytes()).hexdigest()!=p[0].get(
                "staged_pdf_sha256")):
        raise VisualGateError("DOCLING_STANDARD_STAGED_PDF_TAMPERED")
    version=package_fn()
    tess=ocr_fn()
    assets=assets_fn(Path(root))
    if (version is not None and (not isinstance(version,str) or len(version)>60)
            or not isinstance(tess,dict)
            or set(tess)!={"binary_available","chi_sim_available","eng_available"}
            or any(type(value) is not bool for value in tess.values())
            or not isinstance(assets,list) or len(assets)!=len(ARTIFACT_FOLDERS)
            or any(not isinstance(row,dict) for row in assets)):
        raise VisualGateError("DOCLING_STANDARD_PROBE_INVALID")
    status=calculate_status(version,tess,assets)
    return {
        "schema_version":1,"evidence":EVIDENCE,"book_id":"B15",
        "physical_page":109,"corpus_id":spatial["corpus_id"],
        "same_original_pdf_sha256_private":p[0]["original_pdf_sha256"],
        "same_single_page_pdf_sha256_private":p[0]["staged_pdf_sha256"],
        "source_spatial_receipt_sha256_private":hashlib.sha256(
            (folder/"b15_spatial_disagreement_heatmap_3x3.private.json").read_bytes()
        ).hexdigest(),
        "docling_installed_version":version,
        "tesseract_languages":tess,"private_candidate_artifact_inventory":assets,
        "status":status,"docling_standard_pipeline_instantiated":False,
        "docling_standard_ocr_pages_executed":0,
        "docling_standard_layout_executed":False,
        "docling_native_is_not_standard":True,
        "standard_model_cache_completeness_verified":False,
        "ocr_ground_truth":None,"cer":None,"quality_winner":None,
        "provider_calls":0,"model_inference_calls":0,"model_downloads":0,
    }


def execute(root,manifest,*,write=False,audit=False,**kwargs):
    folder=_private_folder(root)
    output=folder/REPORT
    if not audit and (output.exists() or output.is_symlink()):
        raise VisualGateError("DOCLING_STANDARD_READINESS_REPORT_EXISTS")
    report=compute(root,manifest,**kwargs)
    raw=(json.dumps(report,ensure_ascii=False,sort_keys=True,
                    separators=(",",":"))+"\n").encode("utf-8")
    if len(raw)>MAX_REPORT:
        raise VisualGateError("DOCLING_STANDARD_READINESS_TOO_LARGE")
    if audit:
        if output.is_symlink() or not output.is_file() or output.read_bytes()!=raw:
            raise VisualGateError("DOCLING_STANDARD_READINESS_CHANGED")
    elif write:
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(output,flags,0o600),"wb") as target:
            target.write(raw)
    return report


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    modes=parser.add_mutually_exclusive_group()
    modes.add_argument("--write",action="store_true")
    modes.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    data=execute(Path(args.private_root),manifest,
                 write=args.write,audit=args.audit_only)
    print("ACS_DOCLING_STANDARD_PREFLIGHT="+data["status"])
    print("ACS_DOCLING_STANDARD_RECEIPT="+(
        "PRIVATE_CREATED" if args.write else
        "RECEIPT_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_DOCLING_STANDARD_PDF_PAGE=109")
    print("ACS_DOCLING_STANDARD_ACTUAL_OCR_PAGES=0")
    print("ACS_DOCLING_STANDARD_GOLD=UNVERIFIED")
    print("ACS_DOCLING_STANDARD_MODEL_DOWNLOADS=0")
    print("ACS_DOCLING_STANDARD_PAID_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,TypeError,OSError,RuntimeError):
        print("ACS_DOCLING_STANDARD_PREFLIGHT_REJECTED=SOURCE_OR_PROBE_GATE")
        sys.exit(2)
