#!/usr/bin/env python3
"""Independent B31 original-page multiscale V-wing pixel hypotheses.

No LLM calls. Never loads model reply, candidate or reference data.
Results and full-resolution review image remain ONLY on the private D drive.
All V-wing observations are unverified source-pixel *hypotheses*, NOT gold.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys

from ebook_b31_source_raster_geometry import read_evidence
from ebook_b31_arrow_shaft_consensus import load_source_report, merge_fragments
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT_NAME = "b31_multiscale_vtip_source.private.json"
OVERLAY_NAME = "b31_multiscale_vtip_review.private.png"
MAX_IMAGE_PIXELS = 4_000_000
MAX_SHAFTS = 256
MAX_TIPS = 128
MAX_REVIEW_BYTES = 8_000_000
LENGTHS = (0.75, 1.0, 1.5)
SLOPES = (0.45, 0.7)
SAMPLE_STEPS = (6, 8, 10, 12, 14)


def _image(png, meta, cv2, np):
    if (len(png) < 24 or png[:8] != b"\x89PNG\r\n\x1a\n" or
            png[12:16] != b"IHDR"):
        raise VisualGateError("VTIP_PNG_HEADER_INVALID")
    iw, ih = int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")
    if (type(meta.get("render_width")) is not int or
            type(meta.get("render_height")) is not int or
            (iw, ih) != (meta["render_width"], meta["render_height"]) or
            iw < 32 or ih < 32 or iw * ih > MAX_IMAGE_PIXELS):
        raise VisualGateError("VTIP_IMAGE_DIMENSIONS_INVALID")
    bgr = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_COLOR)
    if bgr is None or bgr.shape != (ih, iw, 3):
        raise VisualGateError("VTIP_PNG_DECODE_INVALID")
    return bgr


def _hit(mask, x, y, radius=2):
    height, width = mask.shape
    px, py = int(round(x)), int(round(y))
    if px < radius or py < radius or px >= width-radius or py >= height-radius:
        return False
    return bool(mask[py-radius:py+radius+1, px-radius:px+radius+1].any())


def wing_score(mask, endpoint, other):
    """Pixel evidence of V-wings behind endpoint; no topology conclusions."""
    dx, dy = endpoint[0]-other[0], endpoint[1]-other[1]
    length = math.hypot(dx, dy)
    if length < 24:
        return None
    ux, uy = dx / length, dy / length
    nx, ny = -uy, ux
    if not _hit(mask, endpoint[0], endpoint[1], radius=2):
        return None
    best = None
    for factor in LENGTHS:
        for slope in SLOPES:
            counts = [0, 0]
            for step in SAMPLE_STEPS:
                k = step*factor
                for side in (-1, 1):
                    x = endpoint[0] - ux*k + side*nx*k*slope
                    y = endpoint[1] - uy*k + side*ny*k*slope
                    counts[0 if side == -1 else 1] += int(_hit(mask, x, y, radius=1))
            low = min(counts)
            if low < 3:
                continue
            # Ranking only: >=3 distinct lengths supporting both wings.
            value = (low, sum(counts), -abs(factor-1.), -abs(slope-.7))
            if best is None or value > best[0]:
                best = (value, factor, slope, counts)
    if best is None:
        return None
    _, scale, slope, counts = best
    return {"endpoint": [round(float(v), 2) for v in endpoint],
            "wing_support": counts, "scale": scale, "slope": slope,
            "support_min": min(counts)}


def source_vtip_hypotheses(png, meta, cv_data, cv2, np):
    bgr = _image(png, meta, cv2, np)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    corners = np.concatenate([gray[:8, :8].ravel(), gray[:8, -8:].ravel(),
                              gray[-8:, :8].ravel(), gray[-8:, -8:].ravel()])
    dark_ink = float(np.median(corners)) >= 128
    flag = cv2.THRESH_BINARY_INV if dark_ink else cv2.THRESH_BINARY
    _, binary = cv2.threshold(gray, 0, 255, flag | cv2.THRESH_OTSU)
    mask = binary > 0
    lines = cv_data["hough_line_candidates"]
    shafts = merge_fragments(lines, meta["render_width"], meta["render_height"])
    if len(shafts) > MAX_SHAFTS:
        raise VisualGateError("VTIP_SHAFT_BUDGET_EXCEEDED")
    hits = []
    for index, shaft in enumerate(shafts):
        a, b = shaft["endpoints"]
        for end, (tip, other) in enumerate(((a, b), (b, a))):
            score = wing_score(mask, tip, other)
            if score is None:
                continue
            score["shaft_index"], score["end_index"] = index, end
            hits.append(score)
    hits.sort(key=lambda p: (-p["support_min"], -sum(p["wing_support"]),
                            p["shaft_index"], p["end_index"]))
    total_hits = len(hits)
    hypotheses = hits[:MAX_TIPS]
    # Overlay for private human/independent inspection only. No OCR or
    # model text generated. The background itself contains original page.
    overlay = bgr.copy()
    for shaft in shafts[:120]:
        a, b = shaft["endpoints"]
        cv2.line(overlay, tuple(round(z) for z in a), tuple(round(z) for z in b),
                 (255, 160, 0), 1, cv2.LINE_AA)
    for hit in hypotheses[:64]:
        point = hit["endpoint"]
        cv2.circle(overlay, (round(point[0]), round(point[1])),
                   6, (0, 0, 255), 2, cv2.LINE_AA)
    cv2.putText(overlay, "SOURCE PIXELS ONLY - GEOMETRIC HYPOTHESES / NOT GOLD",
                (8, min(24, meta["render_height"]-8)),
                cv2.FONT_HERSHEY_SIMPLEX, .42, (255, 0, 255), 1, cv2.LINE_AA)
    ok, encoded = cv2.imencode(".png", overlay)
    if not ok or not 0 < len(encoded) <= MAX_REVIEW_BYTES:
        raise VisualGateError("VTIP_OVERLAY_ENCODE_REJECTED")
    return {
        "schema_version": 1,
        "evidence": "B31_ORIGINAL_RASTER_V_WING_MULTISCALE_UNVERIFIED",
        "book_id": "B31",
        "physical_page": 126,
        "image_width": meta["render_width"],
        "image_height": meta["render_height"],
        "original_shaft_hypotheses": len(shafts),
        "candidate_endpoint_count_total": total_hits,
        "endpoint_candidates": hypotheses,
        "endpoint_candidates_truncated": total_hits > MAX_TIPS,
        "length_scales": list(LENGTHS),
        "slope_scales": list(SLOPES),
        "node_count_verified": False,
        "arrow_direction_verified": False,
        "independent_graph_gold": None,
        "certified_graph_f1": None,
        "provider_calls": 0,
    }, encoded.tobytes()


def _exclusive(path, payload):
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "wb") as file:
        file.write(payload)


def run(root, manifest, cv2, np, *, write=False):
    png, meta, folder = read_evidence(root, manifest)
    report_path, overlay_path = folder / REPORT_NAME, folder / OVERLAY_NAME
    if any(p.exists() or p.is_symlink() for p in (report_path, overlay_path)):
        raise VisualGateError("VTIP_REPORT_ALREADY_EXISTS_NO_OVERWRITE")
    cv_data = load_source_report(folder, meta)
    results, overlay = source_vtip_hypotheses(png, meta, cv_data, cv2, np)
    results["private_review_png_sha256"] = hashlib.sha256(overlay).hexdigest()
    results["source_document_sha256"] = meta["source_document_sha256"]
    results["source_page_png_sha256"] = meta["private_png_sha256"]
    results["source_cv_input_truncated"] = bool(
        cv_data.get("line_candidates_truncated") or
        cv_data.get("triangles_truncated"))
    if write:
        # If either creation fails, leave the partial receipt to prevent
        # any silent overwrite/retry; owner inspects and repairs separately.
        _exclusive(overlay_path, overlay)
        _exclusive(report_path, (json.dumps(results, sort_keys=True,
                          ensure_ascii=True, separators=(",", ":"))+"\n").encode("utf-8"))
    return results


def audit_existing(root, manifest):
    """Idempotent read-only verification for subsequent exact-head CI runs."""
    _, meta, folder = read_evidence(root, manifest)
    load_source_report(folder, meta)
    p_json, p_png = folder / REPORT_NAME, folder / OVERLAY_NAME
    for p, limit in ((p_json, 150_000), (p_png, MAX_REVIEW_BYTES)):
        if p.is_symlink() or not p.is_file() or not 0 < p.stat().st_size <= limit:
            raise VisualGateError("VTIP_EXISTING_PACKET_INCOMPLETE_OR_UNSAFE")
    try:
        report = json.loads(p_json.read_text(encoding="utf-8"),
                            object_pairs_hook=no_duplicate_keys,
                            parse_constant=reject_constant)
    except (ValueError, UnicodeError, TypeError):
        raise VisualGateError("VTIP_EXISTING_JSON_INVALID") from None
    if (not isinstance(report, dict) or
            report.get("schema_version") != 1 or
            report.get("evidence") != "B31_ORIGINAL_RASTER_V_WING_MULTISCALE_UNVERIFIED" or
            report.get("book_id") != "B31" or
            type(report.get("physical_page")) is not int or
            report["physical_page"] != 126 or
            report.get("source_document_sha256") != meta["source_document_sha256"] or
            report.get("source_page_png_sha256") != meta["private_png_sha256"] or
            report.get("node_count_verified") is not False or
            report.get("arrow_direction_verified") is not False or
            report.get("independent_graph_gold", object()) is not None or
            report.get("certified_graph_f1", object()) is not None or
            report.get("provider_calls") != 0 or
            report.get("private_review_png_sha256") !=
            hashlib.sha256(p_png.read_bytes()).hexdigest()):
        raise VisualGateError("VTIP_EXISTING_PACKET_PROVENANCE_INVALID")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--audit-only", action="store_true")
    args = parser.parse_args(argv)
    import cv2
    import numpy as np
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    if args.write and args.audit_only:
        raise VisualGateError("VTIP_MUTUAL_EXCLUSIVE_MODES")
    info = (audit_existing(Path(args.private_root), manifest) if args.audit_only
            else run(Path(args.private_root), manifest, cv2, np, write=args.write))
    print("ACS_B31_VTIP_STATUS=" +
          ("PRIVATE_REVIEW_PACKET_CREATED" if args.write else
           "EXISTING_PRIVATE_PACKET_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_B31_VTIP_MERGED_SHAFTS=" + str(info["original_shaft_hypotheses"]))
    print("ACS_B31_VTIP_GEOMETRIC_ENDPOINT_CANDIDATES=" +
          str(info["candidate_endpoint_count_total"]))
    print("ACS_B31_VTIP_ARROW_DIRECTION=UNVERIFIED")
    print("ACS_B31_VTIP_GRAPH_GOLD=UNVERIFIED")
    print("ACS_B31_VTIP_PROVIDER_CALLS=0")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VisualGateError, ValueError, TypeError, OSError, ImportError) as exc:
        print("ACS_B31_VTIP_REJECTED=" +
              (exc.code if isinstance(exc, VisualGateError) else type(exc).__name__))
        sys.exit(2)
