#!/usr/bin/env python3
"""Private B15 figure 1-4-16 source-pixel contact sheet for symbol/label review.

Uses immutable, source-verified OCR quadrilaterals and original page pixels.
Only a *review aid*: pixel context is NOT marker/curve semantics or OCR gold.
No private text, image, polygon, filename, SHA or exception enters public logs.
"""
import argparse
from io import BytesIO
import html
import os
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageOps, ImageFont

import ebook_private_b15_figure_pixel_registration as pixel
import ebook_b15_ocr_quad_spatial_candidates as spatial
import ebook_b15_safe_spatial_coverage as coverage

SCHEMA=6
STATUS="B15_SOURCE_PIXEL_CONTEXT_ATLAS_UNREVIEWED"
MAX_REPORT=85_000
MAX_IMAGE=12_000_000
MAX_HTML=90_000
IMG_NAME="b15_legend_source_context_atlas.v6.private.png"
DOC_NAME="b15_legend_source_context_atlas.v6.private.html"
REPORT_NAME="b15_legend_source_context_atlas.v6.private.json"
MAX_ROWS=19
WIDTH=1160
ROW_HEIGHT=100
HEADER_HEIGHT=54
COLUMNS=((24,250),(260,824),(834,1124))
HEADERS=("左侧邻域（原始像素）","OCR 文字框对应原始像素","右侧邻域（原始像素）")

class PrivateAtlasError(Exception):
    pass

def require(value):
    if not value:
        raise PrivateAtlasError("PRIVATE_SOURCE_OR_ATLAS_INVALID")

def clamp_box(box,w,h):
    x1,y1,x2,y2=[int(round(z)) for z in box]
    result=[max(0,min(w,x1)),max(0,min(h,y1)),max(0,min(w,x2)),max(0,min(h,y2))]
    require(result[2]>result[0] and result[3]>result[1])
    return result

