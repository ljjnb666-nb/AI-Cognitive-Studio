#!/usr/bin/env python3
"""Conservative arrowhead/shaft geometry from B31 original-page CV data.

Only reads source PNG provenance and OpenCV SOURCE geometry. It MUST NOT read
or validate itself against B31 GLM predictions. A geometric shaft+tip pair
is not a certified node, directed graph edge, or ground truth.
"""
import argparse
import json
import math
import os
from pathlib import Path
import sys

from ebook_b31_source_raster_geometry import read_evidence
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

INPUT = "b31_opencv_source_candidates.private.json"
OUTPUT = "b31_arrow_shaft_consensus.private.json"
MAX_INPUT_BYTES = 250_000
MAX_LINES = 256
MAX_TRIANGLES = 128
MAX_PAIRINGS = 128


def _vec(a, b):
    return (float(b[0]) - float(a[0]), float(b[1]) - float(a[1]))


def _length(vec):
    return math.hypot(vec[0], vec[1])


def _distance(a, b):
    return _length(_vec(a, b))


def _bounded_point(point, width, height):
    return (isinstance(point, (tuple, list)) and len(point) == 2 and
            all(type(v) is int for v in point) and
            0 <= point[0] < width and 0 <= point[1] < height)


def _group_from_line(line):
    x0, y0, x1, y1 = line
    dx, dy = float(x1 - x0), float(y1 - y0)
    size = math.hypot(dx, dy)
    if size < 12:
        return None
    if (dx < 0) or (dx == 0 and dy < 0):
        x0, y0, x1, y1 = x1, y1, x0, y0
        dx, dy = -dx, -dy
    return {"origin": (float(x0), float(y0)),
            "unit": (dx / size, dy / size),
            "lo": 0.0, "hi": size, "sources": 1}


def _joined_segment(group):
    ox, oy = group["origin"]
    ux, uy = group["unit"]
    return [[round(ox + group["lo"] * ux, 2),
             round(oy + group["lo"] * uy, 2)],
            [round(ox + group["hi"] * ux, 2),
             round(oy + group["hi"] * uy, 2)]]


def merge_fragments(lines, width, height):
    """Bounded deterministic nearly-collinear joining, not curve tracing."""
    if (type(width) is not int or type(height) is not int or
            width < 32 or height < 32 or width * height > 4_000_000 or
            type(lines) is not list or len(lines) > MAX_LINES):
        raise VisualGateError("ARROW_SEGMENT_INPUT_INVALID")
    clean = []
    for line in lines:
        if (not isinstance(line, list) or len(line) != 4 or
                any(type(v) is not int for v in line) or
                not _bounded_point(line[:2], width, height) or
                not _bounded_point(line[2:], width, height)):
            raise VisualGateError("ARROW_SEGMENT_COORDINATES_INVALID")
        group = _group_from_line(line)
        if group is not None:
            clean.append(group)
    clean.sort(key=lambda group: (-(group["hi"] - group["lo"]),
                                  group["origin"]))
    groups = []
    for part in clean:
        best = None
        for group in groups:
            ux, uy = group["unit"]
            vx, vy = part["unit"]
            if abs(ux * vy - uy * vx) > 0.09 or ux * vx + uy * vy < 0.995:
                continue
            start, end = _joined_segment(part)
            ox, oy = group["origin"]
            if max(abs((pt[0] - ox) * uy - (pt[1] - oy) * ux)
                   for pt in (start, end)) > 6.0:
                continue
            projections = [(pt[0]-ox)*ux + (pt[1]-oy)*uy for pt in (start, end)]
            lo, hi = min(projections), max(projections)
            gap = max(0., group["lo"] - hi, lo - group["hi"])
            if gap > 28.0:
                continue
            best = (group, lo, hi)
            break
        if best is None:
            groups.append(part)
        else:
            item, lo, hi = best
            item["lo"] = min(item["lo"], lo)
            item["hi"] = max(item["hi"], hi)
            item["sources"] += part["sources"]
    groups.sort(key=lambda g: (-_distance(*_joined_segment(g)),
                               _joined_segment(g)[0]))
    return [{"endpoints": _joined_segment(g), "fragment_count": g["sources"]}
            for g in groups]


