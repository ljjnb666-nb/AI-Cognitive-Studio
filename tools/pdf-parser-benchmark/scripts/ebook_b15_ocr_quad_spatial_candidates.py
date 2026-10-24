#!/usr/bin/env python3
"""Source-bound B15 RapidOCR quadrilaterals against private figure ROIs.

Geometry-only candidate assignment; not validated graph semantics or OCR gold.
Never print, publish or upload private OCR text, quads, ROI boxes, or SHA.
"""
import argparse
import math
import os
from io import BytesIO
from pathlib import Path
import sys

import ebook_private_b15_figure_pixel_registration as pixel
import ebook_b15_feature_crosscheck as features

STATUS = "OCR_QUAD_FIGURE_SPATIAL_CANDIDATES_UNVERIFIED"
MAX_JSON = 140_000
MAX_OVERLAY = 12_000_000

class GateError(Exception):
    pass

def need(condition):
    if not condition:
        raise GateError("UNVERIFIED_OR_INVALID_PRIVATE_EVIDENCE")

def _num(value):
    return type(value) in (int,float) and math.isfinite(value)

def quad_box(quad,width,height):
    need(isinstance(quad,list) and len(quad)==4)
    need(all(isinstance(p,list) and len(p)==2 and all(_num(v) for v in p)
             for p in quad))
    xs=[p[0] for p in quad]; ys=[p[1] for p in quad]
    need(all(0<=v<=width for v in xs) and all(0<=v<=height for v in ys))
    box=[min(xs),min(ys),max(xs),max(ys)]
    need(box[2]-box[0]>=1 and box[3]-box[1]>=1)
    return box

def overlap_fraction(text_box, region):
    a,b=text_box,region
    x=max(0,min(a[2],b[2])-max(a[0],b[0]))
    y=max(0,min(a[3],b[3])-max(a[1],b[1]))
    area=(a[2]-a[0])*(a[3]-a[1])
    return round(x*y/area,6)

def spatial_bucket(frac):
    if frac >= 0.8:
        return "MOSTLY_WITHIN_UNVERIFIED_ROI"
    if frac > 0:
        return "PARTIALLY_INTERSECTS_UNVERIFIED_ROI"
    return "OUTSIDE_UNVERIFIED_ROI"

def validate(page,markdown,v1,v3,v4,previous_overlay):
    # Existing exact-source check includes SHA of original PNG/Markdown,
    # selected MinerU image, candidate count 19 and all authority flags.
    image=pixel.source_proof(page,markdown,v1)
    source,pix_figure=features.validate_v3(v3,page,markdown,v1)
    need(isinstance(v4,dict) and type(v4.get("schema_version")) is int
         and v4["schema_version"]==4 and v4.get("status")==features.STATUS)
    need(v4.get("book_id")=="B15" and v4.get("physical_page")==109
         and v4.get("figure_id")=="1-4-16")
    need(v4.get("prior_v3_sha256_private")==pixel.sha256(pixel.canonical(v3)))
    need(v4.get("original_png_sha256_private")==pixel.sha256(page))
    need(v4.get("review_overlay_sha256_private")==pixel.sha256(previous_overlay))
    for k in ("original_page_pixel_registration_verified",
              "figure_text_label_to_marker_verified",
              "series_to_curve_correspondence_verified",
              "independent_gold_available"):
        need(v4.get(k) is False)
    need(v4.get("cer",object()) is None)
    boxes=[z["source_page_pixel_box_candidate"] for z in v3["registration"]["hypotheses"]]
    need(v4.get("template_boxes_private")==boxes)
    feat=v4.get("independent_feature_candidate")
    need(isinstance(feat,dict) and type(feat.get("feature_correlated_candidate")) is bool)
    need(feat.get("status") in (
        "INSUFFICIENT_INDEPENDENT_FEATURE_EVIDENCE",
        "FEATURE_TEMPLATE_CONFLICT_REVIEW_REQUIRED",
        "GEOMETRY_CANDIDATES_CROSS_METHOD_CONSISTENT_UNVERIFIED"))
    if feat["feature_correlated_candidate"]:
        need(feat["status"]=="GEOMETRY_CANDIDATES_CROSS_METHOD_CONSISTENT_UNVERIFIED")
        need(isinstance(feat.get("proposal_box_private"),list)
             and len(feat["proposal_box_private"])==4)
        feature_box=feat["proposal_box_private"]
        need(all(type(z) is int for z in feature_box))
        w,h=source.shape[1],source.shape[0]
        need(0<=feature_box[0]<feature_box[2]<=w and 0<=feature_box[1]<feature_box[3]<=h)
    else:
        feature_box=None
    need(pixel.sha256(image)==v3.get("embedded_figure_jpeg_sha256_private"))
    return source,boxes,feature_box

