#!/usr/bin/env python3
"""B15 coarse spatial disagreement heatmap from frozen OCR boxes, NOT OCR gold.

No OCR or paid inference. Never export actual book text, boxes, coordinates,
tokens, images, precise page dimensions, individual scores or filenames.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys

from ebook_b15_disagreement_triage import execute as audit_b15, REPORT as B15_REPORT
from ebook_b15_order_sections import execute as audit_order, REPORT as ORDER_REPORT
from ebook_multibook_native_matrix import audit_existing as audit_native, _private_folder
from ebook_multibook_rapidocr_matrix import audit_existing as audit_rapid
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b15_spatial_disagreement_heatmap_3x3.private.json"
EVIDENCE="B15_COARSE_RAPIDOCR_BOX_DIVERGENCE_NOT_OCR_ACCURACY"
BANDS=("EMPTY","TOO_SHORT","ZERO","LOW","MEDIUM","HIGH")
MAX_REPORT=25000


def coarse_cell(quad,width,height):
    if (type(width) is not int or type(height) is not int or
            not 32<=width<=3000 or not 32<=height<=3000 or
            not isinstance(quad,list) or len(quad)!=4):
        raise VisualGateError("B15_SPATIAL_BOX_DIMENSIONS_INVALID")
    for p in quad:
        if (not isinstance(p,list) or len(p)!=2 or any(
            type(value) not in (int,float) or
            not math.isfinite(value) for value in p)):
            raise VisualGateError("B15_SPATIAL_QUAD_INVALID")
        if not 0<=p[0]<=width or not 0<=p[1]<=height:
            raise VisualGateError("B15_SPATIAL_QUAD_OUTSIDE_ORIGINAL_IMAGE")
    cx=sum(pt[0] for pt in quad)/4
    cy=sum(pt[1] for pt in quad)/4
    col=min(2,int(3*cx/width))
    row=min(2,int(3*cy/height))
    return row*3+col


def grid(rows,triage,width,height):
    metadata=triage.get("private_line_metadata_only")
    if (not isinstance(metadata,list) or not isinstance(rows,list) or
            len(rows)!=len(metadata) or not rows or len(rows)>300):
        raise VisualGateError("B15_SPATIAL_LINES_MISMATCH")
    cells=[{"row":i//3+1,"col":i%3+1,"line_count":0,
            "zero_or_low_lines":0,"too_short_or_empty_lines":0,
            "high_or_medium_lines":0,"normalized_characters":0}
           for i in range(9)]
    seen={x:0 for x in BANDS}
    for index,(source,meta) in enumerate(zip(rows,metadata)):
        if (not isinstance(meta,dict) or meta.get("line_index")!=index or
                meta.get("presence_band") not in BANDS or
                type(meta.get("normalized_chars")) is not int or
                meta["normalized_chars"]<0 or not isinstance(source,dict)):
            raise VisualGateError("B15_SPATIAL_LINE_METADATA_CHANGED")
        if not isinstance(source.get("quad"),list):
            raise VisualGateError("B15_SPATIAL_QUAD_MISSING")
        cell=cells[coarse_cell(source["quad"],width,height)]
        band=meta["presence_band"]
        cell["line_count"]+=1
        cell["normalized_characters"]+=meta["normalized_chars"]
        cell["zero_or_low_lines"]+=int(band in ("ZERO","LOW"))
        cell["too_short_or_empty_lines"]+=int(band in ("TOO_SHORT","EMPTY"))
        cell["high_or_medium_lines"]+=int(band in ("HIGH","MEDIUM"))
        seen[band]+=1
    if (sum(x["line_count"] for x in cells)!=len(rows) or
            sum(x["normalized_characters"] for x in cells)!=triage.get(
                "rapidocr_alnum_chars") or
            any(seen[b]!=triage["potential_line_support_buckets"].get(b)
                for b in BANDS)):
        raise VisualGateError("B15_SPATIAL_COUNTS_NOT_CONSERVED")
    return cells


def compute(root,manifest):
    prior=audit_b15(root,manifest,audit=True)
    order=audit_order(root,manifest,audit=True)
    if (prior.get("book_id")!="B15" or prior.get("physical_page")!=109 or
            order.get("book_id")!="B15" or order.get("physical_page")!=109 or
            order.get("corpus_id")!=prior.get("corpus_id") or
            order.get("rapidocr_rows_sha256_private")!=prior.get(
                "rapid_private_rows_sha256") or
            order.get("mineru_markdown_sha256_private")!=prior.get(
                "mineru_private_markdown_sha256") or
            order.get("root_cause_verified") is not False or
            order.get("cer",object()) is not None or
            order.get("new_model_inferences")!=0):
        raise VisualGateError("B15_SPATIAL_PRIOR_SOURCE_IDENTITY_CHANGED")
    native=audit_native(root,manifest)
    rapid=audit_rapid(root,manifest)
    focus=[(book,page) for book in native["rows"]
           if book.get("book_id")=="B15"
           for page in book.get("pages",[])
           if page.get("physical_page")==109]
    matched=[row for row in rapid["pages"]
             if (row.get("book_id"),row.get("physical_page"))==("B15",109)]
    if len(focus)!=1 or len(matched)!=1:
        raise VisualGateError("B15_SPATIAL_ORIGINAL_PAGE_NOT_UNIQUE")
    book,page=focus[0]
    receipt=matched[0]
    if (receipt.get("render_png_sha256")!=page.get("ocr_focus_png_sha256") or
            receipt.get("source_document_sha256")!=book.get(
                "source_document_sha256") or
            receipt.get("private_rows_sha256")!=prior.get(
                "rapid_private_rows_sha256")):
        raise VisualGateError("B15_SPATIAL_ORIGINAL_SOURCE_SHA_CONFLICT")
    width=page.get("ocr_focus_width")
    height=page.get("ocr_focus_height")
    cells=grid(receipt.get("rapidocr_private_rows"),
               prior,width,height)
    folder=_private_folder(root)
    return {"schema_version":1,"evidence":EVIDENCE,"book_id":"B15",
            "physical_page":109,"corpus_id":prior["corpus_id"],
            "original_source_pdf_sha256_private":
                book["source_document_sha256"],
            "rapidocr_original_png_sha256_private":
                page["ocr_focus_png_sha256"],
            "prior_line_receipt_sha256_private":hashlib.sha256(
                (folder/B15_REPORT).read_bytes()).hexdigest(),
            "prior_order_receipt_sha256_private":hashlib.sha256(
                (folder/ORDER_REPORT).read_bytes()).hexdigest(),
            "cells_3x3_row_major":cells,
            "grid_is_coarse_image_position_only":True,
            "line_bands_are_rapidocr_vs_mineru_agreement_not_correctness":True,
            "spatial_cell_count":9,
            "ocr_lines":len(receipt["rapidocr_private_rows"]),
            "zero_or_low_lines":sum(x["zero_or_low_lines"] for x in cells),
            "too_short_or_empty_lines":sum(x["too_short_or_empty_lines"] for x in cells),
            "independent_ground_truth":None,"cer":None,
            "which_ocr_is_correct":None,"root_cause_verified":False,
            "provider_calls":0,"new_model_inferences":0,"model_downloads":0}


def execute(root,manifest,*,write=False,audit=False):
    folder=_private_folder(root)
    dest=folder/REPORT
    if not audit and (dest.exists() or dest.is_symlink()):
        raise VisualGateError("B15_SPATIAL_REPORT_ALREADY_EXISTS")
    data=compute(root,manifest)
    blob=(json.dumps(data,sort_keys=True,separators=(",",":"),
                     ensure_ascii=False)+"\n").encode("utf-8")
    if len(blob)>MAX_REPORT:
        raise VisualGateError("B15_SPATIAL_REPORT_TOO_LARGE")
    if audit:
        if dest.is_symlink() or not dest.is_file() or dest.read_bytes()!=blob:
            raise VisualGateError("B15_SPATIAL_FROZEN_REPORT_CHANGED")
    elif write:
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(dest,flags,0o600),"wb") as out:
            out.write(blob)
    return data


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    modes=parser.add_mutually_exclusive_group()
    modes.add_argument("--write",action="store_true")
    modes.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    result=execute(Path(args.private_root),manifest,
                   write=args.write,audit=args.audit_only)
    print("ACS_B15_SPATIAL_STATUS="+(
        "PRIVATE_CREATED" if args.write else
        "PRIVATE_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_B15_SPATIAL_PAGE=109")
    for cell in result["cells_3x3_row_major"]:
        prefix=f'ACS_B15_SPATIAL_R{cell["row"]}C{cell["col"]}_'
        print(prefix+"LINES="+str(cell["line_count"]))
        print(prefix+"LOW_OR_ZERO="+str(cell["zero_or_low_lines"]))
    print("ACS_B15_SPATIAL_ROOT_CAUSE=UNVERIFIED")
    print("ACS_B15_SPATIAL_OCR_ACCURACY=UNVERIFIED")
    print("ACS_B15_SPATIAL_NEW_MODEL_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,TypeError,OSError,RuntimeError):
        print("ACS_B15_SPATIAL_REJECTED=PRIVATE_SOURCE_OR_GEOMETRY_GATE")
        sys.exit(2)
