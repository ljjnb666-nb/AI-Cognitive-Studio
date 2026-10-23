#!/usr/bin/env python3
"""Source-only B31 V-tip review triage; never an independent graph gold.

Uses only SHA-pinned PDF pixel evidence, immutable source-CV geometry and
previous V-wing source-only hypotheses. NEVER accesses GLM reply/candidate.
The sheet includes original book pixels and MUST remain on the private D drive.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys

from ebook_b31_arrow_shaft_consensus import load_source_report, merge_fragments
from ebook_b31_multiscale_vtip_review import (
    LENGTHS, SLOPES, MAX_TIPS, _image, audit_existing as audit_vtip_packet,
)
from ebook_b31_source_raster_geometry import read_evidence
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT = "b31_vtip_clutter_triage.private.json"
SHEET = "b31_vtip_contact_sheet.private.png"
MAX_REPORT_SIZE = 160_000
MAX_SHEET_SIZE = 9_000_000
MAX_CONTOURS_PER_ROI = 2000
ROI_RADIUS = 31
TILE_W, TILE_H, COLUMNS = 156, 150, 8


def check_candidates(report, shafts, width, height):
    points = report.get("endpoint_candidates")
    total = report.get("candidate_endpoint_count_total")
    if (type(points) is not list or len(points) > MAX_TIPS or
            type(total) is not int or not 0 <= total <= 512 or
            len(points) != min(total, MAX_TIPS) or
            report.get("endpoint_candidates_truncated") is not (total > MAX_TIPS)):
        raise VisualGateError("TRIAGE_VTIP_LIST_INVALID")
    if (type(report.get("original_shaft_hypotheses")) is not int or
            report["original_shaft_hypotheses"] != len(shafts)):
        raise VisualGateError("TRIAGE_SOURCE_SHAFT_COUNT_MISMATCH")
    seen = set()
    for p in points:
        if not isinstance(p, dict):
            raise VisualGateError("TRIAGE_CANDIDATE_SCHEMA_INVALID")
        i, end, point = p.get("shaft_index"), p.get("end_index"), p.get("endpoint")
        counts, scale, slope = p.get("wing_support"), p.get("scale"), p.get("slope")
        if (type(i) is not int or type(end) is not int or
                not 0 <= i < len(shafts) or end not in (0, 1) or
                (i, end) in seen or not isinstance(point, list) or len(point) != 2 or
                not all(type(v) in (float, int) and math.isfinite(v) for v in point) or
                not (0 <= point[0] < width and 0 <= point[1] < height) or
                type(counts) is not list or len(counts) != 2 or
                not all(type(v) is int and 3 <= v <= 5 for v in counts) or
                type(p.get("support_min")) is not int or
                p["support_min"] != min(counts) or
                scale not in LENGTHS or slope not in SLOPES):
            raise VisualGateError("TRIAGE_CANDIDATE_SCHEMA_INVALID")
        recorded = shafts[i]["endpoints"][end]
        if math.hypot(point[0]-recorded[0], point[1]-recorded[1]) > 1.0:
            raise VisualGateError("TRIAGE_CANDIDATE_NOT_SOURCE_SHAFT_ENDPOINT")
        seen.add((i, end))
    return points


def classify_roi(mask, x, y, cv2):
    """Heuristic for review ordering, NOT a semantic false-positive classifier."""
    h, w = mask.shape
    xx, yy = round(x), round(y)
    x0, x1 = max(0, xx-ROI_RADIUS), min(w, xx+ROI_RADIUS+1)
    y0, y1 = max(0, yy-ROI_RADIUS), min(h, yy+ROI_RADIUS+1)
    crop = mask[y0:y1, x0:x1]
    if crop.size < 64:
        raise VisualGateError("TRIAGE_ROI_TOO_SMALL")
    ink = int(cv2.countNonZero(crop))
    density = ink / crop.size
    shapes = cv2.findContours(crop, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[-2]
    if len(shapes) > MAX_CONTOURS_PER_ROI:
        raise VisualGateError("TRIAGE_ROI_COMPONENT_LIMIT")
    small = sum(1 for c in shapes if 2 <= cv2.contourArea(c) <= 70)
    if density >= 0.28 or small >= 14:
        status = "DENSE_INK_REVIEW"
    elif density <= 0.15 and small <= 5:
        status = "LOW_CLUTTER_REVIEW"
    else:
        status = "AMBIGUOUS_REVIEW"
    return {"review_bucket": status, "local_ink_percent": round(density*100, 1),
            "small_contour_count": small, "roi_rect": [x0, y0, x1, y1]}


def analyze(root, manifest, cv2, np, *, write=False):
    png, meta, folder = read_evidence(root, manifest)
    path, sheet_path = folder / REPORT, folder / SHEET
    if any(p.exists() or p.is_symlink() for p in (path, sheet_path)):
        raise VisualGateError("TRIAGE_REPORT_ALREADY_EXISTS_NO_OVERWRITE")
    source = load_source_report(folder, meta)
    prior = audit_vtip_packet(root, manifest)
    bgr = _image(png, meta, cv2, np)
    shafts = merge_fragments(
        source["hough_line_candidates"], meta["render_width"], meta["render_height"])
    candidates = check_candidates(
        prior, shafts, meta["render_width"], meta["render_height"])
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    corners = np.concatenate([gray[:8,:8].ravel(), gray[:8,-8:].ravel(),
                              gray[-8:,:8].ravel(), gray[-8:,-8:].ravel()])
    flag = cv2.THRESH_BINARY_INV if float(np.median(corners)) >= 128 \
           else cv2.THRESH_BINARY
    _, mask = cv2.threshold(gray, 0, 255, flag | cv2.THRESH_OTSU)
    audits = []
    buckets = {"LOW_CLUTTER_REVIEW": 0, "AMBIGUOUS_REVIEW": 0,
               "DENSE_INK_REVIEW": 0}
    for n, candidate in enumerate(candidates, 1):
        point = candidate["endpoint"]
        info = classify_roi(mask, point[0], point[1], cv2)
        info.update({
            "source_candidate_index": n,
            "source_shaft_index": candidate["shaft_index"],
            "source_endpoint_index": candidate["end_index"],
            "endpoint": point,
            "wing_support_min": candidate["support_min"],
            "source_wing_scale": candidate["scale"],
        })
        audits.append(info)
        buckets[info["review_bucket"]] += 1

    # Put sparse-background items first for efficient human/independent review,
    # but retain all original indices and the COMPLETE original-candidate set.
    order = {"LOW_CLUTTER_REVIEW":0, "AMBIGUOUS_REVIEW":1, "DENSE_INK_REVIEW":2}
    ranked = sorted(audits, key=lambda a: (
        order[a["review_bucket"]], -a["wing_support_min"],
        a["source_candidate_index"]))
    rows = max(1, math.ceil(len(ranked) / COLUMNS))
    review = np.full((rows*TILE_H+32, COLUMNS*TILE_W, 3), 255, np.uint8)
    cv2.putText(review, "B31 ORIGINAL PIXELS - SOURCE ONLY - NOT GRAPH GOLD",
                (10, 23), cv2.FONT_HERSHEY_SIMPLEX, .51, (0,0,180), 1)
    for pos, item in enumerate(ranked):
        col, row = pos % COLUMNS, pos // COLUMNS
        left, top = col*TILE_W, 32+row*TILE_H
        x0, y0, x1, y1 = item["roi_rect"]
        crop = bgr[y0:y1, x0:x1].copy()
        if crop.size == 0:
            raise VisualGateError("TRIAGE_SOURCE_CROP_EMPTY")
        patch = cv2.resize(crop, (124,124), interpolation=cv2.INTER_NEAREST)
        review[top:top+124, left+12:left+136] = patch
        x, y = item["endpoint"]
        center_x = left + 12 + round((x-x0)*124/max(1,x1-x0))
        center_y = top + round((y-y0)*124/max(1,y1-y0))
        cv2.circle(review, (center_x,center_y), 5, (0,0,255), 2)
        badge = {"LOW_CLUTTER_REVIEW":"LOW",
                 "AMBIGUOUS_REVIEW":"MID","DENSE_INK_REVIEW":"DENSE"}[item["review_bucket"]]
        cv2.putText(review, f"#{item['source_candidate_index']:03d} {badge}",
                    (left+13,top+140),cv2.FONT_HERSHEY_SIMPLEX,.39,(15,15,15),1)
    ok, encoded = cv2.imencode(".png", review)
    if not ok or not 0 < len(encoded) <= MAX_SHEET_SIZE:
        raise VisualGateError("TRIAGE_REVIEW_SHEET_ENCODING_FAILED")
    result = {
        "schema_version": 1,
        "evidence": "B31_SOURCE_ONLY_VTIP_REVIEW_ORDER_NOT_GRAPH_GOLD",
        "book_id": "B31", "physical_page": 126,
        "source_document_sha256": meta["source_document_sha256"],
        "source_page_png_sha256": meta["private_png_sha256"],
        "source_vtip_review_png_sha256": prior["private_review_png_sha256"],
        "source_tip_count_total": prior["candidate_endpoint_count_total"],
        "source_tip_list_complete": not prior["endpoint_candidates_truncated"],
        "reviewed_tip_count": len(audits),
        "review_bucket_counts": buckets,
        "triage_entries": audits,
        "private_contact_sheet_sha256": hashlib.sha256(encoded.tobytes()).hexdigest(),
        "classification_semantic_accuracy_verified": False,
        "node_count_verified": False,
        "arrow_direction_verified": False,
        "independent_graph_gold": None,
        "certified_graph_f1": None,
        "provider_calls": 0,
    }
    if write:
        def save(path, payload):
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            fd = os.open(path, flags, 0o600)
            with os.fdopen(fd, "wb") as out:
                out.write(payload)
        save(sheet_path, encoded.tobytes())
        save(path, (json.dumps(result, sort_keys=True, separators=(",", ":"))
                    +"\n").encode("utf-8"))
    return result


def audit_existing(root, manifest):
    _, meta, folder = read_evidence(root, manifest)
    source = load_source_report(folder, meta)
    from ebook_b31_multiscale_vtip_review import audit_existing as audit_vtip
    original = audit_vtip(root, manifest)
    path, sheet = folder / REPORT, folder / SHEET
    if (path.is_symlink() or sheet.is_symlink() or not path.is_file()
            or not sheet.is_file() or path.stat().st_size > MAX_REPORT_SIZE
            or sheet.stat().st_size > MAX_SHEET_SIZE):
        raise VisualGateError("TRIAGE_RECEIPT_MISSING_OR_UNSAFE")
    try:
        data = json.loads(path.read_text("utf-8"),
                          object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (UnicodeError, ValueError, TypeError):
        raise VisualGateError("TRIAGE_RECEIPT_JSON_INVALID") from None
    if (not isinstance(data, dict) or
            data.get("schema_version") != 1 or
            data.get("evidence") != "B31_SOURCE_ONLY_VTIP_REVIEW_ORDER_NOT_GRAPH_GOLD" or
            data.get("book_id") != "B31" or data.get("physical_page") != 126 or
            data.get("source_document_sha256") != meta["source_document_sha256"] or
            data.get("source_page_png_sha256") != meta["private_png_sha256"] or
            data.get("source_vtip_review_png_sha256") != original["private_review_png_sha256"] or
            data.get("source_tip_count_total") != original["candidate_endpoint_count_total"] or
            data.get("reviewed_tip_count") != len(original["endpoint_candidates"]) or
            data.get("classification_semantic_accuracy_verified") is not False or
            data.get("arrow_direction_verified") is not False or
            data.get("independent_graph_gold", object()) is not None or
            data.get("certified_graph_f1", object()) is not None or
            data.get("provider_calls") != 0 or
            data.get("private_contact_sheet_sha256") !=
                hashlib.sha256(sheet.read_bytes()).hexdigest()):
        raise VisualGateError("TRIAGE_RECEIPT_PROVENANCE_INVALID")
    return data


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--private-root", required=True)
    p.add_argument("--manifest", required=True)
    modes = p.add_mutually_exclusive_group()
    modes.add_argument("--write", action="store_true")
    modes.add_argument("--audit-only", action="store_true")
    args = p.parse_args(argv)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    if args.audit_only:
        result = audit_existing(Path(args.private_root), manifest)
    else:
        import cv2
        import numpy as np
        result = analyze(Path(args.private_root), manifest, cv2, np,
                         write=args.write)
    print("ACS_B31_TRIAGE_STATUS=" +
          ("PRIVATE_CREATED" if args.write else
           "EXISTING_PRIVATE_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_B31_TRIAGE_TOTAL_CANDIDATES=" + str(result["source_tip_count_total"]))
    for name in ("LOW_CLUTTER_REVIEW", "AMBIGUOUS_REVIEW", "DENSE_INK_REVIEW"):
        print("ACS_B31_TRIAGE_"+name+"="+str(result["review_bucket_counts"][name]))
    print("ACS_B31_TRIAGE_SEMANTIC_GOLD=UNVERIFIED")
    print("ACS_B31_TRIAGE_PROVIDER_CALLS=0")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VisualGateError, OSError, TypeError, ValueError, ImportError) as err:
        code = err.code if isinstance(err, VisualGateError) else type(err).__name__
        print("ACS_B31_TRIAGE_REJECTED="+code)
        sys.exit(2)