def build(page,markdown,v1,v3,v4,previous_overlay):
    source,boxes,feature_box=validate(page,markdown,v1,v3,v4,previous_overlay)
    width,height=source.shape[1],source.shape[0]
    rows=v1.get("page_source_ocr_candidates")
    need(isinstance(rows,list) and len(rows)==19 and v1.get("candidate_count")==19)
    results=[]
    for pos,item in enumerate(rows):
        need(isinstance(item,dict) and type(item.get("page_row_index")) is int)
        need(0<=item["page_row_index"]<200
             and isinstance(item.get("text_candidate"),str)
             and len(item["text_candidate"])<=500)
        need(_num(item.get("recognizer_confidence_not_accuracy")))
        need(0<=item["recognizer_confidence_not_accuracy"]<=1)
        box=quad_box(item.get("source_page_quad_candidate"),width,height)
        scores=[overlap_fraction(box,b) for b in boxes]
        # Select the TOP template proposal (v3 is confidence-sorted).
        # Other candidates reported as alternatives, never used to claim truth.
        primary=scores[0]
        feature_score=(overlap_fraction(box,feature_box)
                       if feature_box is not None else None)
        results.append({
          "original_page_row_index":item["page_row_index"],
          "ocr_text_private_not_gold":item["text_candidate"],
          "ocr_quad_private":item["source_page_quad_candidate"],
          "ocr_bbox_private":box,
          "recognizer_confidence_not_accuracy":item["recognizer_confidence_not_accuracy"],
          "top_template_fraction":primary,
          "alternative_template_fractions":scores[1:],
          "top_template_bucket":spatial_bucket(primary),
          "independent_feature_fraction":feature_score,
          "independent_feature_bucket":(spatial_bucket(feature_score)
                                        if feature_score is not None else "NO_FEATURE_PROPOSAL"),
          "source_page_quad_to_png_frame_independently_verified":False,
          "label_symbol_or_curve_assignment_verified":False,
        })
    need(len(set(x["original_page_row_index"] for x in results))==19)
    tally={b:sum(row["top_template_bucket"]==b for row in results)
           for b in ("MOSTLY_WITHIN_UNVERIFIED_ROI",
                     "PARTIALLY_INTERSECTS_UNVERIFIED_ROI",
                     "OUTSIDE_UNVERIFIED_ROI")}
    return {
        "schema_version":5,"status":STATUS,
        "book_id":"B15","physical_page":109,"figure_id":"1-4-16",
        "source_page_png_sha256_private":pixel.sha256(page),
        "prior_v1_sha256_private":pixel.sha256(pixel.canonical(v1)),
        "prior_v3_sha256_private":pixel.sha256(pixel.canonical(v3)),
        "prior_v4_sha256_private":pixel.sha256(pixel.canonical(v4)),
        "source_page_dimensions":[width,height],
        "candidate_figure_boxes_private":boxes,
        "feature_crosscheck_box_private":feature_box,
        "ocr_page_quad_frame":"SAME_SHA_PINNED_RAPIDOCR_PAGE_PNG",
        "ocr_row_count":19,"spatial_bucket_counts":tally,
        "ocr_candidate_spatial_rows_private":results,
        "source_pixel_frame_to_ocr_quad_independently_verified":False,
        "figure_roi_geometry_independently_verified":False,
        "label_to_marker_correspondence_verified":False,
        "series_to_curve_correspondence_verified":False,
        "independent_gold_available":False,
        "cer":None,"new_ocr_calls":0,"new_cloud_calls":0,
        "next_review":"VISUALLY_REVIEW_PRIVATE_SOURCE_ROI_AND_SYMBOL_TEXT"
    }