def triangle_head(tri, width, height):
    """Longest triangle side as tentative base; tip remains only a hypothesis."""
    if (not isinstance(tri, list) or len(tri) != 3 or
            not all(_bounded_point(pt, width, height) for pt in tri)):
        raise VisualGateError("ARROW_TRIANGLE_COORDINATES_INVALID")
    if len({tuple(pt) for pt in tri}) != 3:
        return None
    pairs = [(0, 1, 2), (0, 2, 1), (1, 2, 0)]
    i, j, tip_idx = max(pairs, key=lambda pair: _distance(tri[pair[0]], tri[pair[1]]))
    p0, p1, tip = tri[i], tri[j], tri[tip_idx]
    base = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2]
    span = _distance(p0, p1)
    depth = _distance(base, tip)
    side_a, side_b = _distance(p0, tip), _distance(p1, tip)
    if (not 5 <= span <= max(32, min(width, height) / 3) or
            not 3 <= depth <= max(35, min(width, height) / 4) or
            min(side_a, side_b) < 4 or max(side_a, side_b) /
            min(side_a, side_b) > 2.3 or
            depth / span < 0.28 or depth / span > 2.5):
        return None
    return {"base": base, "tip": list(tip), "span": round(span, 2),
            "depth": round(depth, 2)}


def match_geometries(lines, triangles, width, height):
    """Use shaft alignment with base->tip orientation, never source graph truth."""
    if type(triangles) is not list or len(triangles) > MAX_TRIANGLES:
        raise VisualGateError("ARROW_TRIANGLE_BUDGET_INVALID")
    merged = merge_fragments(lines, width, height)
    heads = []
    for idx, tri in enumerate(triangles):
        head = triangle_head(tri, width, height)
        if head is not None:
            head["index"] = idx
            heads.append(head)
    pairs = []
    potential_proximity = 0
    rejected_alignment = 0
    max_gap = min(36.0, max(16.0, min(width, height) * 0.035))
    min_shaft = max(18.0, min(width, height) / 35)
    for head in heads:
        hv = _vec(head["base"], head["tip"])
        head_size = _length(hv)
        best = None
        for idx, line in enumerate(merged):
            endpoints = line["endpoints"]
            shaft_len = _distance(*endpoints)
            if shaft_len < min_shaft:
                continue
            for end_index in (0, 1):
                endpoint = endpoints[end_index]
                gap = _distance(endpoint, head["base"])
                if gap > max_gap:
                    continue
                potential_proximity += 1
                opposite = endpoints[1 - end_index]
                direction = _vec(opposite, endpoint)
                dot = (direction[0] * hv[0] + direction[1] * hv[1]) / (
                    shaft_len * head_size)
                if dot < 0.92:
                    rejected_alignment += 1
                    continue
                # The tip must project further along the shaft direction
                # than the base, rather than sitting backwards.
                if (endpoint[0]-head["base"][0])*hv[0] + (
                        endpoint[1]-head["base"][1])*hv[1] > 0.65*head_size**2:
                    rejected_alignment += 1
                    continue
                score = round(dot - (gap / max_gap) * 0.18, 4)
                candidate = {
                    "shaft_index": idx,
                    "shaft_end_index": end_index,
                    "triangle_index": head["index"],
                    "tentative_tip": head["tip"],
                    "tentative_base": head["base"],
                    "gap_pixels": round(gap, 2),
                    "direction_alignment": round(dot, 4),
                    "ranking_score": score,
                }
                if best is None or candidate["ranking_score"] > best["ranking_score"]:
                    best = candidate
        if best is not None:
            pairs.append(best)
    pairs.sort(key=lambda x: (-x["ranking_score"], x["triangle_index"],
                              x["shaft_index"]))
    return {
        "schema_version": 1,
        "evidence": "SOURCE_ONLY_SHAFT_TIP_GEOMETRY_HYPOTHESES_NOT_GOLD",
        "raw_hough_segments_used": len(lines),
        "merged_shaft_hypotheses": len(merged),
        "merged_shafts": merged,
        "triangle_inputs": len(triangles),
        "triangle_shape_hypotheses": len(heads),
        "shaft_near_head_proximity_checks": potential_proximity,
        "near_head_rejected_by_alignment": rejected_alignment,
        "tip_aligned_pair_hypotheses": pairs[:MAX_PAIRINGS],
        "tip_pairs_truncated": len(pairs) > MAX_PAIRINGS,
        "arrow_direction_verified": False,
        "node_count_verified": False,
        "independent_graph_gold": None,
        "certified_graph_f1": None,
        "candidate_count_is_not_graph_count": True,
    }


