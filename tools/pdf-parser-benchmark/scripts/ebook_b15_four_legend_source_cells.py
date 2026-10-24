#!/usr/bin/env python3
"""B15 p109 four *unreviewed* legend-cell pixels from the SHA-locked MinerU JPEG.

A horizontal legend-frame candidate is detected from source pixels only.
Four 2x2 regions are retained as private review evidence, never labeled with
OCR text or assigned to curves. Source pixels, ROI coordinates and hashes stay
in private D: and cannot enter public Actions logs.
"""
import argparse
from io import BytesIO
import os
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw

import ebook_private_b15_figure_pixel_registration as pixel
import ebook_b15_private_legend_contact_sheet as atlas

VERSION=7
STATUS="FOUR_LEGEND_CELLS_PIXEL_CANDIDATES_NOT_GOLD"
FILENAME_JSON="b15_four_legend_source_cells.v7.private.json"
FILENAME_PNG="b15_four_legend_source_cells.v7.private.png"
MAX_REPORT=25_000
MAX_SHEET=12_000_000
MAX_JPEG=5_000_000

class GateError(Exception):
    pass

def require(cond):
    if not cond:
        raise GateError("B15_PRIVATE_SOURCE_OR_GEOMETRY_REJECTED")

def find_frame(image):
    """Find a long dark horizontal top border in the JPEG lower region.

    Only a *candidate* frame. Do not infer label/marker semantic membership.
    """
    require(isinstance(image,np.ndarray) and image.dtype==np.uint8
            and image.ndim==2)
    h,w=image.shape
    require(120<=h<=2200 and 150<=w<=2200 and h*w<=pixel.MAX_PIXELS)
    binary=np.where(image<125,255,0).astype(np.uint8)
    min_y=int(h*.83)
    kernel=np.ones((1,max(40,int(w*.30))),dtype=np.uint8)
    horizontal=cv2.morphologyEx(binary,cv2.MORPH_OPEN,kernel)
    scores=(horizontal[min_y:h-2]>0).sum(axis=1)
    candidates=np.flatnonzero(scores>=int(w*.34))
    if len(candidates)==0:
        raise GateError("B15_LEGEND_BORDER_NOT_DETECTED")
    y=min_y+int(candidates[0])
    band=horizontal[y:min(y+4,h-2),:]
    xs=np.flatnonzero((band>0).any(axis=0))
    require(len(xs)>int(w*.34))
    x1,x2=int(xs[0]),int(xs[-1]+1)
    require(.30 <= (x2-x1)/w <= .85)
    require(.025 <= (h-y)/h <= .17)
    require(3<x1<x2<w-3 and y<h-20)
    return [x1,y,x2,h]

def four_boxes(rect):
    x1,y1,x2,y2=rect
    require(x2-x1>=100 and y2-y1>=35)
    middle_x=(x1+x2)//2
    middle_y=(y1+y2)//2
    require(middle_x-x1>=40 and x2-middle_x>=40)
    require(middle_y-y1>=14 and y2-middle_y>=14)
    return [[x1+2,y1+2,middle_x,middle_y],
            [middle_x,y1+2,x2-2,middle_y],
            [x1+2,middle_y,middle_x,y2],
            [middle_x,middle_y,x2-2,y2]]