def make_overlay(page,report):
    # Pixel boxes and row indices only. No original source text painted over
    # the image; both the original pixels and drawn quads remain private.
    from PIL import Image,ImageDraw
    with Image.open(BytesIO(page)) as source:
        source.load()
        need(source.format=="PNG" and source.width*source.height<=pixel.MAX_PIXELS)
        img=source.convert("RGB")
    draw=ImageDraw.Draw(img)
    boxes=report["candidate_figure_boxes_private"]
    draw.rectangle(boxes[0],outline=(255,65,40),width=4)
    for alt in boxes[1:]:
        draw.rectangle(alt,outline=(250,165,60),width=1)
    if report["feature_crosscheck_box_private"] is not None:
        draw.rectangle(report["feature_crosscheck_box_private"],outline=(0,180,200),width=3)
    for pos,row in enumerate(report["ocr_candidate_spatial_rows_private"]):
        q=[tuple(x) for x in row["ocr_quad_private"]]
        draw.line(q+[q[0]],fill=(40,135,250),width=2)
        draw.text((q[0][0],q[0][1]),f"R{pos+1}",fill=(50,45,240))
    buffer=BytesIO()
    img.save(buffer,format="PNG")
    data=buffer.getvalue()
    need(0<len(data)<=MAX_OVERLAY)
    return data

def read_canonical_json(path,limit):
    raw=pixel.read_bytes(path,limit)
    obj=pixel.read_json(path,limit)
    need(raw==pixel.canonical(obj))
    return obj

def exclusive(path,data):
    flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
    if hasattr(os,"O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as stream:
        stream.write(data)

def run(page_path,md_path,v1_path,v3_path,v4_path,previous_overlay_path,
        report_path,new_overlay_path,*,audit_only):
    page=pixel.read_bytes(page_path,pixel.MAX_PNG)
    markdown=pixel.read_bytes(md_path,pixel.MAX_MD)
    v1=read_canonical_json(v1_path,pixel.MAX_ANCHOR)
    v3=read_canonical_json(v3_path,32_000)
    v4=read_canonical_json(v4_path,50_000)
    previous=pixel.read_bytes(previous_overlay_path,MAX_OVERLAY)
    result=build(page,markdown,v1,v3,v4,previous)
    raw=pixel.canonical(result)
    overlay=make_overlay(page,result)
    need(0<len(raw)<=MAX_JSON)
    a,b=Path(report_path),Path(new_overlay_path)
    need(a!=b)
    if audit_only:
        need(pixel.read_bytes(a,MAX_JSON)==raw)
        need(pixel.read_bytes(b,MAX_OVERLAY)==overlay)
    else:
        need(not a.exists() and not a.is_symlink())
        need(not b.exists() and not b.is_symlink())
        exclusive(a,raw)
        exclusive(b,overlay)
    return result

def main(argv=None):
    p=argparse.ArgumentParser()
    for name in ("page-png","mineru-markdown","anchor-v1","pixel-v3","feature-v4",
                 "feature-overlay-v4","private-output","private-overlay"):
        p.add_argument("--"+name,required=True)
    p.add_argument("--audit-only",action="store_true")
    a=p.parse_args(argv)
    try:
        report=run(a.page_png,a.mineru_markdown,a.anchor_v1,a.pixel_v3,a.feature_v4,
                   a.feature_overlay_v4,a.private_output,a.private_overlay,
                   audit_only=a.audit_only)
        print("ACS_B15_QUAD_SPATIAL="+("PRIVATE_AUDIT_PASS" if a.audit_only else "PRIVATE_CREATED"))
        print("ACS_B15_QUAD_ROWS=19")
        print("ACS_B15_QUAD_SPATIAL_ROI=UNVERIFIED")
        print("ACS_B15_QUAD_SYMBOL_CURVE=UNVERIFIED")
        print("ACS_B15_QUAD_GOLD=UNVERIFIED")
        print("ACS_B15_QUAD_NEW_MODEL_CALLS=0")
    except Exception:
        # No tracebacks, private OCR text, polygons, raw JSON, paths or SHA.
        print("ACS_B15_QUAD_SPATIAL=REJECTED")
        return 2
    return 0

if __name__=="__main__":
    sys.exit(main())
