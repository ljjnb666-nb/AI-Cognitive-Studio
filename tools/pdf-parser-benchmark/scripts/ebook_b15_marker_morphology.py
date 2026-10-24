#!/usr/bin/env python3
"""Offline source-JPEG glyph-shape proposals for B15 2x2 legend cells.

No OCR, no manual gold and no curve assignment. All raw symbols, source
coordinates, labels, hashes and derived classifications stay in private D:.
Public CI emits only bounded counts and explicit UNVERIFIED markers.
"""
import argparse
from io import BytesIO
import math
import os
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw

import ebook_private_b15_figure_pixel_registration as source
import ebook_b15_four_legend_source_cells as cells

SCHEMA=8
STATUS="B15_SOURCE_MARKER_SHAPE_PROPOSALS_UNVERIFIED"
FILENAME="b15_legend_marker_morphology.v8.private.json"
OVERLAY="b15_legend_marker_morphology.v8.private.png"
MAX_JSON=25000
MAX_PNG=12_000_000
# Source image was visually reviewed in another user-owned file. Its raw bytes
# have NOT been SHA compared with this frozen Windows JPEG; this is a
# provisional expectation only, and must not become a source-attested gold.
PROVISIONAL_EXPECTED=(
    "FILLED_CIRCLE","FILLED_TRIANGLE","HOLLOW_CIRCLE","HOLLOW_TRIANGLE"
)

class GateError(Exception):
    pass

def require(condition):
    if not condition:
        raise GateError("PRIVATE_GLYPH_SOURCE_OR_PROPOSAL_INVALID")

def decode_embedded_jpeg(raw):
    with Image.open(BytesIO(raw)) as image:
        image.load()
        require(image.format=="JPEG" and image.width*image.height<=source.MAX_PIXELS)
        return np.asarray(image.convert("L"),dtype=np.uint8).copy()

