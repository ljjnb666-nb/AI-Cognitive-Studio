#!/usr/bin/env python3
"""Synthetic-only offline two-page Docling Standard smoke; no corpus reads."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

def invoke(child,models,*args):
    result=subprocess.run(
        [sys.executable,str(child),"--artifacts",str(models),*args],
        capture_output=True,text=True,timeout=175,check=False,
        env={
            k:v for k,v in os.environ.items()
            if k.lower() in {
                "path","pathext","systemroot","windir","temp","tmp","home",
                "userprofile","appdata","localappdata","systemdrive","comspec",
                "ld_library_path","lang","pythonpath",
            }
        }|{
            "HF_HUB_OFFLINE":"1","TRANSFORMERS_OFFLINE":"1",
            "HF_DATASETS_OFFLINE":"1","HF_HUB_DISABLE_TELEMETRY":"1",
            "HTTP_PROXY":"http://127.0.0.1:1",
            "HTTPS_PROXY":"http://127.0.0.1:1",
            "ALL_PROXY":"http://127.0.0.1:1",
            "NO_PROXY":"*",
            "OMP_NUM_THREADS":"2",
        },
    )
    if len(result.stdout)>1_000_000 or result.returncode!=0:
        raise RuntimeError("DOCLING_CHILD_REJECTED")
    rows=result.stdout.strip().splitlines()
    if len(rows)!=1:
        raise RuntimeError("DOCLING_CHILD_PROTOCOL_INVALID")
    return json.loads(rows[0])

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--child",required=True)
    parser.add_argument("--artifacts",required=True)
    opts=parser.parse_args()
    child=Path(opts.child)
    models=Path(opts.artifacts)
    if not child.is_file() or not models.is_dir():
        raise RuntimeError("SMOKE_INPUT_MISSING")
    identity=invoke(child,models,"--probe")
    if (identity.get("status")!="READY" or identity.get("docling")!="2.141.0"
            or len(identity.get("artifactSha256",""))!=64):
        raise RuntimeError("DOCLING_PROBE_NOT_READY")
    print("ACS_DOCLING_LAYOUT_PINNED_ASSETS=PASS")
    import fitz
    with tempfile.TemporaryDirectory(prefix="acs-docling-synthetic-") as td:
        pdf=Path(td)/"synthetic.pdf"
        document=fitz.open()
        page0=document.new_page(width=612,height=792)
        page0.insert_text((40,100),"PAGE_ZERO_DO_NOT_EXPORT",fontsize=14)
        page1=document.new_page(width=612,height=792)
        page1.insert_text((40,100),"SECOND_PAGE_LAYOUT_TEST",fontsize=16)
        page1.insert_text((40,150),"STRUCTURED_PARAGRAPH_CONTENT",fontsize=12)
        document.save(pdf)
        document.close()
        output=invoke(child,models,"--pdf",str(pdf),"--page","1")
        if (output.get("schemaVersion")!=1 or output.get("status")!="SUCCEEDED"
                or output.get("ocrUsed") is not False or
                output.get("fullPageReference") is not False or
                output.get("sourceMethod")!="DOCLING_LAYOUT_CANDIDATE_ONLY"):
            raise RuntimeError("DOCLING_LAYOUT_CANDIDATE_REJECTED")
        text=output.get("markdown")
        if (not isinstance(text,str)
                or "SECOND_PAGE_LAYOUT_TEST" not in text
                or "PAGE_ZERO_DO_NOT_EXPORT" in text):
            raise RuntimeError("DOCLING_PHYSICAL_PAGE_SOURCE_MIXED")
        if any(type(output.get(k)) is not int or output[k]<0 for k in
               ("textItemCount","pictureItemCount","tableItemCount")):
            raise RuntimeError("DOCLING_LAYOUT_STRUCTURE_COUNTS_INVALID")
        print("ACS_DOCLING_LAYOUT_REAL_SECOND_PAGE=PASS")
        print("ACS_DOCLING_LAYOUT_FIRST_PAGE_LEAKAGE=ZERO")
        print("ACS_DOCLING_LAYOUT_CLOUD_CALLS=ZERO")
        print("ACS_DOCLING_LAYOUT_PRIVATE_BOOK_READS=ZERO")
        print("ACS_DOCLING_LAYOUT_GOLD=NOT_APPROVED")

if __name__=="__main__":
    try:
        main()
    except Exception:
        print("ACS_DOCLING_LAYOUT_SYNTHETIC_SMOKE=REJECTED")
        sys.exit(2)
