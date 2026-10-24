#!/usr/bin/env python3
"""B15 p109 TRUE offline Docling Standard + RapidOCR from existing D: venv.

Requires immutable p109 sources and successful v3 Standard layout receipt.
No pip installs or downloads; never alter a preexisting Python environment.
All OCR text, model paths and diagnostics are restricted to the private D root.
"""
import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from ebook_b15_docling_standard_layout_real import (
    verify_source, trial as audit_layout, _exclusive, RUN_TIMEOUT,
)
from ebook_b15_docling_rapidocr_fallback import REPORT as V2_REPORT
from ebook_multibook_native_matrix import _private_folder
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b15_docling_standard_rapidocr_real.v4.private.json"
WORKER="b15_docling_standard_rapidocr_worker.v4.private.json"
LOG="b15_docling_standard_rapidocr_worker.v4.private.log"
EVIDENCE="B15_TRUE_STANDARD_PLUS_RAPIDOCR_OFFLINE_SINGLE_PAGE_NO_OCR_GOLD"
MAX_LOG=180000
MAX_WORKER=400000
MAX_MD=150000
MAX_FOLDERS=64
MAX_RUNTIME=165
VERSIONS={"rapidocr":"3.9.2","onnxruntime":"1.22.1"}


def local_packages(site):
    try:
        dists=list(metadata.distributions(path=[str(site)]))
    except (OSError,TypeError,ValueError):
        return {}
    result={}
    for d in dists:
        name=(d.metadata.get("Name") or "").strip().lower().replace("_","-")
        if name in VERSIONS:
            if name in result:
                raise VisualGateError("B15_STANDARD_OCR_DUPLICATE_DISTRIBUTION")
            result[name]=d.version
    return result


def bundled_weights(site):
    model_dir=site/"rapidocr"/"models"
    if not model_dir.is_dir() or model_dir.is_symlink():
        return None
    names=list(model_dir.glob("*.onnx"))
    if len(names)>16 or any(p.is_symlink() or not p.is_file()
                            or not 10000<p.stat().st_size<150000000
                            for p in names):
        raise VisualGateError("B15_STANDARD_OCR_MODEL_FILE_UNSAFE")
    labels=set()
    for p in names:
        for kind in ("det","rec"):
            if kind in p.name.lower():
                labels.add(kind)
    if labels!={"det","rec"}:
        return None
    # Weight SHAs are retained only in the D: private v4 receipt.
    return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in names}


def _symlink_ancestor(root, path):
    try:
        parts=path.relative_to(root).parts
    except ValueError:
        return True
    return any((root/Path(*parts[:j])).is_symlink()
               for j in range(1,len(parts)+1))


def discover_existing_rapidocr(root):
    root=Path(root)
    env_dir=root/"tool-env"
    if env_dir.is_symlink() or not env_dir.is_dir():
        raise VisualGateError("B15_STANDARD_OCR_VENV_PARENT_UNSAFE")
    children=sorted(env_dir.iterdir())
    if len(children)>MAX_FOLDERS:
        raise VisualGateError("B15_STANDARD_OCR_ENV_COUNT_EXCEEDED")
    matches=[]
    for d in children:
        if d.is_symlink():
            raise VisualGateError("B15_STANDARD_OCR_ENV_SYMLINK")
        if not d.is_dir():
            continue
        site=d/"Lib"/"site-packages"
        if (not site.is_dir() or _symlink_ancestor(root,site)
                or not site.resolve().is_relative_to(root.resolve())):
            continue
        versions=local_packages(site)
        if versions!=VERSIONS:
            continue
        hashes=bundled_weights(site)
        if hashes is None:
            continue
        matches.append({"site":site,"weights":hashes,
                        "versions":versions})
    return matches


