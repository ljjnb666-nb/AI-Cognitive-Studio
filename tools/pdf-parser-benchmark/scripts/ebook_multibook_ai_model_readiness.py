#!/usr/bin/env python3
"""Private, read-only, offline Docling Standard / MinerU model readiness probe.

This does NOT equate package import or a weight-looking file with successful
inference. No downloads, provider requests, model import or book text reads.
A finite set of known model-cache locations is inspected with bounded depth.
"""
import argparse
from importlib import metadata
import json
import os
from pathlib import Path
import re
import sys

from ebook_multibook_native_matrix import audit_existing as audit_native, _private_folder
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

NAME = "multibook_ai_model_readiness.private.json"
PROVENANCE = "LOCAL_CACHED_MODEL_INVENTORY_NOT_ENGINE_INFERENCE"
MAX_JSON = 100_000
MAX_DIRS = 2200
MAX_FILES = 4500
MAX_DEPTH = 5
WEIGHTS = (".safetensors", ".onnx", ".gguf", ".pt", ".pth", ".bin")
MIN_WEIGHT_BYTES = 80_000
ENGINES = ("docling_standard", "mineru")


def _allowed_roots(root, extra=None):
    root = Path(root)
    home = Path.home()
    options = [
        root / "tool-env",
        root / "models",
        root / "model-cache",
        root / "hf-cache",
        root / "mineru",
        root / "docling",
        home / ".mineru",
        home / ".cache" / "huggingface" / "hub",
    ]
    for key in ("HF_HOME","HUGGINGFACE_HUB_CACHE","MINERU_HOME","DOCLING_ARTIFACTS_PATH"):
        value = os.environ.get(key)
        if value and Path(value).is_absolute():
            options.append(Path(value))
    if extra is not None:
        options.extend(Path(x) for x in extra)
    result=[];seen=set()
    for loc in options:
        if not loc.is_absolute() or loc.is_symlink():
            continue
        try:
            safe=loc.resolve(strict=True)
        except (FileNotFoundError,OSError):
            continue
        if not safe.is_dir() or str(safe).lower() in seen:
            continue
        seen.add(str(safe).lower())
        result.append(safe)
    return result


def _looks_related(path, root):
    rel = path.relative_to(root)
    words = str(rel).lower()
    return bool(re.search(r"docling|mineru|layout|tableformer|easyocr|rapidocr|onnx|vlm|huggingface|models--",words))


def scan_cache(roots):
    """No traversal through symlinks; never hash book/page files or emit paths."""
    total_dirs=0;total_files=0
    found=[]
    for base in roots:
        for current, dirs, files in os.walk(base,topdown=True,followlinks=False):
            current=Path(current)
            depth=len(current.relative_to(base).parts)
            if total_dirs>=MAX_DIRS or total_files>=MAX_FILES:
                return {"status":"BOUND_EXCEEDED","weights":found,
                        "dirs_scanned":total_dirs,"files_scanned":total_files}
            total_dirs+=1
            dirs[:]=sorted(x for x in dirs if
                           depth<MAX_DEPTH and not (current/x).is_symlink())
            if depth>MAX_DEPTH:
                continue
            total_files+=len(files)
            if not _looks_related(current,base) and current!=base:
                continue
            for filename in sorted(files):
                p=current/filename
                if p.suffix.lower() not in WEIGHTS or p.is_symlink():
                    continue
                try:
                    size=p.stat().st_size
                except OSError:
                    continue
                if not MIN_WEIGHT_BYTES<=size<=25*1024*1024*1024:
                    continue
                lower=str(p).lower()
                engine=("mineru" if "mineru" in lower else
                        "docling" if ("docling" in lower or "tableformer" in lower)
                        else "shared_or_unknown")
                found.append({"engine_hint":engine,"bytes":int(size),
                              "file_type":p.suffix.lower()})
                if len(found)>256:
                    return {"status":"BOUND_EXCEEDED","weights":found,
                            "dirs_scanned":total_dirs,"files_scanned":total_files}
    return {"status":"BOUNDED_INVENTORY","weights":found,
            "dirs_scanned":total_dirs,"files_scanned":total_files}


def package_state():
    versions={}
    for name in ("docling","docling-core","mineru","mineru-kit","rapidocr"):
        try:
            versions[name]=metadata.version(name)
        except metadata.PackageNotFoundError:
            versions[name]=None
    return versions


