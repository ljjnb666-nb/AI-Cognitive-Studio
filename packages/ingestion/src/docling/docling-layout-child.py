#!/usr/bin/env python3
"""Offline Docling Standard structural candidate; never OCR gold or publication.

One source PDF, exactly one original physical page, one bounded JSON reply.
This file is shipped with the production ingestion package, not benchmark data.
"""
import argparse
from importlib import metadata
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

VERSION="2.141.0"
MAX_PDF=110_000_000
MAX_MARKDOWN=160_000
MAX_PIXELS=8_000_000
MAX_ARTIFACTS=512
MAX_MODEL_BYTES=2_000_000_000

def emit(record):
    sys.stdout.write(json.dumps(record,ensure_ascii=False,separators=(",",":"))+"\n")

def model_identity(folder):
    if folder.is_symlink() or not folder.is_dir():
        raise RuntimeError("DOCLING_MODEL_DIR_INVALID")
    files=sorted(x for x in folder.rglob("*") if x.is_file())
    if not 0<len(files)<=MAX_ARTIFACTS:
        raise RuntimeError("DOCLING_MODEL_MANIFEST_INVALID")
    digest=hashlib.sha256()
    total=0
    weight_found=False
    for item in files:
        if item.is_symlink() or any(x.is_symlink() for x in item.parents if x!=folder):
            raise RuntimeError("DOCLING_MODEL_LINK_INVALID")
        if not item.resolve().is_relative_to(folder.resolve()):
            raise RuntimeError("DOCLING_MODEL_TRAVERSAL")
        relative=item.relative_to(folder).as_posix()
        size=item.stat().st_size
        total+=size
        if total>MAX_MODEL_BYTES:
            raise RuntimeError("DOCLING_MODEL_BUDGET_EXCEEDED")
        if item.suffix.lower() in (".safetensors",".bin",".onnx",".pt",".pth"):
            weight_found=True
        digest.update(relative.encode("utf-8"))
        digest.update(str(size).encode("ascii"))
        # SHA of actual bytes, not file timestamps or path-only provenance.
        with item.open("rb") as source:
            for chunk in iter(lambda:source.read(1024*1024),b""):
                digest.update(chunk)
    if not weight_found:
        raise RuntimeError("DOCLING_MODEL_WEIGHTS_MISSING")
    return digest.hexdigest()

def runtime_probe(artifacts):
    if metadata.version("docling")!=VERSION:
        raise RuntimeError("DOCLING_VERSION_CHANGED")
    import fitz  # noqa: F401
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter
    return model_identity(artifacts)

def layout(pdf,page,models):
    if pdf.is_symlink() or not pdf.is_file() or not 0<pdf.stat().st_size<=MAX_PDF:
        raise RuntimeError("PDF_INPUT_INVALID")
    import fitz
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.datamodel.accelerator_options import AcceleratorOptions,AcceleratorDevice
    from docling.document_converter import DocumentConverter,PdfFormatOption
    with fitz.open(pdf) as original:
        if original.needs_pass or page<0 or page>=original.page_count:
            raise RuntimeError("PDF_PAGE_INVALID")
        rectangle=original[page].rect
        if rectangle.width*rectangle.height>MAX_PIXELS:
            raise RuntimeError("PDF_PAGE_AREA_EXCEEDED")
        isolated=fitz.open()
        isolated.insert_pdf(original,from_page=page,to_page=page)
        with tempfile.TemporaryDirectory(prefix="acs-docling-") as td:
            isolated_page=Path(td)/"source.page.pdf"
            isolated.save(isolated_page,garbage=4,deflate=True)
            isolated.close()
            settings=PdfPipelineOptions(
                artifacts_path=models,
                do_ocr=False,
                do_table_structure=False,
                generate_page_images=False,
                generate_picture_images=False,
                enable_remote_services=False,
                allow_external_plugins=False,
                document_timeout=90.0,
            )
            settings.accelerator_options=AcceleratorOptions(
                num_threads=2,device=AcceleratorDevice.CPU)
            converter=DocumentConverter(
                allowed_formats=[InputFormat.PDF],
                format_options={
                    InputFormat.PDF:PdfFormatOption(pipeline_options=settings),
                },
            )
            result=converter.convert(str(isolated_page),max_num_pages=1)
    if (getattr(result.status,"name",str(result.status))!="SUCCESS" or
            result.document is None):
        raise RuntimeError("DOCLING_CONVERSION_FAILED")
    doc=result.document
    md=doc.export_to_markdown()
    if not isinstance(md,str) or len(md)>MAX_MARKDOWN:
        raise RuntimeError("DOCLING_LAYOUT_OUTPUT_BUDGET")
    return {
        "schemaVersion":1,"status":"SUCCEEDED",
        "sourceMethod":"DOCLING_LAYOUT_CANDIDATE_ONLY",
        "ocrUsed":False,"fullPageReference":False,
        "markdown":md,
        "textItemCount":len(doc.texts),
        "pictureItemCount":len(doc.pictures),
        "tableItemCount":len(doc.tables),
    }

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--artifacts",required=True)
    parser.add_argument("--pdf")
    parser.add_argument("--page",type=int)
    parser.add_argument("--probe",action="store_true")
    args=parser.parse_args()
    os.environ.update({
        "HF_HUB_OFFLINE":"1","TRANSFORMERS_OFFLINE":"1",
        "HF_DATASETS_OFFLINE":"1","HF_HUB_DISABLE_TELEMETRY":"1",
    })
    try:
        if not args.probe and (args.pdf is None or args.page is None):
            raise RuntimeError("DOCLING_INPUT_MISSING")
        if args.probe and (args.pdf is not None or args.page is not None):
            raise RuntimeError("DOCLING_PROBE_INPUT_CONFLICT")
        models=Path(args.artifacts)
        fingerprint=runtime_probe(models)
        if args.probe:
            emit({"schemaVersion":1,"status":"READY",
                  "docling":VERSION,"artifactSha256":fingerprint})
        else:
            emit(layout(Path(args.pdf),args.page,models))
        return 0
    except Exception:
        # No source text, local paths or exception stack in CI/worker stdout.
        emit({"schemaVersion":1,"status":"FAILED"})
        return 2

if __name__=="__main__":
    sys.exit(main())