def worker(pdf,model_dir,outfile):
    # The worker is invoked under the existing Docling Python executable,
    # with only a validated, local RapidOCR 3.9.2 site-packages prepended.
    if (os.environ.get("HF_HUB_OFFLINE")!="1" or
            os.environ.get("TRANSFORMERS_OFFLINE")!="1" or
            os.environ.get("PYTHONNOUSERSITE")!="1"):
        raise VisualGateError("B15_STANDARD_OCR_WORKER_NOT_OFFLINE")
    if any(metadata.version(name)!=version for name,version in VERSIONS.items()):
        raise VisualGateError("B15_STANDARD_OCR_WORKER_PACKAGE_VERSION_CHANGED")
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
    from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice
    from docling.document_converter import DocumentConverter, PdfFormatOption
    options=PdfPipelineOptions(
        artifacts_path=Path(model_dir),
        do_ocr=True,
        do_table_structure=False,
        generate_page_images=False,
        generate_picture_images=False,
        enable_remote_services=False,
        allow_external_plugins=False,
        document_timeout=140.0,
    )
    # OCR must target the whole scanned page; do not silently fall back to
    # embedded PDF text on a visually scanned, image-dominant document.
    options.ocr_options=RapidOcrOptions(
        lang=["ch"],backend="onnxruntime",force_full_page_ocr=True)
    options.accelerator_options=AcceleratorOptions(
        num_threads=2,device=AcceleratorDevice.CPU)
    converter=DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={InputFormat.PDF:PdfFormatOption(pipeline_options=options)})
    started=time.perf_counter()
    result=converter.convert(str(pdf),max_num_pages=1)
    elapsed=round((time.perf_counter()-started)*1000)
    if (getattr(result.status,"name",str(result.status))!="SUCCESS"
            or result.document is None):
        raise VisualGateError("B15_STANDARD_OCR_CONVERSION_FAILED")
    doc=result.document
    markdown=doc.export_to_markdown()
    if not isinstance(markdown,str) or len(markdown)>MAX_MD:
        raise VisualGateError("B15_STANDARD_OCR_MARKDOWN_LIMIT_EXCEEDED")
    payload={
        "pipeline":"REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU",
        "ocr_explicitly_enabled":True,
        "duration_ms":elapsed,
        "text_item_count":len(doc.texts),
        "picture_item_count":len(doc.pictures),
        "table_item_count":len(doc.tables),
        "private_markdown":markdown,
    }
    raw=(json.dumps(payload,ensure_ascii=False,sort_keys=True)+"\n").encode("utf-8")
    if len(raw)>MAX_WORKER:
        raise VisualGateError("B15_STANDARD_OCR_WORKER_OUTPUT_TOO_LARGE")
    _exclusive(Path(outfile),raw)