def cells_sheet(raw_jpeg):
    require(100<len(raw_jpeg)<=MAX_JPEG)
    with Image.open(BytesIO(raw_jpeg)) as inp:
        inp.load()
        require(inp.format=="JPEG" and inp.width*inp.height<=pixel.MAX_PIXELS)
        source=inp.convert("RGB")
    original=np.asarray(source.convert("L"),dtype=np.uint8)
    frame=find_frame(original)
    boxes=four_boxes(frame)
    full=Image.new("RGB",(900,480),(255,255,255))
    draw=ImageDraw.Draw(full)
    draw.text((16,8),"B15 FIGURE 1-4-16 | UNREVIEWED SOURCE PIXEL CELLS",fill=(45,47,76))
    markers=[]
    for i,box in enumerate(boxes):
        crop=source.crop(tuple(box))
        require(crop.width>0 and crop.height>0)
        col=i%2; row=i//2
        x0=18+col*450; y0=34+row*215
        draw.rectangle((x0,y0,x0+420,y0+202),outline=(140,153,172),width=2)
        draw.text((x0+8,y0+6),"CELL "+str(i+1)+" / SOURCE ONLY",fill=(20,35,58))
        crop.thumbnail((402,166),Image.Resampling.NEAREST)
        full.paste(crop,(x0+9+(402-crop.width)//2,y0+28+(166-crop.height)//2))
        markers.append({
          "cell_ordinal":i+1,
          "reading_layout_candidate":"ROW_MAJOR_TWO_BY_TWO_NOT_ATTESTED",
          "original_embedded_jpeg_pixel_box_private":box,
          "symbol_shape_candidate":None,
          "label_text_verified":False,
          "marker_shape_verified":False,
          "symbol_to_label_verified":False,
          "symbol_to_curve_verified":False,
          "independent_reference_gold":False
        })
    output=BytesIO();full.save(output,format="PNG")
    sheet=output.getvalue()
    require(0<len(sheet)<=MAX_SHEET)
    return frame,markers,sheet

def build(source_png,markdown,v1,atlas_json,atlas_png,atlas_html):
    # Verify the existing v6 independently recomputed from v1/v3/v4/v5
    # before using a source JPEG; never trust an arbitrary replacement JPEG.
    require(atlas_json.get("schema_version")==6 and
            atlas_json.get("status")==atlas.STATUS and
            atlas_json.get("row_count")==19)
    require(atlas_json.get("source_page_png_sha256_private")==pixel.sha256(source_png))
    require(atlas_json.get("sheet_png_sha256_private")==pixel.sha256(atlas_png))
    require(atlas_json.get("html_sha256_private")==pixel.sha256(atlas_html))
    for key in ("candidate_geometry_verified","marker_shape_verified",
                "ocr_text_verified","label_to_symbol_verified",
                "symbol_to_curve_verified","independent_gold_available"):
        require(atlas_json.get(key) is False)
    require(atlas_json.get("cer",object()) is None)
    embedded=pixel.source_proof(source_png,markdown,v1)
    frame,markers,sheet=cells_sheet(embedded)
    report={
      "schema_version":VERSION,
      "status":STATUS,
      "book_id":"B15","physical_page":109,"figure_id":pixel.FIGURE_ID,
      "source_page_png_sha256_private":pixel.sha256(source_png),
      "prior_v1_sha256_private":pixel.sha256(pixel.canonical(v1)),
      "prior_v6_sha256_private":pixel.sha256(pixel.canonical(atlas_json)),
      "embedded_jpeg_sha256_private":pixel.sha256(embedded),
      "frame_detection":"SOURCE_PIXEL_LONG_HORIZONTAL_BORDER_CANDIDATE",
      "legend_frame_box_private":frame,
      "legend_candidate_count":4,
      "legend_cells_private":markers,
      "sheet_png_sha256_private":pixel.sha256(sheet),
      "figure_frame_independently_verified":False,
      "marker_shape_verified":False,
      "label_to_marker_verified":False,
      "series_to_curve_correspondence_verified":False,
      "independent_gold_available":False,
      "cer":None,
      "new_ocr_calls":0,"new_cloud_calls":0
    }
    data=pixel.canonical(report)
    require(0<len(data)<=MAX_REPORT)
    return data,sheet

def read_and_build(args):
    source=pixel.read_bytes(args.page_png,pixel.MAX_PNG)
    md=pixel.read_bytes(args.mineru_markdown,pixel.MAX_MD)
    v1=atlas.spatial.read_canonical_json(args.anchor_v1,pixel.MAX_ANCHOR)
    v3=atlas.spatial.read_canonical_json(args.pixel_v3,32_000)
    v4=atlas.spatial.read_canonical_json(args.feature_v4,50_000)
    v4_image=pixel.read_bytes(args.feature_overlay_v4,MAX_SHEET)
    v5=atlas.spatial.read_canonical_json(args.quad_v5,atlas.spatial.MAX_JSON)
    v5_image=pixel.read_bytes(args.quad_overlay_v5,MAX_SHEET)
    v6=atlas.spatial.read_canonical_json(args.atlas_v6,atlas.MAX_REPORT)
    v6_image=pixel.read_bytes(args.atlas_image_v6,MAX_SHEET)
    v6_html=pixel.read_bytes(args.atlas_html_v6,atlas.MAX_HTML)
    original_report,original_image,original_html=atlas.render(
        source,md,v1,v3,v4,v4_image,v5,v5_image)
    require(pixel.canonical(v6)==original_report and
            v6_image==original_image and v6_html==original_html)
    return build(source,md,v1,v6,v6_image,v6_html)

def exclusive(path,data):
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
    if hasattr(os,"O_NOFOLLOW"):flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as file:
        file.write(data)

def run(args):
    data,image=read_and_build(args)
    folder=Path(args.private_dir)
    require(folder.is_dir() and not folder.is_symlink())
    outputs=((folder/FILENAME_JSON,data),(folder/FILENAME_PNG,image))
    if args.audit_only:
        for p,expected in outputs:
            require(pixel.read_bytes(p,MAX_REPORT if p.suffix==".json" else MAX_SHEET)==expected)
    else:
        require(all(not p.exists() and not p.is_symlink() for p,_ in outputs))
        for p,raw in outputs:exclusive(p,raw)
    return 4

def main(argv=None):
    p=argparse.ArgumentParser()
    for name in ("page-png","mineru-markdown","anchor-v1","pixel-v3",
                 "feature-v4","feature-overlay-v4","quad-v5","quad-overlay-v5",
                 "atlas-v6","atlas-image-v6","atlas-html-v6","private-dir"):
        p.add_argument("--"+name,required=True)
    p.add_argument("--audit-only",action="store_true")
    args=p.parse_args(argv)
    try:
        run(args)
        print("ACS_B15_LEGEND_CELLS="+("PRIVATE_AUDIT_PASS" if args.audit_only else "PRIVATE_CREATED"))
        print("ACS_B15_LEGEND_CELLS_COUNT=4")
        print("ACS_B15_LEGEND_FRAME=UNVERIFIED")
        print("ACS_B15_LEGEND_SYMBOL_TO_CURVE=UNVERIFIED")
        print("ACS_B15_LEGEND_GOLD=UNVERIFIED")
        print("ACS_B15_LEGEND_NEW_MODEL_CALLS=0")
    except Exception:
        # Never echo exception: input may contain private book content and SHA.
        print("ACS_B15_LEGEND_CELLS=REJECTED")
        return 2
    return 0

if __name__=="__main__":
    sys.exit(main())
