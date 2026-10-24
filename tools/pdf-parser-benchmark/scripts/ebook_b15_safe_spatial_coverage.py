#!/usr/bin/env python3
"""Privacy-safe numeric projection of frozen B15 v5 OCR quad/ROI candidates.

Never print page text, coordinates, file paths, private SHA, JSON or exceptions.
The only disclosed numbers are three bounded category counts that sum to 19.
No OCR, cloud, model, file writes, or human-gold inference is performed.
"""
import argparse
import sys
from pathlib import Path

import ebook_private_b15_figure_pixel_registration as pixel
import ebook_b15_ocr_quad_spatial_candidates as spatial

BUCKETS = (
    ("MOSTLY_WITHIN_UNVERIFIED_ROI", "INSIDE"),
    ("PARTIALLY_INTERSECTS_UNVERIFIED_ROI", "PARTIAL"),
    ("OUTSIDE_UNVERIFIED_ROI", "OUTSIDE"),
)


class PrivateProjectionError(Exception):
    pass


def require(condition):
    if not condition:
        raise PrivateProjectionError("INVALID_PRIVATE_PROJECTION")


def trusted_metrics(page_path, markdown_path, v1_path, v3_path, v4_path,
                    v4_overlay_path, v5_path):
    # Recompute the entire v5 payload from source-frozen receipts, then compare
    # it byte-for-byte to immutable D: v5. Never trust a self-reported count.
    page=pixel.read_bytes(page_path,pixel.MAX_PNG)
    markdown=pixel.read_bytes(markdown_path,pixel.MAX_MD)
    v1=spatial.read_canonical_json(v1_path,pixel.MAX_ANCHOR)
    v3=spatial.read_canonical_json(v3_path,32_000)
    v4=spatial.read_canonical_json(v4_path,50_000)
    v4_overlay=pixel.read_bytes(v4_overlay_path,spatial.MAX_OVERLAY)
    v5=spatial.read_canonical_json(v5_path,spatial.MAX_JSON)
    recomputed=spatial.build(page,markdown,v1,v3,v4,v4_overlay)
    require(pixel.canonical(v5)==pixel.canonical(recomputed))
    require(v5.get("schema_version")==5
            and v5.get("status")==spatial.STATUS
            and v5.get("book_id")=="B15"
            and v5.get("physical_page")==109
            and v5.get("ocr_row_count")==19
            and len(v5.get("ocr_candidate_spatial_rows_private",[]))==19)
    for key in ("source_pixel_frame_to_ocr_quad_independently_verified",
                "figure_roi_geometry_independently_verified",
                "label_to_marker_correspondence_verified",
                "series_to_curve_correspondence_verified",
                "independent_gold_available"):
        require(v5.get(key) is False)
    require(v5.get("cer",object()) is None)
    result={}
    for bucket,name in BUCKETS:
        number=v5.get("spatial_bucket_counts",{}).get(bucket)
        require(type(number) is int and 0<=number<=19)
        result[name]=number
    require(sum(result.values())==19)
    return result


def main(argv=None):
    p=argparse.ArgumentParser()
    for option in ("page-png","mineru-markdown","anchor-v1","pixel-v3",
                   "feature-v4","feature-overlay-v4","quad-v5"):
        p.add_argument("--"+option,required=True)
    args=p.parse_args(argv)
    try:
        metrics=trusted_metrics(args.page_png,args.mineru_markdown,
                                args.anchor_v1,args.pixel_v3,args.feature_v4,
                                args.feature_overlay_v4,args.quad_v5)
        # Whitelist only three bounded integers: no coordinates or OCR text.
        print("ACS_B15_V5_COVERAGE=RECOMPUTED_FROM_FROZEN_SOURCE")
        print("ACS_B15_V5_INSIDE="+str(metrics["INSIDE"]))
        print("ACS_B15_V5_PARTIAL="+str(metrics["PARTIAL"]))
        print("ACS_B15_V5_OUTSIDE="+str(metrics["OUTSIDE"]))
        print("ACS_B15_V5_TOTAL=19")
        print("ACS_B15_V5_GEOMETRY=UNVERIFIED")
        print("ACS_B15_V5_SYMBOL_CURVE=UNVERIFIED")
        print("ACS_B15_V5_GOLD=UNVERIFIED")
        print("ACS_B15_V5_NEW_OCR_CLOUD_CALLS=0")
    except Exception:
        # Fail closed even for unforeseen Unicode/decoder/disk exceptions.
        print("ACS_B15_V5_COVERAGE=REJECTED")
        return 2
    return 0


if __name__=="__main__":
    sys.exit(main())