def compute(root,manifest,*,write=False,audit=False,probe=discover_existing_rapidocr,
            runner=subprocess.run):
    root=Path(root)
    folder,pdf,page_sha,parent,candidates=verify_source(root,manifest)
    prior=audit_layout(root,manifest,audit=True)
    if (prior.get("status")!="REAL_STANDARD_LAYOUT_SUCCESS_OCR_DISABLED"
            or prior.get("actual_layout_success") is not True
            or prior.get("same_page_sha256_private")!=page_sha
            or prior.get("ocr_page_count")!=0):
        raise VisualGateError("B15_STANDARD_OCR_LAYOUT_BASELINE_NOT_PROVEN")
    final=folder/REPORT
    result_file=folder/WORKER
    stderr_file=folder/LOG
    if audit:
        if final.is_symlink() or not final.is_file():
            raise VisualGateError("B15_STANDARD_OCR_FROZEN_REPORT_MISSING")
        data=json.loads(final.read_text(encoding="utf-8"))
        if (data.get("schema_version")!=4 or data.get("evidence")!=EVIDENCE
                or data.get("source_single_page_pdf_sha256_private")!=page_sha
                or data.get("layout_v3_receipt_sha256_private")!=
                    hashlib.sha256((folder/
                      "b15_docling_standard_layout_real.v3.private.json").read_bytes()).hexdigest()
                or data.get("actual_ocr_success")!=(
                    data.get("status")=="REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS")
                or data.get("cer",object()) is not None):
            raise VisualGateError("B15_STANDARD_OCR_FROZEN_IDENTITY_INVALID")
        for path,field in ((result_file,"worker_sha256_private"),
                           (stderr_file,"worker_log_sha256_private")):
            checksum=data.get(field)
            if (checksum is None and (path.exists() or path.is_symlink()) or
                checksum is not None and
                (path.is_symlink() or not path.is_file() or
                hashlib.sha256(path.read_bytes()).hexdigest()!=checksum)):
                raise VisualGateError("B15_STANDARD_OCR_FROZEN_WORKER_CHANGED")
        return data
    if (final.exists() or final.is_symlink() or result_file.exists()
            or result_file.is_symlink() or stderr_file.exists()
            or stderr_file.is_symlink()):
        raise VisualGateError("B15_STANDARD_OCR_REPORT_ALREADY_EXISTS")
    if len(candidates)!=1:
        raise VisualGateError("B15_STANDARD_OCR_LAYOUT_CACHE_NOT_UNIQUE")
    package_candidates=probe(root)
    if not isinstance(package_candidates,list) or len(package_candidates)>MAX_FOLDERS:
        raise VisualGateError("B15_STANDARD_OCR_PACKAGE_DISCOVERY_INVALID")
    if len(package_candidates)==0:
        status="BLOCKED_NO_OFFLINE_COMPATIBLE_RAPIDOCR_SITE_PACKAGES"
    elif len(package_candidates)>1:
        status="BLOCKED_MULTIPLE_COMPATIBLE_RAPIDOCR_ENVIRONMENTS"
    else:
        status="OFFLINE_PACKAGES_READY_NO_OCR_EXECUTED"
        pkg=package_candidates[0]
        if (pkg.get("versions")!=VERSIONS or
                not isinstance(pkg.get("site"),Path) or
                _symlink_ancestor(root,pkg["site"]) or
                not pkg["site"].resolve().is_relative_to(root.resolve()) or
                not isinstance(pkg.get("weights"),dict) or
                len(pkg["weights"])<2):
            raise VisualGateError("B15_STANDARD_OCR_PACKAGE_PROVENANCE_INVALID")
        if write:
            cmd=[sys.executable,str(Path(__file__).resolve()),
                 "--worker-pdf",str(pdf),"--worker-layout",str(candidates[0][1]),
                 "--worker-out",str(result_file)]
            env=os.environ.copy()
            env.update({
                "PYTHONPATH":str(pkg["site"]),"PYTHONNOUSERSITE":"1",
                "HF_HUB_OFFLINE":"1","TRANSFORMERS_OFFLINE":"1",
                "HF_DATASETS_OFFLINE":"1","HF_HUB_DISABLE_TELEMETRY":"1",
                "HTTP_PROXY":"http://127.0.0.1:1",
                "HTTPS_PROXY":"http://127.0.0.1:1",
                "ALL_PROXY":"http://127.0.0.1:1","NO_PROXY":"",
            })
            try:
                p=runner(cmd,env=env,stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE,timeout=MAX_RUNTIME,check=False)
                private_log=((p.stdout or b"")+(p.stderr or b""))[:MAX_LOG]
                status=("REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS"
                        if p.returncode==0 and result_file.is_file()
                        else "BLOCKED_PRIVATE_STANDARD_OCR_RUNTIME_FAILURE")
            except subprocess.TimeoutExpired as exc:
                private_log=((exc.stdout or b"")+(exc.stderr or b""))[:MAX_LOG]
                status="BLOCKED_PRIVATE_STANDARD_OCR_TIMEOUT"
            _exclusive(stderr_file,private_log)
    parsed=None
    if status=="REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS":
        if result_file.is_symlink() or result_file.stat().st_size>MAX_WORKER:
            raise VisualGateError("B15_STANDARD_OCR_WORKER_RESULT_UNSAFE")
        parsed=json.loads(result_file.read_text("utf-8"))
        if (parsed.get("pipeline")!="REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU"
                or parsed.get("ocr_explicitly_enabled") is not True
                or any(type(parsed.get(k)) is not int or parsed[k]<0
                    for k in ("duration_ms","text_item_count",
                              "picture_item_count","table_item_count"))
                or not isinstance(parsed.get("private_markdown"),str)):
            raise VisualGateError("B15_STANDARD_OCR_WORKER_RESULT_INVALID")
    data={
        "schema_version":4,"evidence":EVIDENCE,
        "book_id":"B15","physical_page":109,"corpus_id":parent["corpus_id"],
        "source_single_page_pdf_sha256_private":page_sha,
        "layout_v3_receipt_sha256_private":hashlib.sha256((folder/
            "b15_docling_standard_layout_real.v3.private.json").read_bytes()).hexdigest(),
        "status":status,"installed_compatible_vens_count":len(package_candidates),
        "candidate_layout_directories":len(candidates),
        "actual_ocr_success":status=="REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS",
        "ocr_configured":True if status=="REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS" else False,
        "duration_ms":parsed["duration_ms"] if parsed else None,
        "text_item_count":parsed["text_item_count"] if parsed else None,
        "picture_item_count":parsed["picture_item_count"] if parsed else None,
        "table_item_count":parsed["table_item_count"] if parsed else None,
        "markdown_normalized_character_count":None,
        "worker_sha256_private":(
            hashlib.sha256(result_file.read_bytes()).hexdigest()
            if result_file.is_file() else None),
        "worker_log_sha256_private":(
            hashlib.sha256(stderr_file.read_bytes()).hexdigest()
            if stderr_file.is_file() else None),
        "ocr_model_type":"RAPIDOCR_3_9_2_ONNX_CPU" if parsed else None,
        "independent_ground_truth":None,"cer":None,"accuracy_winner":None,
        "new_cloud_calls":0,"new_model_downloads":0,
    }
    if parsed:
        from ebook_fivebook_text_consensus import lexical,mineru_lexical_source
        data["markdown_normalized_character_count"]=len(
            lexical(mineru_lexical_source(parsed["private_markdown"])))
    if write:
        _exclusive(final,(json.dumps(data,ensure_ascii=False,
             sort_keys=True,separators=(",",":"))+"\n").encode("utf-8"))
    return data