def load_source_report(folder, meta):
    path = folder / INPUT
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_INPUT_BYTES:
        raise VisualGateError("ARROW_CV_REPORT_MISSING_OR_OVERSIZED")
    try:
        data = json.loads(path.read_text(encoding="utf-8"),
                          object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (UnicodeError, ValueError, TypeError):
        raise VisualGateError("ARROW_CV_REPORT_JSON_INVALID") from None
    if (not isinstance(data, dict) or data.get("schema_version") != 1 or
            data.get("evidence") != "SOURCE_OPENCV_UNSUPERVISED_NOT_GRAPH_GOLD" or
            data.get("book_id") != "B31" or
            type(data.get("physical_page")) is not int or data["physical_page"] != 126 or
            data.get("source_document_sha256") != meta["source_document_sha256"] or
            data.get("source_page_png_sha256") != meta["private_png_sha256"] or
            data.get("candidate_count_is_not_graph_count") is not True or
            data.get("node_count_verified") is not False or
            data.get("arrow_direction_verified") is not False or
            data.get("independent_graph_gold", object()) is not None or
            data.get("certified_graph_f1", object()) is not None):
        raise VisualGateError("ARROW_CV_REPORT_PROVENANCE_INVALID")
    for name, max_count in (("hough_line_candidates", MAX_LINES),
                            ("triangle_vertices", MAX_TRIANGLES)):
        if type(data.get(name)) is not list or len(data[name]) > max_count:
            raise VisualGateError("ARROW_CV_REPORT_COLLECTION_INVALID")
    return data


def run(root, manifest, *, write=False):
    _, meta, folder = read_evidence(root, manifest)
    path = folder / OUTPUT
    if path.exists() or path.is_symlink():
        raise VisualGateError("ARROW_REPORT_ALREADY_EXISTS_NO_OVERWRITE")
    cv_data = load_source_report(folder, meta)
    result = match_geometries(
        cv_data["hough_line_candidates"], cv_data["triangle_vertices"],
        meta["render_width"], meta["render_height"])
    result["book_id"] = "B31"
    result["physical_page"] = 126
    result["source_document_sha256"] = meta["source_document_sha256"]
    result["source_page_png_sha256"] = meta["private_png_sha256"]
    result["source_cv_input_truncated"] = bool(
        cv_data.get("line_candidates_truncated") or
        cv_data.get("triangles_truncated"))
    if write:
        content = (json.dumps(result, ensure_ascii=True,
                              sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(path, flags, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(content)
    return result


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--private-root", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args(argv)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    result = run(Path(args.private_root), manifest, write=args.write)
    print("ACS_B31_SHAFT_CONSENSUS=" +
          ("PRIVATE_HYPOTHESES_WRITTEN" if args.write else "READONLY_READY"))
    for key in ("raw_hough_segments_used", "merged_shaft_hypotheses",
                "triangle_shape_hypotheses", "shaft_near_head_proximity_checks",
                "near_head_rejected_by_alignment"):
        print("ACS_B31_SHAFT_" + key.upper() + "=" + str(result[key]))
    print("ACS_B31_SHAFT_TIP_ALIGNED_PAIRS=" +
          str(len(result["tip_aligned_pair_hypotheses"])))
    print("ACS_B31_SHAFT_ARROW_DIRECTION=UNVERIFIED")
    print("ACS_B31_SHAFT_INDEPENDENT_GOLD=UNVERIFIED")
    print("ACS_B31_SHAFT_PROVIDER_CALLS=0")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VisualGateError, ValueError, TypeError, OSError) as exc:
        print("ACS_B31_SHAFT_REJECTED=" +
              (exc.code if isinstance(exc, VisualGateError) else type(exc).__name__))
        sys.exit(2)
