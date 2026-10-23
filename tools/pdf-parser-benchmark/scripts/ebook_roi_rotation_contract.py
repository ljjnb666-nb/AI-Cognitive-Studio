#!/usr/bin/env python3
"""Private L2 ROI frame calibration. Geometry only; never certifies graph semantics.

Docling picture boxes are not assumed to share the PDF renderer's rotated
display frame. Explicit independently marked anchor correspondences are
required before a 90/180/270-degree spatial match is attempted.
"""
import argparse
import json
import math
from pathlib import Path
import sys

from ebook_private_roi_alignment import (
    Rejected, _private_json, _protect, match, normalized_box,
)

FRAME_UNROTATED = "PDF_UNROTATED_TOPLEFT"
FRAME_DISPLAY = "PDF_DISPLAY_TOPLEFT"
AUTHORITY = "PRIVATE_AI_VISUAL_L2_FRAME_CALIBRATION_NOT_GROUND_TRUTH"


def _point(value):
    if not isinstance(value, list) or len(value) != 2:
        raise Rejected("FRAME_ANCHOR_INVALID")
    if any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 or v > 1 for v in value):
        raise Rejected("FRAME_ANCHOR_INVALID")
    return tuple(float(v) for v in value)


def _rotation(value):
    if type(value) is not int or value not in (0, 90, 180, 270):
        raise Rejected("INVALID_PDF_PAGE_ROTATION")
    return value


def rotate_point(point, degrees):
    """Rotate normalized unrotated PDF TOPLEFT into displayed TOPLEFT, clockwise.

    Both source and destination dimensions are independently normalized.
    Clockwise 90: (x,y) -> (1-y,x); clockwise 270: (x,y) -> (y,1-x).
    """
    x, y = _point(list(point))
    d = _rotation(degrees)
    return {0: (x, y), 90: (1-y, x), 180: (1-x, 1-y), 270: (y, 1-x)}[d]


def rotate_box(box, degrees):
    x0, y0, x1, y1 = normalized_box(box)
    corners = [rotate_point((x, y), degrees)
               for x in (x0, x1) for y in (y0, y1)]
    return normalized_box((min(p[0] for p in corners), min(p[1] for p in corners),
                           max(p[0] for p in corners), max(p[1] for p in corners)))


def _triangle_area(a, b, c):
    return abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2


def calibrated_match(reference, candidate, calibration, observed_pdf_rotation):
    """One-to-one ROI overlap only after independent private frame anchors agree.

    The output intentionally omits all reference boxes, source hashes and anchor
    positions. Even PASS is provisional L2 spatial evidence, not OCR/chart gold.
    """
    _protect(calibration)
    if not isinstance(calibration, dict) or set(calibration) != {
        "schema_version", "authority", "book_id", "physical_page",
        "source_document_sha256", "source_pdf_rotation_degrees",
        "candidate_frame", "reference_frame", "anchor_pairs",
    } or calibration["schema_version"] != 1 or calibration["authority"] != AUTHORITY:
        raise Rejected("FRAME_CALIBRATION_SCHEMA_INVALID")
    if not isinstance(candidate, dict) or candidate.get("schema_version") != 1:
        raise Rejected("CANDIDATE_SCHEMA_INVALID")
    for key in ("book_id", "physical_page", "source_document_sha256"):
        if type(calibration[key]) is not type(candidate.get(key)) or calibration[key] != candidate.get(key):
            raise Rejected("FRAME_PROVENANCE_MISMATCH")
    d = _rotation(calibration["source_pdf_rotation_degrees"])
    if d != _rotation(observed_pdf_rotation):
        raise Rejected("FRAME_MEASURED_ROTATION_MISMATCH")
    if calibration["candidate_frame"] not in (FRAME_UNROTATED, FRAME_DISPLAY) or calibration["reference_frame"] != FRAME_DISPLAY:
        raise Rejected("FRAME_COORDINATE_CONVENTION_INVALID")
    anchors = calibration["anchor_pairs"]
    if not isinstance(anchors, list) or len(anchors) < 3 or len(anchors) > 12:
        raise Rejected("FRAME_ANCHOR_COUNT_INVALID")
    src = []
    dst = []
    for item in anchors:
        if not isinstance(item, dict) or set(item) != {"candidate_point", "display_point"}:
            raise Rejected("FRAME_ANCHOR_INVALID")
        src.append(_point(item["candidate_point"]))
        dst.append(_point(item["display_point"]))
    if len(set(src)) != len(src) or len(set(dst)) != len(dst):
        raise Rejected("FRAME_ANCHOR_DUPLICATED")
    # Three separated landmarks ensure a single coincidental anchor cannot be
    # called calibration; collinear points cannot prove the 2D page transform.
    if max(_triangle_area(src[i], src[j], src[k])
           for i in range(len(src)) for j in range(i+1, len(src))
           for k in range(j+1, len(src))) < 0.02:
        raise Rejected("FRAME_ANCHOR_DEGENERATE")
    degree = d if calibration["candidate_frame"] == FRAME_UNROTATED else 0
    predicted = [rotate_point(point, degree) for point in src]
    if any(max(abs(a-b) for a, b in zip(prediction, observed)) > 0.02
           for prediction, observed in zip(predicted, dst)):
        raise Rejected("FRAME_ANCHOR_RESIDUAL_TOO_LARGE")
    raw_boxes = candidate.get("picture_boxes_normalized")
    if not isinstance(raw_boxes, list) or len(raw_boxes) > 128:
        raise Rejected("INVALID_INPUT_COLLECTION")
    transformed = [list(rotate_box(box, degree)) for box in raw_boxes]
    adjusted = {**candidate, "picture_boxes_normalized": transformed}
    result = match(reference, adjusted)
    result["coordinate_transform_status"] = "PRIVATE_L2_FRAME_CALIBRATION_PROVISIONAL"
    result["source_pdf_rotation_degrees"] = d
    result["candidate_frame"] = calibration["candidate_frame"]
    result["reference_frame"] = FRAME_DISPLAY
    result["calibration_anchor_count"] = len(anchors)
    result["certified_region_recall"] = None
    result["certified_graph_f1"] = None
    result["graph_semantics"] = "UNVERIFIED"
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Private-only rotated ROI matcher")
    for name in ("private-root", "reference", "candidate", "calibration", "output"):
        parser.add_argument("--"+name, required=True)
    parser.add_argument("--observed-pdf-rotation-degrees", type=int, required=True,
                        help="Independently observed from PyMuPDF page.rotation, never inferred from sidecar")
    args = parser.parse_args(argv)
    root = Path(args.private_root).resolve(strict=True)
    if not root.is_dir():
        raise Rejected("PRIVATE_ROOT_INVALID")
    result = calibrated_match(_private_json(args.reference, root),
                              _private_json(args.candidate, root),
                              _private_json(args.calibration, root),
                              args.observed_pdf_rotation_degrees)
    output = Path(args.output).resolve()
    if not output.is_relative_to(root) or output.suffix.lower() != ".json":
        raise Rejected("PRIVATE_REPORT_PATH_REQUIRED")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, indent=2, ensure_ascii=True)+"\n", encoding="utf-8")
    temporary.replace(output)
    print("ACS_PRIVATE_ROTATION_ALIGNMENT="+result["status"])
    print("ACS_PRIVATE_ROTATION_FRAME=PROVISIONAL")
    print("ACS_PRIVATE_ROTATION_GRAPH_SEMANTICS=UNVERIFIED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Rejected as e:
        print("ACS_PRIVATE_ROTATION_REJECTED="+e.code)
        sys.exit(2)
