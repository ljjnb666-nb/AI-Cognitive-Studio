#!/usr/bin/env python3
"""B31 blind spatial agreement between local OCR text boxes and V-tip proposals.

Source material is the SHA-pinned original PDF page, never the GLM reply.
OCR boxes are PROBABILISTIC: overlapping text does NOT prove a false arrow.
All text, geometry and full-page review image remain ONLY on private D:.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys

from ebook_b31_source_raster_geometry import read_evidence
from ebook_b31_rapidocr_isolated import audit_existing as audit_ocr
from ebook_b31_multiscale_vtip_review import audit_existing as audit_vtip, _image
from ebook_b31_vtip_clutter_triage import audit_existing as audit_triage
from ebook_b31_wing_continuity_controls import (
    audit_existing as audit_wings, _verify_identity,
)
from ebook_b31_pixel_topology import audit_existing as audit_topology
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

OUT = "b31_ocr_spatial_confounds.private.json"
REVIEW = "b31_ocr_spatial_confounds.private.png"
SCHEMA = "B31_BLIND_LOCAL_OCR_TEXTBOX_OVERLAP_NOT_GRAPH_GOLD"
MAX_JSON = 120_000
MAX_PNG = 8_000_000
NEAR_PIXELS = 8.0
STATUSES = ("OCR_BOX_INTERIOR", "OCR_BOX_NEAR", "OCR_BOX_OUTSIDE")
WING_STATES = (
    "PIXEL_CONTRAST_REVIEW",
    "BACKGROUND_INK_AMBIGUOUS",
    "WING_CONTINUITY_WEAK",
)
TOPO_STATES = (
    "CONNECTED_PIXEL_PATTERN_REVIEW",
    "DENSE_COMPONENT_AMBIGUOUS",
    "BROKEN_PIXEL_CONNECTIVITY_REVIEW",
)


def validated_quad(box):
    """Fail closed on self-crossing / degenerate OCR polygon."""
    if type(box) is not list or len(box) != 4:
        raise VisualGateError("B31_SPATIAL_OCR_QUAD_INVALID")
    points = []
    for p in box:
        if (type(p) is not list or len(p) != 2 or
                any(type(v) not in (int, float) or not math.isfinite(v)
                    for v in p)):
            raise VisualGateError("B31_SPATIAL_OCR_VERTEX_INVALID")
        points.append((float(p[0]), float(p[1])))
    cross = []
    for i in range(4):
        a, b, c = points[i], points[(i+1)%4], points[(i+2)%4]
        cross.append((b[0]-a[0])*(c[1]-b[1]) -
                     (b[1]-a[1])*(c[0]-b[0]))
    if min(abs(v) for v in cross) < .001 or not (
        all(v>0 for v in cross) or all(v<0 for v in cross)):
        raise VisualGateError("B31_SPATIAL_OCR_NONCONVEX_QUAD")
    area = abs(sum(points[i][0]*points[(i+1)%4][1] -
                   points[(i+1)%4][0]*points[i][1]
                   for i in range(4))) / 2
    if area < 2:
        raise VisualGateError("B31_SPATIAL_OCR_DEGENERATE_QUAD")
    return points


def segment_distance(point, a, b):
    vx, vy = b[0]-a[0], b[1]-a[1]
    denominator = vx*vx+vy*vy
    if denominator < 1e-9:
        raise VisualGateError("B31_SPATIAL_OCR_ZERO_EDGE")
    frac = max(0., min(1.,
        ((point[0]-a[0])*vx+(point[1]-a[1])*vy)/denominator))
    return math.hypot(point[0]-(a[0]+frac*vx),
                      point[1]-(a[1]+frac*vy))


def quad_distance(point, quad):
    edges = []
    for i in range(4):
        a,b = quad[i],quad[(i+1)%4]
        edges.append((b[0]-a[0])*(point[1]-a[1]) -
                     (b[1]-a[1])*(point[0]-a[0]))
    if all(x>=-1e-7 for x in edges) or all(x<=1e-7 for x in edges):
        return 0.
    return min(segment_distance(point,quad[i],quad[(i+1)%4]) for i in range(4))


def proximity(point, quads):
    if not quads:
        return {"text_box_state": "OCR_BOX_OUTSIDE",
                "nearest_ocr_line_index": None, "distance_px": None}
    distance, index = min((quad_distance(point, q), i)
                          for i,q in enumerate(quads, 1))
    status = ("OCR_BOX_INTERIOR" if distance <= 1e-7 else
              "OCR_BOX_NEAR" if distance <= NEAR_PIXELS else
              "OCR_BOX_OUTSIDE")
    return {"text_box_state": status,
            "nearest_ocr_line_index": index,
            "distance_px": round(distance, 3)}


def load_inputs(root, manifest):
    _, meta, folder = read_evidence(root, manifest)
    ocr = audit_ocr(root, manifest)
    triage = audit_triage(root, manifest)
    vtip = audit_vtip(root, manifest)
    wings = audit_wings(root, manifest)
    topology = audit_topology(root, manifest)
    entries, candidates = _verify_identity(triage, vtip)
    if (vtip.get("endpoint_candidates_truncated") is not False or
            len(candidates) != vtip.get("candidate_endpoint_count_total") or
            len(candidates) != 103 or  # pinned original B31 full set
            ocr.get("recognized_line_count") != 50 or
            len(ocr["private_source_ocr_rows"]) != 50 or
            not isinstance(wings.get("candidate_reviews"),list) or
            not isinstance(topology.get("source_candidate_observations"),list) or
            len(wings["candidate_reviews"]) != len(candidates) or
            len(topology["source_candidate_observations"]) != len(candidates)):
        raise VisualGateError("B31_SPATIAL_SOURCE_SET_OR_OCR_COUNT_INVALID")
    for i, candidate in enumerate(candidates, 1):
        wing, topo, entry = (wings["candidate_reviews"][i-1],
                             topology["source_candidate_observations"][i-1],
                             entries[i-1])
        if (wing.get("candidate_index") != i or
                wing.get("review_state") not in WING_STATES or
                topo.get("source_candidate_index") != i or
                topo.get("review_state") not in TOPO_STATES or
                entry.get("source_candidate_index") != i or
                candidate.get("endpoint") != entry.get("endpoint") or
                topology.get("all_original_candidates_preserved") is not True):
            raise VisualGateError("B31_SPATIAL_UPSTREAM_IDENTITY_INVALID")
    quads = [validated_quad(row["quad"])
             for row in ocr["private_source_ocr_rows"]]
    return meta, folder, ocr, candidates, wings, topology, quads


def build_report(root, manifest):
    meta, folder, ocr, candidates, wings, topology, quads = load_inputs(
        root, manifest)
    counts = {k:0 for k in STATUSES}
    table = {k:{s:0 for s in STATUSES} for k in WING_STATES}
    topo_table = {k:{s:0 for s in STATUSES} for k in TOPO_STATES}
    rows = []
    for index, candidate in enumerate(candidates,1):
        status = proximity(candidate["endpoint"],quads)
        wing = wings["candidate_reviews"][index-1]["review_state"]
        topo = topology["source_candidate_observations"][index-1]["review_state"]
        status.update({
            "original_candidate_index": index,
            "wing_control_review_state": wing,
            "pixel_topology_review_state": topo,
            "pixel_location_not_arrow_truth": True,
        })
        rows.append(status)
        counts[status["text_box_state"]] += 1
        table[wing][status["text_box_state"]] += 1
        topo_table[topo][status["text_box_state"]] += 1
    if sum(counts.values()) != 103:
        raise VisualGateError("B31_SPATIAL_UNEXPECTED_COUNT_LOSS")
    report = {
        "schema_version": 1,
        "evidence": SCHEMA,
        "book_id": "B31",
        "physical_page": 126,
        "source_document_sha256": meta["source_document_sha256"],
        "source_page_png_sha256": meta["private_png_sha256"],
        "ocr_private_rows_sha256": ocr["private_rows_sha256"],
        "ocr_recognized_line_count": len(quads),
        "candidate_count": len(candidates),
        "spatial_counts": counts,
        "wing_state_cross_tab": table,
        "topology_state_cross_tab": topo_table,
        "candidate_reviews": rows,
        "native_text_ground_truth_available": False,
        "text_overlap_is_not_false_positive_proof": True,
        "all_original_candidates_preserved": True,
        "ocr_quality_gold": None,
        "independent_graph_gold": None,
        "arrow_direction_verified": False,
        "certified_graph_f1": None,
        "provider_calls": 0,
    }
    return report, (meta, folder, candidates, wings, quads)


def make_private_review(png, meta, candidates, wings, quads, cv2, np):
    bgr = _image(png,meta,cv2,np)
    for index, quad in enumerate(quads,1):
        arr = np.array(quad,dtype=np.int32)
        cv2.polylines(bgr,[arr],True,(150,90,0),1,cv2.LINE_AA)
    for index,candidate in enumerate(candidates,1):
        x,y=map(lambda v:int(round(v)),candidate["endpoint"])
        wing=wings["candidate_reviews"][index-1]["review_state"]
        color=(0,0,255) if wing=="PIXEL_CONTRAST_REVIEW" else (0,170,170)
        cv2.circle(bgr,(x,y),5 if wing=="PIXEL_CONTRAST_REVIEW" else 2,
                   color,1,cv2.LINE_AA)
    cv2.putText(bgr,"BLIND OCR BOXES + SOURCE TIP CANDIDATES / NOT GOLD",
                (8,min(25,meta["render_height"]-8)),
                cv2.FONT_HERSHEY_SIMPLEX,.39,(200,0,200),1,cv2.LINE_AA)
    ok,encoded=cv2.imencode(".png",bgr)
    if not ok or not 0<len(encoded)<=MAX_PNG:
        raise VisualGateError("B31_SPATIAL_PRIVATE_OVERLAY_TOO_LARGE")
    return encoded.tobytes()


def _exclusive(path,content):
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
    if hasattr(os,"O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as handle:
        handle.write(content)


def run(root,manifest,cv2,np,*,write=False):
    report, (meta,folder,candidates,wings,quads)=build_report(root,manifest)
    path,sheet=folder/OUT,folder/REVIEW
    if any(p.exists() or p.is_symlink() for p in (path,sheet)):
        raise VisualGateError("B31_SPATIAL_PRIVATE_OUTPUT_ALREADY_EXISTS")
    png, _, _=read_evidence(root,manifest)
    overlay=make_private_review(png,meta,candidates,wings,quads,cv2,np)
    report["private_overlay_sha256"]=hashlib.sha256(overlay).hexdigest()
    blob=(json.dumps(report,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
    if len(blob)>MAX_JSON:
        raise VisualGateError("B31_SPATIAL_JSON_TOO_LARGE")
    if write:
        # Any interrupted pair must remain visibly partial; never overwrite.
        _exclusive(sheet,overlay)
        _exclusive(path,blob)
    return report


def audit_existing(root,manifest):
    expected,_=build_report(root,manifest)
    folder=Path(root)/"semantic_gate"
    path,sheet=folder/OUT,folder/REVIEW
    if (path.is_symlink() or sheet.is_symlink() or not path.is_file() or
            not sheet.is_file() or not 0<path.stat().st_size<=MAX_JSON or
            not 0<sheet.stat().st_size<=MAX_PNG):
        raise VisualGateError("B31_SPATIAL_PRIVATE_PACKET_INCOMPLETE")
    try:
        saved=json.loads(path.read_text(encoding="utf-8"),
                         object_pairs_hook=no_duplicate_keys,
                         parse_constant=reject_constant)
    except (ValueError,TypeError,UnicodeError):
        raise VisualGateError("B31_SPATIAL_PRIVATE_JSON_INVALID") from None
    expected["private_overlay_sha256"]=hashlib.sha256(sheet.read_bytes()).hexdigest()
    if saved!=expected:
        raise VisualGateError("B31_SPATIAL_PRIVATE_PROVENANCE_MISMATCH")
    return saved


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument("--write",action="store_true")
    mode.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    if args.audit_only:
        report=audit_existing(Path(args.private_root),manifest)
    else:
        import cv2
        import numpy as np
        report=run(Path(args.private_root),manifest,cv2,np,write=args.write)
    print("ACS_B31_SPATIAL_STATUS="+(
        "PRIVATE_CREATED" if args.write else
        "PRIVATE_RECEIPT_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_B31_SPATIAL_OCR_BOXES="+str(report["ocr_recognized_line_count"]))
    print("ACS_B31_SPATIAL_ALL_CANDIDATES="+str(report["candidate_count"]))
    for name in STATUSES:
        print("ACS_B31_SPATIAL_"+name+"="+str(report["spatial_counts"][name]))
    print("ACS_B31_SPATIAL_GRAPH_GOLD=UNVERIFIED")
    print("ACS_B31_SPATIAL_PROVIDER_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,TypeError,OSError,ImportError) as err:
        print("ACS_B31_SPATIAL_REJECTED="+(
            err.code if isinstance(err,VisualGateError) else type(err).__name__))
        sys.exit(2)
