#!/usr/bin/env python3
"""Blind source-only B31 V-wing continuity and negative-control pixel audit.

Inputs: immutable original PDF page pixels and earlier source-only geometry.
Never opens GLM request/reply/candidate, never produces graph ground truth.
Private coordinate-level observations remain in the D: benchmark directory.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys

from ebook_b31_multiscale_vtip_review import _image, SAMPLE_STEPS
from ebook_b31_source_raster_geometry import read_evidence
from ebook_b31_vtip_clutter_triage import audit_existing as audit_triage
from ebook_b31_multiscale_vtip_review import audit_existing as audit_vtip
from ebook_private_glm_visual_reference import VisualGateError
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant

OUTPUT = "b31_vtip_wing_continuity.private.json"
MAX_REPORT = 160_000
MAX_CANDIDATES = 128
OFF_WING_FACTOR = 2.2
STATES = (
    "PIXEL_CONTRAST_REVIEW",
    "BACKGROUND_INK_AMBIGUOUS",
    "WING_CONTINUITY_WEAK",
)


def _support(mask, x, y):
    """3x3 pixel foreground test; return false for any out-of-page sample."""
    xx, yy = int(round(x)), int(round(y))
    height, width = mask.shape
    if xx < 1 or yy < 1 or xx >= width-1 or yy >= height-1:
        return False
    return bool(mask[yy-1:yy+2, xx-1:xx+2].any())


def _max_consecutive(hits):
    best = run = 0
    for hit in hits:
        run = run+1 if hit else 0
        best = max(best, run)
    return best


def pixel_controls(mask, point, opposite, scale, slope):
    """Check both wings and two DIFFERENT background negative controls.

    Forward controls lie beyond the putative tip in the shaft direction;
    far-flank controls run at >2x candidate wing expansion. These are
    discriminative image heuristics, never calibrated semantic accuracy.
    """
    if (not isinstance(point, list) or len(point) != 2 or
            not isinstance(opposite, list) or len(opposite) != 2 or
            not all(type(t) in (int, float) and math.isfinite(t)
                    for t in point+opposite) or
            not (type(scale) in (int, float) and 0.5 <= scale <= 1.5) or
            not (type(slope) in (int, float) and 0.3 <= slope <= 0.8)):
        raise VisualGateError("WING_CONTROL_INPUT_INVALID")
    dx, dy = point[0]-opposite[0], point[1]-opposite[1]
    length = math.hypot(dx, dy)
    if length < 24:
        raise VisualGateError("WING_CONTROL_SHAFT_TOO_SHORT")
    ux, uy = dx/length, dy/length
    nx, ny = -uy, ux
    values = {"left": [], "right": [], "forward_left": [],
              "forward_right": [], "outer_left": [], "outer_right": []}
    for step in SAMPLE_STEPS:
        distance = step*scale
        for side, token in ((-1,"left"),(1,"right")):
            perp_x = side*nx*distance*slope
            perp_y = side*ny*distance*slope
            values[token].append(_support(mask,
                point[0]-ux*distance+perp_x,
                point[1]-uy*distance+perp_y))
            values["forward_"+token].append(_support(mask,
                point[0]+ux*distance+perp_x,
                point[1]+uy*distance+perp_y))
            values["outer_"+token].append(_support(mask,
                point[0]-ux*distance+OFF_WING_FACTOR*perp_x,
                point[1]-uy*distance+OFF_WING_FACTOR*perp_y))
    wing_counts = [sum(values["left"]), sum(values["right"])]
    runs = [_max_consecutive(values["left"]),
            _max_consecutive(values["right"])]
    forward_counts = [sum(values["forward_left"]),
                      sum(values["forward_right"])]
    flank_counts = [sum(values["outer_left"]),
                    sum(values["outer_right"])]
    if min(wing_counts) < 3 or min(runs) < 3:
        state = "WING_CONTINUITY_WEAK"
    elif max(forward_counts) > 1 or max(flank_counts) > 2:
        state = "BACKGROUND_INK_AMBIGUOUS"
    else:
        state = "PIXEL_CONTRAST_REVIEW"
    return {
        "review_state": state,
        "wing_support_counts": wing_counts,
        "wing_longest_consecutive": runs,
        "beyond_tip_negative_controls": forward_counts,
        "outer_flank_negative_controls": flank_counts,
        "does_not_certify_arrow": True,
    }


def _verify_identity(triage, vtip):
    entries = triage.get("triage_entries")
    points = vtip.get("endpoint_candidates")
    count = vtip.get("candidate_endpoint_count_total")
    if (not isinstance(entries,list) or not isinstance(points,list) or
            type(count) is not int or count > MAX_CANDIDATES or
            count != len(entries) or count != len(points) or
            triage.get("source_tip_list_complete") is not True or
            triage.get("reviewed_tip_count") != count or
            triage.get("source_tip_count_total") != count or
            sum(triage["review_bucket_counts"].values()) != count):
        raise VisualGateError("WING_SOURCE_CANDIDATE_SET_INCOMPLETE")
    for idx,(entry,point) in enumerate(zip(entries,points),1):
        if (not isinstance(entry,dict) or not isinstance(point,dict) or
                type(entry.get("source_candidate_index")) is not int or
                entry["source_candidate_index"] != idx or
                entry.get("source_shaft_index") != point.get("shaft_index") or
                entry.get("source_endpoint_index") != point.get("end_index") or
                entry.get("endpoint") != point.get("endpoint") or
                entry.get("wing_support_min") != point.get("support_min") or
                entry.get("source_wing_scale") != point.get("scale") or
                entry.get("review_bucket") not in (
                    "LOW_CLUTTER_REVIEW","AMBIGUOUS_REVIEW","DENSE_INK_REVIEW")):
            raise VisualGateError("WING_SOURCE_CANDIDATE_IDENTITY_INVALID")
    return entries,points


def analyze(root,manifest,cv2,np,*,write=False):
    png,meta,folder=read_evidence(root,manifest)
    destination=folder/OUTPUT
    if destination.exists() or destination.is_symlink():
        raise VisualGateError("WING_PRIVATE_REPORT_ALREADY_EXISTS")
    # Both independent source receipts are SHA-bound, but model receipts
    # are deliberately not opened at any point.
    triage=audit_triage(root,manifest)
    vtip=audit_vtip(root,manifest)
    entries,candidates=_verify_identity(triage,vtip)
    cv_source=__import__("ebook_b31_arrow_shaft_consensus").load_source_report(folder,meta)
    shafts=__import__("ebook_b31_arrow_shaft_consensus").merge_fragments(
        cv_source["hough_line_candidates"],meta["render_width"],meta["render_height"])
    if len(shafts)!=vtip["original_shaft_hypotheses"]:
        raise VisualGateError("WING_SOURCE_SHAFT_COUNT_MISMATCH")
    bgr=_image(png,meta,cv2,np)
    gray=cv2.cvtColor(bgr,cv2.COLOR_BGR2GRAY)
    corners=np.concatenate((gray[:8,:8].ravel(),gray[:8,-8:].ravel(),
                            gray[-8:,:8].ravel(),gray[-8:,-8:].ravel()))
    threshold=cv2.THRESH_BINARY_INV if float(np.median(corners))>=128 \
              else cv2.THRESH_BINARY
    _,binary=cv2.threshold(gray,0,255,threshold|cv2.THRESH_OTSU)
    mask=binary>0
    rows=[]
    state_counts={name:0 for name in STATES}
    cross_tab={n:{name:0 for name in STATES} for n in
               ("LOW_CLUTTER_REVIEW","AMBIGUOUS_REVIEW","DENSE_INK_REVIEW")}
    for index,(entry,pt) in enumerate(zip(entries,candidates),1):
        shaft_i,end_i=pt["shaft_index"],pt["end_index"]
        if (type(shaft_i) is not int or type(end_i) is not int or
                not 0<=shaft_i<len(shafts) or end_i not in (0,1)):
            raise VisualGateError("WING_SOURCE_SHAFT_IDENTITY_INVALID")
        endpoints=shafts[shaft_i]["endpoints"]
        actual=endpoints[end_i]
        if math.hypot(actual[0]-pt["endpoint"][0],
                      actual[1]-pt["endpoint"][1])>1:
            raise VisualGateError("WING_SOURCE_ENDPOINT_MISMATCH")
        features=pixel_controls(mask,pt["endpoint"],
                                endpoints[1-end_i],pt["scale"],pt["slope"])
        features["candidate_index"]=index
        features["source_review_bucket"]=entry["review_bucket"]
        rows.append(features)
        state_counts[features["review_state"]]+=1
        cross_tab[entry["review_bucket"]][features["review_state"]]+=1
    result={
        "schema_version":1,
        "evidence":"B31_SOURCE_PIXEL_WING_CONTROLS_REVIEW_NOT_GOLD",
        "book_id":"B31","physical_page":126,
        "source_document_sha256":meta["source_document_sha256"],
        "source_page_png_sha256":meta["private_png_sha256"],
        "source_triage_contact_sheet_sha256":triage["private_contact_sheet_sha256"],
        "source_vtip_review_png_sha256":vtip["private_review_png_sha256"],
        "original_candidate_count":len(candidates),
        "tested_candidate_count":len(rows),
        "state_counts":state_counts,
        "review_cross_tab":cross_tab,
        "candidate_reviews":rows,
        "all_candidates_preserved":True,
        "pixel_contrast_is_not_arrow_correctness":True,
        "independent_graph_gold":None,
        "arrow_direction_verified":False,
        "certified_graph_f1":None,
        "provider_calls":0,
    }
    if write:
        content=(json.dumps(result,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        fd=os.open(destination,flags,0o600)
        with os.fdopen(fd,"wb") as f:
            f.write(content)
    return result


def audit_existing(root,manifest):
    _,meta,folder=read_evidence(root,manifest)
    source_triage=audit_triage(root,manifest)
    source_vtip=audit_vtip(root,manifest)
    path=folder/OUTPUT
    if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=MAX_REPORT:
        raise VisualGateError("WING_EXISTING_REPORT_MISSING_OR_UNSAFE")
    try:
        data=json.loads(path.read_text("utf-8"),
                        object_pairs_hook=no_duplicate_keys,
                        parse_constant=reject_constant)
    except (ValueError,UnicodeError,TypeError):
        raise VisualGateError("WING_EXISTING_REPORT_JSON_INVALID") from None
    if (not isinstance(data,dict) or data.get("schema_version")!=1 or
            data.get("evidence")!="B31_SOURCE_PIXEL_WING_CONTROLS_REVIEW_NOT_GOLD" or
            data.get("book_id")!="B31" or data.get("physical_page")!=126 or
            data.get("source_document_sha256")!=meta["source_document_sha256"] or
            data.get("source_page_png_sha256")!=meta["private_png_sha256"] or
            data.get("source_triage_contact_sheet_sha256")!=
                source_triage["private_contact_sheet_sha256"] or
            data.get("source_vtip_review_png_sha256")!=
                source_vtip["private_review_png_sha256"] or
            data.get("original_candidate_count")!=source_vtip["candidate_endpoint_count_total"] or
            data.get("tested_candidate_count")!=len(source_vtip["endpoint_candidates"]) or
            not isinstance(data.get("candidate_reviews"),list) or
            len(data["candidate_reviews"])!=data["tested_candidate_count"] or
            data.get("all_candidates_preserved") is not True or
            data.get("pixel_contrast_is_not_arrow_correctness") is not True or
            data.get("arrow_direction_verified") is not False or
            data.get("independent_graph_gold",object()) is not None or
            data.get("certified_graph_f1",object()) is not None or
            data.get("provider_calls")!=0 or
            not isinstance(data.get("state_counts"),dict) or
            sum(data["state_counts"].values())!=data["tested_candidate_count"]):
        raise VisualGateError("WING_EXISTING_REPORT_PROVENANCE_INVALID")
    for index,row in enumerate(data["candidate_reviews"],1):
        if (not isinstance(row,dict) or type(row.get("candidate_index")) is not int or
                row["candidate_index"]!=index or
                row.get("review_state") not in STATES or
                row.get("does_not_certify_arrow") is not True):
            raise VisualGateError("WING_EXISTING_CANDIDATE_IDENTITY_INVALID")
    return data


def main(argv=None):
    ap=argparse.ArgumentParser()
    ap.add_argument("--private-root",required=True)
    ap.add_argument("--manifest",required=True)
    group=ap.add_mutually_exclusive_group()
    group.add_argument("--write",action="store_true")
    group.add_argument("--audit-only",action="store_true")
    args=ap.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    if args.audit_only:
        result=audit_existing(Path(args.private_root),manifest)
    else:
        import cv2
        import numpy as np
        result=analyze(Path(args.private_root),manifest,cv2,np,write=args.write)
    print("ACS_B31_WING_STATUS="+("PRIVATE_WRITTEN" if args.write else
           "EXISTING_PRIVATE_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_B31_WING_CANDIDATES_PRESERVED="+str(result["tested_candidate_count"]))
    for key in STATES:
        print("ACS_B31_WING_"+key+"="+str(result["state_counts"][key]))
    print("ACS_B31_WING_ARROW_GOLD=UNVERIFIED")
    print("ACS_B31_WING_PROVIDER_CALLS=0")
    return 0


if __name__=="__main__":
    try:
        sys.exit(main())
    except (VisualGateError,OSError,TypeError,ValueError,ImportError) as err:
        print("ACS_B31_WING_REJECTED="+(
            err.code if isinstance(err,VisualGateError) else type(err).__name__))
        sys.exit(2)
