#!/usr/bin/env python3
"""B31 blind source-pixel connectivity checks, with NO graph-gold claim.

Only SHA-bound original PDF raster + source-only CV receipts are read. GLM
request/reply/candidate files are never opened. All per-tip geometry remains
private on D:, no image/coordinates/source SHA in CI logs or artifacts.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys

from ebook_b31_source_raster_geometry import read_evidence
from ebook_b31_multiscale_vtip_review import _image
from ebook_b31_multiscale_vtip_review import audit_existing as audit_vtip
from ebook_b31_vtip_clutter_triage import audit_existing as audit_triage
from ebook_b31_wing_continuity_controls import audit_existing as audit_wings
from ebook_b31_wing_continuity_controls import _verify_identity
from ebook_b31_arrow_shaft_consensus import load_source_report, merge_fragments
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

OUTPUT = "b31_pixel_topology_review.private.json"
MAX_REPORT_BYTES = 160_000
RADIUS = 40
STEPS = (6, 8, 10, 12, 14)
STATES = (
    "CONNECTED_PIXEL_PATTERN_REVIEW",
    "DENSE_COMPONENT_AMBIGUOUS",
    "BROKEN_PIXEL_CONNECTIVITY_REVIEW",
)
SOURCE_STATES = (
    "PIXEL_CONTRAST_REVIEW",
    "BACKGROUND_INK_AMBIGUOUS",
    "WING_CONTINUITY_WEAK",
)


def _nearest_label(labels, x, y, radius=2):
    """Return nonbackground 8-connected label at a point, else zero."""
    h, w = labels.shape
    x, y = int(round(x)), int(round(y))
    if not (radius <= x < w-radius and radius <= y < h-radius):
        return 0
    local = labels[y-radius:y+radius+1, x-radius:x+radius+1]
    nonzero = local[local > 0]
    if nonzero.size == 0:
        return 0
    values, counts = __import__("numpy").unique(nonzero, return_counts=True)
    return int(values[counts.argmax()])


def connected_pixel_evidence(mask, tip, other, scale, slope, cv2):
    """Match shaft and two angular wing paths to same local connected ink.

    This is a *review signal*, not an arrow classifier. Open V shapes and
    Chinese glyph junctions can both yield positive topology evidence.
    """
    if (not isinstance(tip, list) or not isinstance(other, list) or
            len(tip) != 2 or len(other) != 2 or
            any(type(x) not in (float, int) or not math.isfinite(x)
                for x in tip + other) or
            type(scale) not in (float, int) or scale not in (.75, 1., 1.5) or
            type(slope) not in (float, int) or slope not in (.45, .7)):
        raise VisualGateError("PIXEL_TOPOLOGY_INVALID_SOURCE_GEOMETRY")
    if len(mask.shape) != 2:
        raise VisualGateError("PIXEL_TOPOLOGY_MASK_SHAPE_INVALID")
    h, w = mask.shape
    x, y = float(tip[0]), float(tip[1])
    if not (RADIUS+3 <= x < w-RADIUS-3 and RADIUS+3 <= y < h-RADIUS-3):
        return {
            "review_state": "BROKEN_PIXEL_CONNECTIVITY_REVIEW",
            "boundary_censored": True,
            "connected_shaft_samples": 0,
            "connected_left_wing_samples": 0,
            "connected_right_wing_samples": 0,
            "anchor_component_ink_percent": 0.0,
            "does_not_verify_arrow": True,
        }
    dx, dy = x-other[0], y-other[1]
    length = math.hypot(dx, dy)
    if length < 24:
        raise VisualGateError("PIXEL_TOPOLOGY_SHAFT_TOO_SHORT")
    ux, uy = dx/length, dy/length
    nx, ny = -uy, ux
    x0, y0 = int(round(x))-RADIUS, int(round(y))-RADIUS
    local = (mask[y0:y0+2*RADIUS+1, x0:x0+2*RADIUS+1] > 0).astype("uint8")
    count, labels, stats, _ = cv2.connectedComponentsWithStats(
        local, connectivity=8)
    if count > (2*RADIUS+1)**2:
        raise VisualGateError("PIXEL_TOPOLOGY_COMPONENT_LIMIT")
    anchor = _nearest_label(labels, x-x0, y-y0)
    connected = [0, 0, 0]  # shaft, wing-left, wing-right
    if anchor:
        for k in STEPS:
            distance = k*float(scale)
            base_x, base_y = x-ux*distance, y-uy*distance
            for idx, (sx, sy) in enumerate((
                (base_x, base_y),
                (base_x-nx*distance*slope, base_y-ny*distance*slope),
                (base_x+nx*distance*slope, base_y+ny*distance*slope),
            )):
                linked = _nearest_label(labels, sx-x0, sy-y0) == anchor
                connected[idx] += int(linked)
    component_size = int(stats[anchor, cv2.CC_STAT_AREA]) if anchor else 0
    ink_pct = round(100.0*component_size/local.size, 2)
    if component_size / local.size >= .27:
        state = "DENSE_COMPONENT_AMBIGUOUS"
    elif connected[0] >= 2 and connected[1] >= 3 and connected[2] >= 3:
        state = "CONNECTED_PIXEL_PATTERN_REVIEW"
    else:
        state = "BROKEN_PIXEL_CONNECTIVITY_REVIEW"
    return {
        "review_state": state,
        "boundary_censored": False,
        "connected_shaft_samples": connected[0],
        "connected_left_wing_samples": connected[1],
        "connected_right_wing_samples": connected[2],
        "anchor_component_ink_percent": ink_pct,
        "does_not_verify_arrow": True,
    }


def _source(root, manifest):
    png, meta, folder = read_evidence(root, manifest)
    vtip = audit_vtip(root, manifest)
    triage = audit_triage(root, manifest)
    wings = audit_wings(root, manifest)
    entries, points = _verify_identity(triage, vtip)
    if (not isinstance(wings.get("candidate_reviews"), list) or
            len(wings["candidate_reviews"]) != len(points) or
            wings.get("tested_candidate_count") != len(points)):
        raise VisualGateError("PIXEL_TOPOLOGY_INPUT_CANDIDATES_INCOMPLETE")
    cv = load_source_report(folder, meta)
    shafts = merge_fragments(cv["hough_line_candidates"],
                             meta["render_width"], meta["render_height"])
    if len(shafts) != vtip["original_shaft_hypotheses"]:
        raise VisualGateError("PIXEL_TOPOLOGY_SHAFT_IDENTITY_INVALID")
    for idx, point in enumerate(points, 1):
        wi = wings["candidate_reviews"][idx-1]
        si, ei = point.get("shaft_index"), point.get("end_index")
        if (not isinstance(wi, dict) or wi.get("candidate_index") != idx or
                wi.get("source_review_bucket") != entries[idx-1]["review_bucket"] or
                wi.get("review_state") not in SOURCE_STATES or
                type(si) is not int or not 0 <= si < len(shafts) or
                type(ei) is not int or ei not in (0,1)):
            raise VisualGateError("PIXEL_TOPOLOGY_SOURCE_INDEX_MISMATCH")
        real = shafts[si]["endpoints"][ei]
        if math.hypot(real[0]-point["endpoint"][0],
                      real[1]-point["endpoint"][1]) > 1:
            raise VisualGateError("PIXEL_TOPOLOGY_SOURCE_ENDPOINT_MISMATCH")
    return png, meta, folder, triage, wings, points, shafts


def analyze(root, manifest, cv2, np, *, write=False):
    png, meta, folder, triage, wings, points, shafts = _source(root, manifest)
    dest = folder / OUTPUT
    if dest.exists() or dest.is_symlink():
        raise VisualGateError("PIXEL_TOPOLOGY_REPORT_ALREADY_EXISTS")
    bgr = _image(png, meta, cv2, np)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    corners = np.concatenate((gray[:8,:8].ravel(),gray[:8,-8:].ravel(),
                              gray[-8:,:8].ravel(),gray[-8:,-8:].ravel()))
    flag = cv2.THRESH_BINARY_INV if float(np.median(corners)) >= 128 \
           else cv2.THRESH_BINARY
    _,binary = cv2.threshold(gray, 0, 255, flag | cv2.THRESH_OTSU)
    counts={k:0 for k in STATES}
    matrix={k:{p:0 for p in STATES} for k in SOURCE_STATES}
    observations=[]
    for idx, pt in enumerate(points, 1):
        si, ei = pt["shaft_index"], pt["end_index"]
        shaft = shafts[si]["endpoints"]
        test = connected_pixel_evidence(binary, pt["endpoint"], shaft[1-ei],
                                        pt["scale"], pt["slope"], cv2)
        source_state = wings["candidate_reviews"][idx-1]["review_state"]
        test["source_candidate_index"] = idx
        test["previous_pixel_control_state"] = source_state
        observations.append(test)
        counts[test["review_state"]] += 1
        matrix[source_state][test["review_state"]] += 1
    if len(observations) != len(points) or sum(counts.values()) != len(points):
        raise VisualGateError("PIXEL_TOPOLOGY_CANDIDATE_LOSS")
    result={
        "schema_version":1,
        "evidence":"B31_ORIGINAL_PDF_PIXEL_COMPONENT_TOPOLOGY_REVIEW_NOT_GOLD",
        "book_id":"B31","physical_page":126,
        "source_document_sha256":meta["source_document_sha256"],
        "source_page_png_sha256":meta["private_png_sha256"],
        "source_contact_sheet_sha256":triage["private_contact_sheet_sha256"],
        "tested_candidate_count":len(points),
        "review_counts":counts,
        "pixel_control_cross_tab":matrix,
        "source_candidate_observations":observations,
        "all_original_candidates_preserved":True,
        "connected_ink_is_not_arrow_truth":True,
        "human_verified":False,
        "arrow_direction_verified":False,
        "independent_graph_gold":None,
        "certified_graph_f1":None,
        "provider_calls":0,
    }
    if write:
        payload=(json.dumps(result,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        fd=os.open(dest,flags,0o600)
        with os.fdopen(fd,"wb") as file:
            file.write(payload)
    return result


def audit_existing(root,manifest):
    _,meta,folder,triage,wings,points,_ = _source(root,manifest)
    path=folder/OUTPUT
    if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=MAX_REPORT_BYTES:
        raise VisualGateError("PIXEL_TOPOLOGY_REPORT_UNSAFE_OR_MISSING")
    try:
        result=json.loads(path.read_text("utf-8"),
                          object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (UnicodeError,ValueError,TypeError):
        raise VisualGateError("PIXEL_TOPOLOGY_REPORT_JSON_INVALID") from None
    if (not isinstance(result,dict) or
            result.get("schema_version") != 1 or
            result.get("evidence") != "B31_ORIGINAL_PDF_PIXEL_COMPONENT_TOPOLOGY_REVIEW_NOT_GOLD" or
            result.get("book_id") != "B31" or
            type(result.get("physical_page")) is not int or result["physical_page"] != 126 or
            result.get("source_document_sha256") != meta["source_document_sha256"] or
            result.get("source_page_png_sha256") != meta["private_png_sha256"] or
            result.get("source_contact_sheet_sha256") != triage["private_contact_sheet_sha256"] or
            type(result.get("tested_candidate_count")) is not int or
            result["tested_candidate_count"] != len(points) or
            result.get("all_original_candidates_preserved") is not True or
            result.get("connected_ink_is_not_arrow_truth") is not True or
            result.get("human_verified") is not False or
            result.get("arrow_direction_verified") is not False or
            result.get("independent_graph_gold",object()) is not None or
            result.get("certified_graph_f1",object()) is not None or
            result.get("provider_calls") != 0 or
            not isinstance(result.get("review_counts"),dict) or
            set(result["review_counts"]) != set(STATES) or
            any(type(v) is not int or v<0 for v in result["review_counts"].values()) or
            sum(result["review_counts"].values()) != len(points) or
            not isinstance(result.get("source_candidate_observations"),list) or
            len(result["source_candidate_observations"]) != len(points)):
        raise VisualGateError("PIXEL_TOPOLOGY_RECEIPT_PROVENANCE_INVALID")
    actual={k:0 for k in STATES}
    for idx,item in enumerate(result["source_candidate_observations"],1):
        if (not isinstance(item,dict) or type(item.get("source_candidate_index")) is not int or
                item["source_candidate_index"] != idx or
                item.get("previous_pixel_control_state") !=
                    wings["candidate_reviews"][idx-1]["review_state"] or
                item.get("review_state") not in STATES or
                item.get("does_not_verify_arrow") is not True):
            raise VisualGateError("PIXEL_TOPOLOGY_RECEIPT_INDEX_INVALID")
        actual[item["review_state"]]+=1
    if actual != result["review_counts"]:
        raise VisualGateError("PIXEL_TOPOLOGY_RECEIPT_COUNTS_INVALID")
    return result


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    modes=parser.add_mutually_exclusive_group()
    modes.add_argument("--write",action="store_true")
    modes.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    if args.audit_only:
        result=audit_existing(Path(args.private_root),manifest)
    else:
        import cv2
        import numpy as np
        result=analyze(Path(args.private_root),manifest,cv2,np,write=args.write)
    print("ACS_B31_PIXEL_TOPOLOGY="+(
        "PRIVATE_WRITTEN" if args.write else
        "EXISTING_PRIVATE_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_B31_PIXEL_TOPOLOGY_ALL_CANDIDATES="+str(result["tested_candidate_count"]))
    for state in STATES:
        print("ACS_B31_PIXEL_TOPOLOGY_"+state+"="+str(result["review_counts"][state]))
    print("ACS_B31_PIXEL_TOPOLOGY_ARROW_DIRECTION=UNVERIFIED")
    print("ACS_B31_PIXEL_TOPOLOGY_GRAPH_GOLD=UNVERIFIED")
    print("ACS_B31_PIXEL_TOPOLOGY_PROVIDER_CALLS=0")
    return 0


if __name__=="__main__":
    try:
        sys.exit(main())
    except (VisualGateError,ValueError,TypeError,OSError,ImportError) as exc:
        print("ACS_B31_PIXEL_TOPOLOGY_REJECTED="+(
            exc.code if isinstance(exc,VisualGateError) else type(exc).__name__))
        sys.exit(2)