def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument("--private-root")
    p.add_argument("--manifest")
    p.add_argument("--write",action="store_true")
    p.add_argument("--audit-only",action="store_true")
    p.add_argument("--worker-pdf")
    p.add_argument("--worker-layout")
    p.add_argument("--worker-out")
    opts=p.parse_args(argv)
    if opts.worker_pdf is not None:
        if not opts.worker_layout or not opts.worker_out:
            raise VisualGateError("B15_STANDARD_OCR_WORKER_ARGUMENTS")
        worker(opts.worker_pdf,opts.worker_layout,opts.worker_out)
        return
    if not opts.private_root or not opts.manifest or opts.write and opts.audit_only:
        raise VisualGateError("B15_STANDARD_OCR_ARGUMENTS")
    manifest=json.loads(Path(opts.manifest).read_text(encoding="utf-8"))
    data=compute(Path(opts.private_root),manifest,
                 write=opts.write,audit=opts.audit_only)
    for k in ("status","installed_compatible_vens_count",
              "actual_ocr_success","duration_ms","text_item_count",
              "picture_item_count","table_item_count",
              "markdown_normalized_character_count"):
        print("ACS_B15_STANDARD_RAPID_"+k.upper()+"="+str(data[k]))
    print("ACS_B15_STANDARD_RAPID_GOLD=UNVERIFIED")
    print("ACS_B15_STANDARD_RAPID_CLOUD_CALLS=0")
    print("ACS_B15_STANDARD_RAPID_MODEL_DOWNLOADS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,OSError,ValueError,TypeError,RuntimeError):
        print("ACS_B15_STANDARD_RAPID_REJECTED=PRIVATE_SOURCE_OR_OCR_GATE")
        sys.exit(2)