def collect(root,manifest,*,roots=None):
    native=audit_native(root,manifest)
    if native.get("selected_native_pages")!=24 or native.get("pdf_book_count")!=6:
        raise VisualGateError("MODEL_READINESS_REAL_24_PAGE_BASELINE_INVALID")
    actual_roots=_allowed_roots(root) if roots is None else list(roots)
    inventory=scan_cache(actual_roots)
    weights=inventory["weights"]
    counts={name:sum(x["engine_hint"]==name for x in weights)
            for name in ("docling","mineru","shared_or_unknown")}
    bytes_by_engine={name:sum(x["bytes"] for x in weights
                              if x["engine_hint"]==name)
                     for name in counts}
    states={
        "docling_standard":"MODEL_COMPLETENESS_NOT_ATTESTED",
        "mineru":"MODEL_COMPLETENESS_NOT_ATTESTED",
    }
    if not weights:
        states={name:"NO_LOCAL_WEIGHT_CANDIDATES_IN_SCANNED_ROOTS"
                for name in ENGINES}
    result={
        "schema_version":1,
        "evidence":PROVENANCE,
        "corpus_id":native["corpus_id"],
        "native_pdf_books":6,
        "native_selected_pages":24,
        "roots_inspected_count":len(actual_roots),
        "inventory_status":inventory["status"],
        "directories_inspected":inventory["dirs_scanned"],
        "files_inspected":inventory["files_scanned"],
        "model_weight_candidate_counts":counts,
        "model_weight_candidate_bytes":bytes_by_engine,
        "installed_packages_in_this_interpreter":package_state(),
        "engine_states":states,
        "docling_standard_inference_tested":False,
        "mineru_inference_tested":False,
        "cached_weights_are_not_completeness_proof":True,
        "ocr_quality_gold":None,
        "layout_quality_gold":None,
        "graph_quality_gold":None,
        "provider_calls":0,
        "model_downloads":0,
    }
    return result


def _path(root):
    return _private_folder(root)/NAME


def run(root,manifest,*,write=False,roots=None):
    dest=_path(root)
    if dest.exists() or dest.is_symlink():
        raise VisualGateError("MODEL_READINESS_PRIVATE_REPORT_ALREADY_EXISTS")
    result=collect(root,manifest,roots=roots)
    raw=(json.dumps(result,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
    if len(raw)>MAX_JSON:
        raise VisualGateError("MODEL_READINESS_REPORT_TOO_LARGE")
    if write:
        flags=os.O_EXCL|os.O_CREAT|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(dest,flags,0o600),"wb") as f:
            f.write(raw)
    return result


def audit_existing(root,manifest):
    path=_path(root)
    if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=MAX_JSON:
        raise VisualGateError("MODEL_READINESS_RECEIPT_MISSING")
    try:
        data=json.loads(path.read_text("utf-8"),object_pairs_hook=no_duplicate_keys,
                        parse_constant=reject_constant)
    except (UnicodeError,TypeError,ValueError):
        raise VisualGateError("MODEL_READINESS_RECEIPT_BAD_JSON") from None
    native=audit_native(root,manifest)
    if (not isinstance(data,dict) or data.get("schema_version")!=1 or
            data.get("evidence")!=PROVENANCE or
            data.get("corpus_id")!=native["corpus_id"] or
            data.get("native_pdf_books")!=6 or
            data.get("native_selected_pages")!=24 or
            data.get("docling_standard_inference_tested") is not False or
            data.get("mineru_inference_tested") is not False or
            data.get("cached_weights_are_not_completeness_proof") is not True or
            data.get("provider_calls")!=0 or data.get("model_downloads")!=0 or
            data.get("ocr_quality_gold",object()) is not None or
            data.get("layout_quality_gold",object()) is not None or
            data.get("graph_quality_gold",object()) is not None or
            not isinstance(data.get("engine_states"),dict) or
            set(data["engine_states"])!=set(ENGINES) or
            any(v not in ("MODEL_COMPLETENESS_NOT_ATTESTED",
                          "NO_LOCAL_WEIGHT_CANDIDATES_IN_SCANNED_ROOTS")
                for v in data["engine_states"].values())):
        raise VisualGateError("MODEL_READINESS_RECEIPT_PROVENANCE_INVALID")
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
        result=audit_existing(Path(args.private_root),manifest)
    else:
        result=run(Path(args.private_root),manifest,write=args.write)
    print("ACS_LOCAL_MODEL_READINESS="+("PRIVATE_WRITTEN" if args.write else
          "PRIVATE_RECEIPT_VERIFIED" if args.audit_only else "READONLY"))
    print("ACS_LOCAL_MODEL_SCAN_ROOTS="+str(result["roots_inspected_count"]))
    for name in ("docling","mineru","shared_or_unknown"):
        print("ACS_LOCAL_MODEL_HINTED_"+name.upper()+"="+str(
            result["model_weight_candidate_counts"][name]))
    for name in ENGINES:
        print("ACS_LOCAL_MODEL_"+name.upper()+"="+result["engine_states"][name])
    print("ACS_LOCAL_MODEL_STANDARDDOCLING_TESTED=FALSE")
    print("ACS_LOCAL_MODEL_MINERU_TESTED=FALSE")
    print("ACS_LOCAL_MODEL_PROVIDER_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,OSError,TypeError,ValueError,ImportError) as err:
        print("ACS_LOCAL_MODEL_READINESS_REJECTED="+(
            err.code if isinstance(err,VisualGateError) else type(err).__name__))
        sys.exit(2)