def patch_boxes(row,w,h,figure_roi):
    # Crop the OCR box as-is; left/right neighborhoods stay within the
    # *candidate* figure ROI. Empty edge strips are encoded as absent, not
    # fabricated marker sightings.
    x1,y1,x2,y2=row["ocr_bbox_private"]
    ht=max(8,int(round(y2-y1)))
    pad=max(6,ht//2)
    side=min(260,max(65,ht*5))
    top=max(figure_roi[1],y1-pad,0)
    bottom=min(figure_roi[3],y2+pad,h)
    require(top<bottom)
    region=clamp_box([x1-pad,top,x2+pad,bottom],w,h)
    left=None
    right=None
    if x1-side< x1 and x1>figure_roi[0]:
        lo=max(figure_roi[0],x1-side,0)
        hi=min(figure_roi[2],x1-3,w)
        if hi>lo+4:
            left=clamp_box([lo,top,hi,bottom],w,h)
    if x2 <figure_roi[2]:
        lo=max(figure_roi[0],x2+3,0)
        hi=min(figure_roi[2],x2+side,w)
        if hi>lo+4:
            right=clamp_box([lo,top,hi,bottom],w,h)
    return left,region,right

def pack_page(page,v5):
    with Image.open(BytesIO(page)) as im:
        im.load()
        require(im.format=="PNG" and 0<im.width*im.height<=pixel.MAX_PIXELS)
        original=im.convert("RGB")
    bounds=v5["candidate_figure_boxes_private"][0]
    figure_roi=clamp_box(bounds,*original.size)
    rows=v5["ocr_candidate_spatial_rows_private"]
    require(len(rows)==MAX_ROWS)
    metadata=[]
    canvas=Image.new("RGB",(WIDTH,HEADER_HEIGHT+MAX_ROWS*ROW_HEIGHT),(255,255,255))
    draw=ImageDraw.Draw(canvas)
    # Latin IDs survive without requiring a Chinese font on the Windows host.
    for col,header in enumerate(("LEFT SOURCE", "SOURCE OCR BOX", "RIGHT SOURCE")):
        draw.text((COLUMNS[col][0]+4,14),header,fill=(15,25,40))
    for idx,row in enumerate(rows):
        require(row.get("label_symbol_or_curve_assignment_verified") is False)
        left,center,right=patch_boxes(row,*original.size,figure_roi)
        y=HEADER_HEIGHT+idx*ROW_HEIGHT
        draw.rectangle((0,y,WIDTH,y+ROW_HEIGHT-1),outline=(226,231,238))
        draw.text((4,y+18),f"R{idx+1:02}",fill=(15,25,40))
        for j,crop_box in enumerate((left,center,right)):
            x0,x1=COLUMNS[j]
            draw.rectangle((x0,y+5,x1,y+ROW_HEIGHT-6),outline=(210,217,226))
            if crop_box is not None:
                part=original.crop(tuple(crop_box))
                part.thumbnail((x1-x0-12,ROW_HEIGHT-16),Image.Resampling.LANCZOS)
                canvas.paste(part,(x0+6+(x1-x0-12-part.width)//2,
                                   y+8+(ROW_HEIGHT-16-part.height)//2))
        metadata.append({
            "ordinal_index":idx+1,
            "original_page_row_index":row["original_page_row_index"],
            "page_source_ocr_quad_private":row["ocr_quad_private"],
            "left_original_pixel_box_private":left,
            "text_original_pixel_box_private":center,
            "right_original_pixel_box_private":right,
            "marker_shape_verified":False,
            "ocr_text_verified":False,
            "label_to_symbol_verified":False,
            "symbol_to_curve_verified":False,
            "review_status":"SOURCE_PIXELS_ONLY_UNREVIEWED"
        })
    output=BytesIO();canvas.save(output,format="PNG")
    image=output.getvalue()
    require(0<len(image)<=MAX_IMAGE)
    return image,metadata

def html_document(rows,img_name):
    require(img_name==IMG_NAME and len(rows)==19)
    parts=[
        "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">",
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'\">",
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
        "<title>B15 图内原图局部证据｜尚未审核</title>",
        "<style>body{font:16px system-ui,Arial,sans-serif;max-width:1180px;margin:auto;padding:24px;color:#223;background:#f6f8fb}",
        "h1{font-size:1.4rem}.note{background:white;padding:16px;border-left:4px solid #5866a6}",
        "img{display:block;max-width:100%;border:1px solid #bbc}table{width:100%;border-collapse:collapse;background:white}",
        "td,th{border-bottom:1px solid #dde;padding:9px;text-align:left}code{font-size:.9rem;white-space:pre-wrap}",
        "tr:nth-child(even){background:#f2f5fa}</style></head><body>",
        "<h1>B15 第 109 物理页 · 图 1-4-16 · 来源像素证据</h1>",
        "<p class=\"note\">本页的图片及文字均来自私有、未核准的 OCR 与原书像素。左右邻域只是可能存在标记的来源像素，不是已识别图例；不自动填入四类标记、文字标签或曲线关系。独立 gold / CER 均未完成。</p>",
        "<p>源页像素的逐行左邻域、OCR 框和右邻域：</p>",
        "<img src=\""+img_name+"\" alt=\"19 条候选的原始像素局部对照板\">",
        "<h2>仅供离线核对的 OCR 原始候选（尚非正确文本）</h2>",
        "<table><thead><tr><th>候选</th><th>RapidOCR 原文字</th><th>审核状态</th></tr></thead><tbody>",
    ]
    for i,row in enumerate(rows):
        value=row["ocr_text_private_not_gold"]
        require(isinstance(value,str) and len(value)<=500)
        parts.append("<tr><td>R%02d</td><td><code>%s</code></td><td>未审核</td></tr>" %
                    (i+1,html.escape(value,quote=True)))
    parts.append("</tbody></table><p>仅保存在本地 D: 私有 Benchmark 目录；不上传 GitHub/Actions Artifact。</p></body></html>")
    return "".join(parts).encode("utf-8")

def render(page,markdown,v1,v3,v4,v4_overlay,v5,v5_overlay):
    # Verify all v1~v5 provenance and fresh v5 result byte-for-byte.
    regenerated=spatial.build(page,markdown,v1,v3,v4,v4_overlay)
    require(pixel.canonical(v5)==pixel.canonical(regenerated))
    require(v5.get("schema_version")==5 and v5.get("status")==spatial.STATUS
            and v5.get("ocr_row_count")==19 and v5.get("independent_gold_available") is False
            and v5.get("cer",object()) is None)
    require(v5_overlay==spatial.make_overlay(page,v5))
    sheet,metadata=pack_page(page,v5)
    document=html_document(v5["ocr_candidate_spatial_rows_private"],IMG_NAME)
    require(0<len(document)<=MAX_HTML)
    result={
        "schema_version":SCHEMA,"status":STATUS,
        "book_id":"B15","physical_page":109,"figure_id":"1-4-16",
        "prior_v5_sha256_private":pixel.sha256(pixel.canonical(v5)),
        "source_page_png_sha256_private":pixel.sha256(page),
        "sheet_png_sha256_private":pixel.sha256(sheet),
        "html_sha256_private":pixel.sha256(document),
        "sheet_filename_private":IMG_NAME,
        "html_filename_private":DOC_NAME,
        "row_count":19,
        "source_context_rows_private":metadata,
        "candidate_geometry_verified":False,
        "marker_shape_verified":False,
        "ocr_text_verified":False,
        "label_to_symbol_verified":False,
        "symbol_to_curve_verified":False,
        "independent_gold_available":False,
        "cer":None,
        "new_model_calls":0
    }
    data=pixel.canonical(result)
    require(len(data)<=MAX_REPORT)
    return data,sheet,document

def read_inputs(argv):
    page=pixel.read_bytes(argv.page_png,pixel.MAX_PNG)
    markdown=pixel.read_bytes(argv.mineru_markdown,pixel.MAX_MD)
    v1=spatial.read_canonical_json(argv.anchor_v1,pixel.MAX_ANCHOR)
    v3=spatial.read_canonical_json(argv.pixel_v3,32_000)
    v4=spatial.read_canonical_json(argv.feature_v4,50_000)
    v4_overlay=pixel.read_bytes(argv.feature_overlay_v4,MAX_IMAGE)
    v5=spatial.read_canonical_json(argv.quad_v5,spatial.MAX_JSON)
    v5_overlay=pixel.read_bytes(argv.quad_overlay_v5,MAX_IMAGE)
    return render(page,markdown,v1,v3,v4,v4_overlay,v5,v5_overlay)

def exclusive(path,data):
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
    if hasattr(os,"O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as stream:
        stream.write(data)

def run(args):
    report,sheet,document=read_inputs(args)
    directory=Path(args.private_output_dir)
    require(directory.is_dir() and not directory.is_symlink())
    outputs=((directory/REPORT_NAME,report),
             (directory/IMG_NAME,sheet),
             (directory/DOC_NAME,document))
    if args.audit_only:
        for name,expected in outputs:
            limit=MAX_REPORT if name.suffix==".json" else MAX_HTML if name.suffix==".html" else MAX_IMAGE
            require(pixel.read_bytes(name,limit)==expected)
    else:
        require(all(not p.exists() and not p.is_symlink() for p,_ in outputs))
        for name,data in outputs:
            exclusive(name,data)
    return len(sheet)

def main(argv=None):
    p=argparse.ArgumentParser()
    for key in ("page-png","mineru-markdown","anchor-v1","pixel-v3",
                "feature-v4","feature-overlay-v4","quad-v5","quad-overlay-v5",
                "private-output-dir"):
        p.add_argument("--"+key,required=True)
    p.add_argument("--audit-only",action="store_true")
    args=p.parse_args(argv)
    try:
        run(args)
        print("ACS_B15_SOURCE_ATLAS="+("PRIVATE_VERIFIED" if args.audit_only else "PRIVATE_CREATED"))
        print("ACS_B15_SOURCE_ATLAS_ROWS=19")
        print("ACS_B15_SOURCE_ATLAS_MARKERS=UNVERIFIED")
        print("ACS_B15_SOURCE_ATLAS_CURVES=UNVERIFIED")
        print("ACS_B15_SOURCE_ATLAS_OCR_GOLD=UNVERIFIED")
        print("ACS_B15_SOURCE_ATLAS_NEW_MODEL_CALLS=0")
    except Exception:
        print("ACS_B15_SOURCE_ATLAS=REJECTED")
        return 2
    return 0

if __name__=="__main__":
    sys.exit(main())
