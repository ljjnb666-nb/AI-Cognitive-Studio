#!/usr/bin/env python3
"""B15 private PDF pixel-landmark + independent Docling page-frame calibration.

Calibrates the page frame, NOT the positions of predicted pictures. Never
chooses a frame by maximizing Docling-vs-GLM ROI agreement. Both input PDF and
Docling measurements are SHA-pinned; all anchors remain in private D: files.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys

from ebook_private_native_pages import _raw_sources
from ebook_roi_rotation_contract import (
    AUTHORITY, FRAME_DISPLAY, FRAME_UNROTATED, calibrated_match,
)
from ebook_private_roi_alignment import Rejected, _private_json

BOOK, PAGE, ROTATION = "B15", 109, 270
MAX_PDF = 200 * 1024 * 1024


def _positive(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise Rejected("FRAME_PAGE_SIZE_INVALID")
    return float(value)


def infer_docling_frame(page_size, source_pixels, display_pixels):
    """Aspect ratios, not observed ROI overlap, determine candidate frame."""
    if not isinstance(page_size, list) or len(page_size) != 2:
        raise Rejected("FRAME_DOCLING_PAGE_SIZE_MISSING")
    dw, dh = [_positive(n) for n in page_size]
    sw, sh = [_positive(n) for n in source_pixels]
    tw, th = [_positive(n) for n in display_pixels]
    observed_ratio = dw / dh
    # Aspect ratio is scale invariant; never pick the frame from picture bbox.
    source_error = abs(observed_ratio/(sw/sh)-1)
    display_error = abs(observed_ratio/(tw/th)-1)
    good_source, good_display = source_error <= .015, display_error <= .015
    if good_source == good_display:
        raise Rejected("FRAME_ASPECT_RATIO_AMBIGUOUS")
    return FRAME_UNROTATED if good_source else FRAME_DISPLAY


def _mapping(x, y, width, height, rotation):
    if rotation == 0: return x, y
    if rotation == 90: return height-1-y, x
    if rotation == 180: return width-1-x, height-1-y
    if rotation == 270: return y, width-1-x
    raise Rejected("FRAME_ROTATION_UNSUPPORTED")


def _sample(image, buffer, x, y):
    offset = (y * image.width + x) * image.n
    return buffer[offset:offset+3]


def _image_anchors(unrotated, displayed, rotation):
    """Prove 3+ separated, textured landmarks correspond in BOTH rasters.

    The displayed landmark is selected using best pixel agreement within a
    tiny neighborhood of the predicted rotation, not from GLM/Docling ROI boxes.
    Fails closed for feature-poor or mismatched pages.
    """
    w, h = unrotated.width, unrotated.height
    display_expected = (h, w) if rotation in (90, 270) else (w, h)
    if (displayed.width, displayed.height) != display_expected:
        raise Rejected("FRAME_RENDER_DIMENSIONS_INCONSISTENT")
    if min(w, h) < 150 or unrotated.n < 3 or displayed.n < 3:
        raise Rejected("FRAME_RASTER_INVALID")
    source_bytes = unrotated.samples
    display_bytes = displayed.samples
    samples = []
    # 21x21 grid; 9x9 texture patch. Scan isn't driven by parser picture boxes.
    for yi in range(2, 23):
        y = int((.08+yi*.038)*h)
        for xi in range(2, 23):
            x = int((.08+xi*.038)*w)
            if x < 6 or y < 6 or x >= w-6 or y >= h-6:
                continue
            positions = [(x+dx,y+dy) for dy in (-4,-2,0,2,4) for dx in (-4,-2,0,2,4)]
            grays = [sum(_sample(unrotated, source_bytes, xx, yy))//3 for xx,yy in positions]
            texture = max(grays)-min(grays)
            if texture < 45:
                continue
            center = _mapping(x,y,w,h,rotation)
            best = (float("inf"),None)
            for oy in (-1,0,1):
                for ox in (-1,0,1):
                    distance=0
                    valid=True
                    for xx,yy in positions:
                        dx,dy = _mapping(xx,yy,w,h,rotation)
                        dx+=ox
                        dy+=oy
                        if not (0<=dx<displayed.width and 0<=dy<displayed.height):
                            valid=False
                            break
                        a=_sample(unrotated,source_bytes,xx,yy)
                        b=_sample(displayed,display_bytes,dx,dy)
                        distance+=sum(abs(v-z) for v,z in zip(a,b))
                    if valid:
                        mae=distance/(len(positions)*3)
                        if mae<best[0]:
                            best=(mae,(center[0]+ox,center[1]+oy))
            if best[1] is None or best[0]>24:
                continue
            nx,ny=x/(w-1),y/(h-1)
            gx,gy=best[1][0]/(displayed.width-1),best[1][1]/(displayed.height-1)
            if not (0<nx<1 and 0<ny<1 and 0<gx<1 and 0<gy<1):
                continue
            samples.append((texture-best[0], (nx,ny), (gx,gy)))
    candidates=sorted(samples,key=lambda item:-item[0])
    chosen=[]
    for _,src,dst in candidates:
        if all(math.dist(src,earlier[0]) >= .24 for earlier in chosen):
            chosen.append((src,dst))
        if len(chosen)==8:
            break
    if len(chosen)<3:
        raise Rejected("FRAME_INDEPENDENT_PIXEL_ANCHORS_MISSING")
    src=[x[0] for x in chosen]
    def area(i,j,k):
        a,b,c=src[i],src[j],src[k]
        return abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2
    if max(area(i,j,k) for i in range(len(src)) for j in range(i+1,len(src)) for k in range(j+1,len(src))) < .02:
        raise Rejected("FRAME_INDEPENDENT_PIXEL_ANCHORS_DEGENERATE")
    return chosen


def calibrate(manifest, report, raw_pdf, fitz):
    candidates=[x for x in manifest.get("sources",[]) if x.get("id")==BOOK]
    if len(candidates)!=1:
        raise Rejected("FRAME_SOURCE_MANIFEST_MISSING")
    item=candidates[0]
    if len(raw_pdf)!=item["size"] or hashlib.sha256(raw_pdf).hexdigest()!=item["sha256"]:
        raise Rejected("FRAME_SOURCE_SHA_MISMATCH")
    if not isinstance(report,dict) or report.get("failed") or report.get("missing"):
        raise Rejected("FRAME_DOCLING_REPORT_INVALID")
    pages=[x for x in report.get("rows",[]) if x.get("book_id")==BOOK]
    if len(pages)!=1 or pages[0].get("physical_page")!=PAGE or pages[0].get("source_sha256")!=item["sha256"] or pages[0].get("docling_status")!="SUCCESS":
        raise Rejected("FRAME_DOCLING_SOURCE_MISMATCH")
    docling=[x for x in pages[0].get("results",[]) if x.get("engine")=="Docling"]
    if len(docling)!=1:
        raise Rejected("FRAME_DOCLING_METRIC_MISSING")
    layout=docling[0].get("layout_evidence")
    if not isinstance(layout,dict) or not isinstance(layout.get("private_docling_page_size"),list):
        raise Rejected("FRAME_DOCLING_PAGE_SIZE_MISSING")
    with fitz.open(stream=raw_pdf,filetype="pdf") as pdf:
        if len(pdf)!=item["total_physical_pages"]:
            raise Rejected("FRAME_PHYSICAL_PAGE_COUNT_MISMATCH")
        page=pdf[PAGE-1]
        if page.rotation!=ROTATION:
            raise Rejected("FRAME_REAL_PDF_ROTATION_MISMATCH")
        shown=page.get_pixmap(matrix=fitz.Matrix(1,1),alpha=False,colorspace=fitz.csRGB)
        page.set_rotation(0)  # in memory only; never save or edit private PDF
        native=page.get_pixmap(matrix=fitz.Matrix(1,1),alpha=False,colorspace=fitz.csRGB)
    frame=infer_docling_frame(layout["private_docling_page_size"],
                             (native.width,native.height),
                             (shown.width,shown.height))
    pairs=_image_anchors(native,shown,ROTATION)
    anchors=[]
    for src,dst in pairs:
        point=src if frame==FRAME_UNROTATED else dst
        anchors.append({
            "candidate_point":[round(v,7) for v in point],
            "display_point":[round(v,7) for v in dst],
        })
    sidecar={
        "schema_version":1,
        "authority":AUTHORITY,
        "book_id":BOOK,
        "physical_page":PAGE,
        "source_document_sha256":item["sha256"],
        "source_pdf_rotation_degrees":ROTATION,
        "candidate_frame":frame,
        "reference_frame":FRAME_DISPLAY,
        "anchor_pairs":anchors,
    }
    # Exercise the SAME strict anchor validator as the real Docling matcher.
    # The following geometry is a *synthetic* fixture, never the actual ROI.
    # It is not a source for picking the frame or inflating match accuracy.
    from ebook_roi_rotation_contract import rotate_point
    predicted=[]
    for pair in anchors:
        pt=pair["candidate_point"]
        predicted.append(rotate_point(pt,ROTATION if frame==FRAME_UNROTATED else 0))
    if any(max(abs(a-b) for a,b in zip(predicted[i],anchors[i]["display_point"]))>.02
           for i in range(len(anchors))):
        raise Rejected("FRAME_CALIBRATION_RESIDUAL_REJECTED")
    return sidecar


def main(argv=None):
    cli=argparse.ArgumentParser()
    for name in ("private-root","manifest","docling-report"):
        cli.add_argument("--"+name,required=True)
    args=cli.parse_args(argv)
    root=Path(args.private_root).resolve(strict=True)
    if not root.is_dir():
        raise Rejected("FRAME_PRIVATE_ROOT_INVALID")
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    report=_private_json(args.docling_report,root)
    source=[x for x in manifest["sources"] if x.get("id")==BOOK]
    if len(source)!=1:
        raise Rejected("FRAME_SOURCE_MANIFEST_MISSING")
    ident=(source[0]["size"],source[0]["sha256"])
    pdf=None
    for book,data in _raw_sources(root,{ident:BOOK}):
        if book==BOOK:
            pdf=data
            break
    if pdf is None:
        raise Rejected("FRAME_REAL_SOURCE_UNAVAILABLE")
    import fitz
    calibration=calibrate(manifest,report,pdf,fitz)
    path=root/"semantic_gate"/"B15_roi_frame_calibration.private.json"
    if path.is_symlink() or not path.parent.resolve().is_relative_to(root) or path.parent.is_symlink():
        raise Rejected("FRAME_PRIVATE_OUTPUT_UNSAFE")
    if path.exists():
        earlier=_private_json(path,root)
        if earlier!=calibration:
            raise Rejected("FRAME_EXISTING_CALIBRATION_MISMATCH")
        print("ACS_B15_FRAME_SIDECAR=EXISTING_IDENTICAL")
    else:
        blob=(json.dumps(calibration,indent=2,ensure_ascii=True)+"\n").encode("utf-8")
        fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,"wb") as writer:
            writer.write(blob)
        print("ACS_B15_FRAME_SIDECAR=NEW_PRIVATE")
    print("ACS_B15_FRAME_CANDIDATE="+calibration["candidate_frame"])
    print("ACS_B15_FRAME_PIXEL_LANDMARKS="+str(len(calibration["anchor_pairs"])))
    print("ACS_B15_FRAME_MEASURED_ROTATION=270")
    print("ACS_B15_FRAME_REFERENCE=AI_L2_PROVISIONAL_NOT_GOLD")
    print("ACS_B15_GRAPH_SEMANTICS=UNVERIFIED")
    return 0


if __name__=="__main__":
    try:
        sys.exit(main())
    except (Rejected,OSError,ValueError) as error:
        print("ACS_B15_FRAME_REJECTED="+(error.code if isinstance(error,Rejected) else type(error).__name__))
        sys.exit(2)
