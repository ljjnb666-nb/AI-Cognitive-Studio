#!/usr/bin/env python3
"""Private Docling spatial ROI overlap only; cannot certify chart semantics."""
import argparse
import json
import math
from pathlib import Path
import re
import sys

SHA = re.compile(r"^[a-f0-9]{64}$")
BOOK = re.compile(r"^B[0-9]{2}$")
RESTRICTED = {"humanverified", "graphverified", "isgold", "goldcertified"}

class Rejected(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)

def _protect(obj):
    if isinstance(obj, dict):
        for k, value in obj.items():
            if str(k).replace("_", "").lower() in RESTRICTED:
                raise Rejected("UNAUTHORIZED_VERIFICATION_CLAIM")
            _protect(value)
    elif isinstance(obj, list):
        for value in obj:
            _protect(value)

def _finite(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise Rejected("INVALID_COORDINATE")
    return float(value)

def normalized_box(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise Rejected("INVALID_BBOX_SHAPE")
    x0, y0, x1, y1 = map(_finite, value)
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise Rejected("BBOX_OUTSIDE_NORMALIZED_PAGE")
    return (x0, y0, x1, y1)

def docling_bbox_normalized(bbox, page_size):
    width, height = _finite(page_size.width), _finite(page_size.height)
    if width <= 0 or height <= 0:
        raise Rejected("INVALID_PAGE_SIZE")
    origin = getattr(bbox.coord_origin, "value", bbox.coord_origin)
    if origin == "TOPLEFT":
        left, top, right, bottom = bbox.l, bbox.t, bbox.r, bbox.b
    elif origin == "BOTTOMLEFT":
        left, top, right, bottom = bbox.l, height - bbox.t, bbox.r, height - bbox.b
    else:
        raise Rejected("UNKNOWN_COORDINATE_ORIGIN")
    return normalized_box([_finite(left)/width, _finite(top)/height,
                           _finite(right)/width, _finite(bottom)/height])

def geometry_gate(book_id, picture_count, boxes, rotation, has_reference):
    """Require real geometry; rotated PDFs cannot assume display coordinates."""
    if type(rotation) is not int or rotation not in (0, 90, 180, 270):
        raise Rejected("INVALID_PDF_PAGE_ROTATION")
    if type(picture_count) is not int or not 0 <= picture_count <= 128:
        raise Rejected("INVALID_PICTURE_COUNT")
    if not isinstance(boxes, (list, tuple)) or len(boxes) > 128:
        raise Rejected("INVALID_PICTURE_BOXES")
    for box in boxes:
        normalized_box(box)
    if book_id in ("B15", "B31"):
        if picture_count == 0 or len(boxes) != picture_count:
            raise Rejected("SCANNED_PICTURE_GEOMETRY_INCOMPLETE")
    elif len(boxes) > picture_count:
        raise Rejected("PICTURE_GEOMETRY_OVERCOUNT")
    if not has_reference:
        return "PRIVATE_REFERENCE_UNAVAILABLE"
    if rotation:
        return "ROTATED_DISPLAY_TRANSFORM_UNVERIFIED"
    return "PRIVATE_REFERENCE_READY_TO_MATCH"


def docling_picture_boxes(document):
    pages = getattr(document, "pages", None)
    if not isinstance(pages, dict) or 1 not in pages:
        raise Rejected("DOCLING_SINGLE_PAGE_GEOMETRY_UNAVAILABLE")
    pictures = getattr(document, "pictures", None)
    if pictures is None or len(pictures) > 128:
        raise Rejected("DOCLING_PICTURES_INVALID")
    result = []
    for pic in pictures:
        provenance = getattr(pic, "prov", None)
        # Each *picture object* must contribute exactly one independently
        # attributable geometry. A two-box picture plus an unlocated picture
        # must never pass merely because total box count matches item count.
        if not isinstance(provenance, (list, tuple)) or len(provenance) != 1:
            raise Rejected("DOCLING_PICTURE_PROVENANCE_NOT_SINGLE")
        prov = provenance[0]
        if prov.page_no != 1:
            raise Rejected("DOCLING_WRONG_LOCAL_PAGE_NUMBER")
        box = docling_bbox_normalized(prov.bbox, pages[1].size)
        if box in result:
            raise Rejected("DOCLING_DUPLICATE_PICTURE_GEOMETRY")
        result.append(box)
    return result

def _area(box):
    return (box[2] - box[0]) * (box[3] - box[1])

def overlap(reference_box, predicted_box):
    x = max(0, min(reference_box[2],predicted_box[2]) -
               max(reference_box[0],predicted_box[0]))
    y = max(0, min(reference_box[3],predicted_box[3]) -
               max(reference_box[1],predicted_box[1]))
    intersection = x*y
    union = _area(reference_box) + _area(predicted_box) - intersection
    return (intersection/union, intersection/_area(reference_box)) if union else (0,0)

def match(reference, candidate):
    _protect(reference)
    _protect(candidate)
    if not isinstance(reference, dict) or reference.get("authority") != "L2_AI_VISUAL_PROVISIONAL_NOT_HUMAN_GROUND_TRUTH":
        raise Rejected("REFERENCE_AUTHORITY_INVALID")
    if not isinstance(candidate, dict) or candidate.get("schema_version") != 1:
        raise Rejected("CANDIDATE_SCHEMA_INVALID")
    book = candidate.get("book_id")
    physical = candidate.get("physical_page")
    digest = candidate.get("source_document_sha256")
    if not isinstance(book, str) or not BOOK.fullmatch(book) or type(physical) is not int or physical < 1 or not isinstance(digest, str) or not SHA.fullmatch(digest):
        raise Rejected("INVALID_CANDIDATE_PROVENANCE")
    if candidate.get("engine") != "Docling":
        raise Rejected("UNSUPPORTED_ENGINE_CANDIDATE")
    regions = reference.get("regions")
    candidates = candidate.get("picture_boxes_normalized")
    if not isinstance(regions, list) or not isinstance(candidates, list) or len(regions) > 128 or len(candidates) > 128:
        raise Rejected("INVALID_INPUT_COLLECTION")
    expected = []
    for region in regions:
        if not isinstance(region, dict):
            raise Rejected("INVALID_REFERENCE_REGION")
        if region.get("book_id") != book or region.get("physical_page") != physical:
            continue
        if region.get("source_document_sha256") != digest:
            raise Rejected("SOURCE_DOCUMENT_SHA_MISMATCH")
        if region.get("evidence") != "L2_AI_VISUAL_PROVISIONAL":
            raise Rejected("REFERENCE_PROVENANCE_UNVERIFIED")
        expected.append(normalized_box(region.get("roi_xyxy_normalized")))
    if not expected:
        raise Rejected("PRIVATE_REFERENCE_NOT_PRESENT_FOR_PAGE")
    # Identical L2 annotations are not independent reference regions. Treating
    # them as separate objects can artificially inflate a one-to-one hit count.
    if len(set(expected)) != len(expected):
        raise Rejected("DUPLICATE_REFERENCE_REGION")
    boxes = [normalized_box(value) for value in candidates]
    # This guard is also needed for the standalone matcher: the Docling adapter
    # deduplicates provenance boxes, but arbitrary private candidate JSON does not.
    if len(set(boxes)) != len(boxes):
        raise Rejected("DUPLICATE_PICTURE_BOX")
    # Maximize the number of distinct reference/picture matches, rather than
    # taking the highest IoU edge first: greedy can suppress a valid second hit.
    edges = [[] for _ in expected]
    for i, roi in enumerate(expected):
        for j, box in enumerate(boxes):
            iou, coverage = overlap(roi, box)
            if iou >= 0.10 and coverage >= 0.20:
                edges[i].append((j, iou))
        edges[i].sort(key=lambda item: (-item[1], item[0]))

    assigned_to_reference = [None] * len(boxes)

    def augment(reference_id, seen_boxes):
        for box_id, _ in edges[reference_id]:
            if box_id in seen_boxes:
                continue
            seen_boxes.add(box_id)
            previous_reference = assigned_to_reference[box_id]
            if previous_reference is None or augment(previous_reference, seen_boxes):
                assigned_to_reference[box_id] = reference_id
                return True
        return False

    # A bounded augmenting-path matching (128 regions/boxes max). Each box
    # and each reference may contribute at most once; tie-breaking is stable.
    for reference_id in sorted(range(len(expected)),
                               key=lambda i: (len(edges[i]), i)):
        augment(reference_id, set())
    scores = [overlap(expected[reference_id], boxes[box_id])[0]
              for box_id, reference_id in enumerate(assigned_to_reference)
              if reference_id is not None]
    return {
        "schema_version": 1,
        "status": "PROVISIONAL_SPATIAL_OVERLAP_ONLY" if scores else "NO_SPATIAL_MATCH_UNVERIFIED",
        "evidence_level": "L2_AI_VISUAL_PROVISIONAL_NOT_HUMAN_GROUND_TRUTH",
        "reference_region_count": len(expected),
        "detected_picture_box_count": len(boxes),
        "one_to_one_region_matches": len(scores),
        "unmatched_reference_regions": len(expected)-len(scores),
        "unmatched_picture_boxes": len(boxes)-len(scores),
        "highest_matched_iou": round(max(scores),4) if scores else None,
        "certified_region_recall": None,
        "certified_graph_f1": None,
        "human_verified": False,
        "graph_verified": False,
        "graph_semantics": "UNVERIFIED",
        "limitations": "AI provisional ROI overlap only; no human gold, no arrow or curve semantics",
    }

def _private_json(path, root):
    file = Path(path).resolve(strict=True)
    if not file.is_relative_to(root) or not file.is_file() or file.stat().st_size > 262144:
        raise Rejected("PRIVATE_INPUT_INVALID")
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (UnicodeError, ValueError):
        raise Rejected("INVALID_JSON") from None

def main(argv=None):
    parser = argparse.ArgumentParser()
    for name in ("private-root", "reference", "candidate", "output"):
        parser.add_argument("--"+name, required=True)
    args = parser.parse_args(argv)
    root = Path(args.private_root).resolve(strict=True)
    if not root.is_dir():
        raise Rejected("PRIVATE_ROOT_INVALID")
    report = match(_private_json(args.reference, root), _private_json(args.candidate, root))
    target = Path(args.output).resolve()
    if not target.is_relative_to(root) or target.suffix.lower() != ".json":
        raise Rejected("PRIVATE_REPORT_PATH_REQUIRED")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=True, indent=2)+"\n", encoding="utf-8")
    temporary.replace(target)
    print("ACS_PRIVATE_ROI_ALIGNMENT="+report["status"])
    print("ACS_PRIVATE_ROI_MATCHED="+str(report["one_to_one_region_matches"]))
    print("ACS_PRIVATE_ROI_GRAPH_SEMANTICS=UNVERIFIED")
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Rejected as failure:
        print("ACS_PRIVATE_ROI_REJECTED="+failure.code)
        sys.exit(2)