def shape_candidate(gray,box):
    """Detect first compact connected glyph at cell start, else abstain.

    Source JPEG may have noisy strokes or text beginning near the symbol.
    Earliest-component selection is deliberately provisional, not semantic.
    """
    require(isinstance(gray,np.ndarray) and gray.ndim==2 and gray.dtype==np.uint8)
    h,w=gray.shape
    require(isinstance(box,list) and len(box)==4 and
            all(type(x) is int for x in box))
    x1,y1,x2,y2=box
    require(0<=x1<x2<=w and 0<=y1<y2<=h)
    cw=x2-x1
    require(cw>=40 and y2-y1>=14)
    start=x1+4
    end=x1+min(75,max(37,int(.40*cw)))
    top=y1+3
    bottom=y2-2
    if not(start<end<=w and top<bottom<=h):
        return {"status":"ABSTAIN_GEOMETRY","classification":None,
                "glyph_box_private":None,"vertices":None,
                "center_is_dark":None}
    segment=gray[top:bottom,start:end]
    black=(segment<155).astype(np.uint8)
    n,labels,stats,centroids=cv2.connectedComponentsWithStats(black,8)
    candidates=[]
    for index in range(1,n):
        xx,yy,ww,hh,area=[int(z) for z in stats[index]]
        # Reject corner/frame traces and unstable tiny text fragments.
        if (xx==0 or yy==0 or xx+ww>black.shape[1] or
                yy+hh>black.shape[0] or not(5<=ww<=25 and 5<=hh<=25) or
                not(.55<=ww/hh<=1.55) or area<12):
            continue
        part=(labels[yy:yy+hh,xx:xx+ww]==index).astype(np.uint8)
        contours,_=cv2.findContours(part,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour=max(contours,key=cv2.contourArea)
        perimeter=cv2.arcLength(contour,True)
        if not math.isfinite(perimeter) or perimeter<=0:
            continue
        vertices=len(cv2.approxPolyDP(contour,.055*perimeter,True))
        # Triangles tend to have 3 corners; tiny antialiased circles
        # often approximate as 4-10 sides. Everything else abstains.
        kind=("TRIANGLE" if vertices==3 else
              "CIRCLE" if 4<=vertices<=10 else None)
        # Use exact source pixel intensity at the center for fill state.
        cy0=max(0,int(hh*.35));cy1=min(hh,max(cy0+1,int(hh*.65)))
        cx0=max(0,int(ww*.35));cx1=min(ww,max(cx0+1,int(ww*.65)))
        center=float(segment[yy+cy0:yy+cy1,xx+cx0:xx+cx1].mean())
        filled=(True if center<100 else False if center>=165 else None)
        candidate=(start+xx, top+yy,ww,hh,int(area),vertices,kind,filled,center)
        candidates.append(candidate)
    candidates.sort(key=lambda r:(r[0],r[1]))
    # No unbounded text/shape guessing when the source offers no clear glyph.
    if not candidates or candidates[0][6] is None or candidates[0][7] is None:
        return {"status":"ABSTAIN_INSUFFICIENT_PIXEL_EVIDENCE",
                "classification":None,"glyph_box_private":None,
                "vertices":None,"center_is_dark":None}
    x,y,ww,hh,area,vertices,kind,filled,center=candidates[0]
    return {"status":"SOURCE_PIXEL_GLYPH_SHAPE_CANDIDATE_NOT_GOLD",
            "classification":("FILLED_" if filled else "HOLLOW_")+kind,
            "glyph_box_private":[x,y,x+ww,y+hh],
            "vertices":vertices,"center_is_dark":filled}

def reconstruct(args):
    # Full source v1-v6 re-generation and exact byte match; neither the
    # prior v7 payload nor user-supplied marker labels alone are trusted.
    v7_expected,old_overlay=cells.read_and_build(args)
    v7=source.json.loads(v7_expected)
    v7_json=source.read_bytes(args.legend_v7,cells.MAX_REPORT)
    v7_png=source.read_bytes(args.legend_image_v7,cells.MAX_SHEET)
    require(v7_json==v7_expected and v7_png==old_overlay)
    page=source.read_bytes(args.page_png,source.MAX_PNG)
    markdown=source.read_bytes(args.mineru_markdown,source.MAX_MD)
    v1=cells.atlas.spatial.read_canonical_json(args.anchor_v1,source.MAX_ANCHOR)
    embedded=source.source_proof(page,markdown,v1)
    gray=decode_embedded_jpeg(embedded)
    marker_rows=v7.get("legend_cells_private")
    require(isinstance(marker_rows,list) and len(marker_rows)==4
            and v7.get("schema_version")==7 and v7.get("status")==cells.STATUS
            and v7.get("legend_candidate_count")==4)
    require(v7.get("embedded_jpeg_sha256_private")==source.sha256(embedded))
    require(v7.get("independent_gold_available") is False and
            v7.get("marker_shape_verified") is False and
            v7.get("series_to_curve_correspondence_verified") is False and
            v7.get("cer",object()) is None)
    predictions=[]
    for i,row in enumerate(marker_rows):
        require(type(row.get("cell_ordinal")) is int and row["cell_ordinal"]==i+1)
        proposed=shape_candidate(gray,row["original_embedded_jpeg_pixel_box_private"])
        proposed["cell_ordinal"]=i+1
        proposed["provisional_visual_reference_match_not_gold"]=(
            proposed["classification"]==PROVISIONAL_EXPECTED[i]
            if proposed["classification"] else None)
        predictions.append(proposed)
    matched=sum(row["provisional_visual_reference_match_not_gold"] is True for row in predictions)
    classified=sum(row["classification"] is not None for row in predictions)
    # Draw only predicted bounding boxes, never text or claimed truth.
    with Image.open(BytesIO(embedded)) as src:
        src.load()
        canvas=src.convert("RGB")
    draw=ImageDraw.Draw(canvas)
    for row in predictions:
        if row["glyph_box_private"] is not None:
            draw.rectangle(row["glyph_box_private"],outline=(220,38,38),width=2)
    b=BytesIO();canvas.save(b,format="PNG");image=b.getvalue()
    require(0<len(image)<=MAX_PNG)
    report={
        "schema_version":SCHEMA,"status":STATUS,
        "book_id":"B15","physical_page":109,"figure_id":"1-4-16",
        "prior_v7_sha256_private":source.sha256(v7_json),
        "embedded_jpeg_sha256_private":source.sha256(embedded),
        "glyph_overlay_sha256_private":source.sha256(image),
        "marker_source_pixel_candidate_count":classified,
        "provisional_reference_shape_agreement_count_not_gold":matched,
        "provisional_reference_status":"SEPARATE_VISUAL_FILE_NOT_SOURCE_SHA_ATTESTED",
        "legend_rows_private":predictions,
        "marker_shape_independently_verified":False,
        "symbol_to_label_verified":False,
        "symbol_to_curve_verified":False,
        "independent_gold_available":False,"cer":None,
        "new_ocr_calls":0,"new_cloud_calls":0}
    raw=source.canonical(report)
    require(0<len(raw)<=MAX_JSON)
    return raw,image,classified,matched

def exclusive(path,contents):
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
    if hasattr(os,"O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as handle:
        handle.write(contents)

def run(args):
    raw,image,classified,matched=reconstruct(args)
    root=Path(args.private_dir)
    require(root.is_dir() and not root.is_symlink())
    paths=((root/FILENAME,raw),(root/OVERLAY,image))
    if args.audit_only:
        for p,expected in paths:
            require(source.read_bytes(p,MAX_JSON if p.suffix==".json" else MAX_PNG)==expected)
    else:
        require(all(not p.exists() and not p.is_symlink() for p,_ in paths))
        for p,contents in paths:
            exclusive(p,contents)
    return classified,matched

def main(argv=None):
    p=argparse.ArgumentParser()
    for k in ("page-png","mineru-markdown","anchor-v1","pixel-v3",
              "feature-v4","feature-overlay-v4","quad-v5","quad-overlay-v5",
              "atlas-v6","atlas-image-v6","atlas-html-v6","legend-v7",
              "legend-image-v7","private-dir"):
        p.add_argument("--"+k,required=True)
    p.add_argument("--audit-only",action="store_true")
    a=p.parse_args(argv)
    try:
        found,agreed=run(a)
        print("ACS_B15_MARKER_MORPHOLOGY="+("PRIVATE_AUDIT_PASS" if a.audit_only else "PRIVATE_CREATED"))
        print("ACS_B15_MARKER_CANDIDATE_COUNT="+str(found))
        print("ACS_B15_MARKER_PROVISIONAL_AGREEMENT_COUNT="+str(agreed))
        print("ACS_B15_MARKER_GOLD=UNVERIFIED")
        print("ACS_B15_MARKER_CURVE=UNVERIFIED")
        print("ACS_B15_MARKER_NEW_MODEL_CALLS=0")
    except Exception:
        print("ACS_B15_MARKER_MORPHOLOGY=REJECTED")
        return 2
    return 0

if __name__=="__main__":
    sys.exit(main())
