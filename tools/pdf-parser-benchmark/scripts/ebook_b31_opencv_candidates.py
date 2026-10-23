#!/usr/bin/env python3
"""Bounded B31 original-PDF raster CV hypotheses. Not graph gold.

Never reads model reply/candidate and never calls an AI provider.
Private coordinates and source SHA stay in D: semantic_gate, never stdout.
"""
import argparse
import json
import os
from pathlib import Path
import sys

from ebook_b31_source_raster_geometry import read_evidence
from ebook_private_glm_visual_reference import VisualGateError

REPORT = "b31_opencv_source_candidates.private.json"
MAX_PIXELS = 4_000_000
MAX_CONTOURS = 30_000
MAX_LINES = 256
MAX_BOXES = 256
MAX_TIPS = 128


def source_candidates(png, source, cv2, np):
    # Validate PNG IHDR before OpenCV allocates decoded pixels.
    if (len(png) < 24 or png[:8] != b"\x89PNG\r\n\x1a\n" or
            png[12:16] != b"IHDR"):
        raise VisualGateError("CV_PNG_IHDR_INVALID")
    declared_w = int.from_bytes(png[16:20], "big")
    declared_h = int.from_bytes(png[20:24], "big")
    if (type(source.get("render_width")) is not int or
            type(source.get("render_height")) is not int or
            declared_w != source["render_width"] or
            declared_h != source["render_height"] or
            declared_w < 32 or declared_h < 32 or
            declared_w * declared_h > MAX_PIXELS):
        raise VisualGateError("CV_PNG_IHDR_DIMENSIONS_INVALID")
    raw = np.frombuffer(png, dtype=np.uint8)
    img = cv2.imdecode(raw, cv2.IMREAD_COLOR)
    if img is None or len(img.shape) != 3 or img.shape[2] != 3:
        raise VisualGateError("CV_SOURCE_DECODE_INVALID")
    h, w = img.shape[:2]
    if (type(source.get("render_width")) is not int or
            type(source.get("render_height")) is not int or
            w != source["render_width"] or h != source["render_height"] or
            w < 32 or h < 32 or w * h > MAX_PIXELS):
        raise VisualGateError("CV_SOURCE_DIMENSIONS_INVALID")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    corners = np.concatenate([gray[:8, :8].ravel(), gray[:8, -8:].ravel(),
                              gray[-8:, :8].ravel(), gray[-8:, -8:].ravel()])
    dark_ink = float(np.median(corners)) >= 128
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    mode = cv2.THRESH_BINARY_INV if dark_ink else cv2.THRESH_BINARY
    _, mask = cv2.threshold(blur, 0, 255, mode | cv2.THRESH_OTSU)
    edges = cv2.Canny(mask, 60, 150, apertureSize=3, L2gradient=True)
    min_line = max(18, min(w, h) // 18)
    raw_lines = cv2.HoughLinesP(edges, 1, np.pi / 180,
                                threshold=max(14, min_line // 2),
                                minLineLength=min_line, maxLineGap=8)
    lines = []
    if raw_lines is not None:
        seen = set()
        for line in raw_lines.reshape(-1, 4).tolist():
            x0, y0, x1, y1 = (int(v) for v in line)
            if (x0, y0) > (x1, y1):
                x0, y0, x1, y1 = x1, y1, x0, y0
            key = (x0 // 10, y0 // 10, x1 // 10, y1 // 10)
            if key not in seen:
                seen.add(key)
                lines.append([x0, y0, x1, y1])
    lines.sort(key=lambda s: (-((s[2]-s[0])**2+(s[3]-s[1])**2), s))
    total_lines = len(lines)
    lines = lines[:MAX_LINES]

    contours = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[-2]
    if len(contours) > MAX_CONTOURS:
        raise VisualGateError("CV_CONTOUR_BUDGET_EXCEEDED")
    rectangles, triangles = [], []
    for contour in contours:
        perimeter, area = cv2.arcLength(contour, True), cv2.contourArea(contour)
        if perimeter < 22 or area < 16 or area > w * h * 0.45:
            continue
        poly = cv2.approxPolyDP(contour, 0.035 * perimeter, True)
        if not cv2.isContourConvex(poly):
            continue
        x, y, bw, bh = cv2.boundingRect(poly)
        if (len(poly) == 4 and bw >= 14 and bh >= 12 and bw * bh >= 200 and
                max(bw, bh) / max(1, min(bw, bh)) <= 8 and
                area / max(1, bw * bh) >= 0.45):
            rectangles.append((int(x), int(y), int(bw), int(bh)))
        elif (len(poly) == 3 and 18 <= area <= min(6500, w*h*0.03) and
              bw >= 5 and bh >= 5 and area / max(1, bw*bh) >= 0.20):
            triangles.append([[int(p[0][0]), int(p[0][1])] for p in poly])
    rectangles = sorted(set(rectangles), key=lambda s: (s[1], s[0], s[2], s[3]))
    total_rectangles = len(rectangles)
    triangle_keys = {tuple(sorted(tuple(p) for p in tri)) for tri in triangles}
    triangles = [list(map(list, tri)) for tri in sorted(triangle_keys)]
    total_triangles = len(triangles)
    rectangles = [list(r) for r in rectangles[:MAX_BOXES]]
    triangles = triangles[:MAX_TIPS]
    # Endpoint/triangle proximity only, never interpret as a proven direction.
    pairs = []
    for li, line in enumerate(lines):
        for end, point in enumerate((line[:2], line[2:])):
            for ti, tri in enumerate(triangles):
                cx = sum(p[0] for p in tri) / 3
                cy = sum(p[1] for p in tri) / 3
                if (point[0]-cx)**2 + (point[1]-cy)**2 <= 18**2:
                    pairs.append([li, end, ti])
                    if len(pairs) >= MAX_TIPS:
                        break
            if len(pairs) >= MAX_TIPS:
                break
        if len(pairs) >= MAX_TIPS:
            break
    return {
        "schema_version": 1,
        "evidence": "SOURCE_OPENCV_UNSUPERVISED_NOT_GRAPH_GOLD",
        "raster_width": w, "raster_height": h,
        "polarity": "dark_ink" if dark_ink else "light_ink",
        "canny_pixels": int(cv2.countNonZero(edges)),
        "hough_line_candidate_count_total": total_lines,
        "hough_line_candidates": lines,
        "line_candidates_truncated": total_lines > MAX_LINES,
        "quadrilateral_candidate_count_total": total_rectangles,
        "quadrilateral_boxes": rectangles,
        "quadrilaterals_truncated": total_rectangles > MAX_BOXES,
        "triangle_candidate_count_total": total_triangles,
        "triangle_vertices": triangles,
        "triangles_truncated": total_triangles > MAX_TIPS,
        "line_endpoint_triangle_proximity": pairs,
        "tip_pair_proximity_truncated": len(pairs) >= MAX_TIPS,
        "node_count_verified": False,
        "arrow_direction_verified": False,
        "independent_graph_gold": None,
        "certified_graph_f1": None,
        "candidate_count_is_not_graph_count": True,
    }


def run(root, manifest, cv2, np, *, write=False):
    png, meta, folder = read_evidence(root, manifest)
    destination = folder / REPORT
    if destination.exists() or destination.is_symlink():
        raise VisualGateError("CV_REPORT_ALREADY_EXISTS_NO_OVERWRITE")
    data = source_candidates(png, meta, cv2, np)
    data.update({
        "source_page_png_sha256": meta["private_png_sha256"],
        "source_document_sha256": meta["source_document_sha256"],
        "book_id": "B31", "physical_page": 126,
    })
    if write:
        content = (json.dumps(data, ensure_ascii=True, sort_keys=True,
                              separators=(",", ":")) + "\n").encode("utf-8")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(destination, flags, 0o600)
        with os.fdopen(fd, "wb") as file:
            file.write(content)
    return data


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--private-root", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args(argv)
    import cv2
    import numpy as np
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    result = run(Path(args.private_root), manifest, cv2, np, write=args.write)
    print("ACS_B31_OPENCV_SOURCE_STATUS=" +
          ("PRIVATE_SAVED" if args.write else "READONLY_READY"))
    for source, label in (
        ("hough_line_candidate_count_total", "HOUGH_SEGMENTS"),
        ("quadrilateral_candidate_count_total", "QUADRILATERAL_CANDIDATES"),
        ("triangle_candidate_count_total", "TRIANGLE_CANDIDATES"),
    ):
        print("ACS_B31_OPENCV_" + label + "=" + str(result[source]))
    print("ACS_B31_OPENCV_ENDPOINT_TIP_PROXIMITIES=" +
          str(len(result["line_endpoint_triangle_proximity"])))
    print("ACS_B31_OPENCV_SOURCE_NODE_GOLD=UNVERIFIED")
    print("ACS_B31_OPENCV_ARROW_DIRECTION=UNVERIFIED")
    print("ACS_B31_OPENCV_NEW_PROVIDER_CALLS=0")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VisualGateError, ValueError, TypeError, OSError, ImportError) as exc:
        print("ACS_B31_OPENCV_REJECTED=" +
              (exc.code if isinstance(exc, VisualGateError) else type(exc).__name__))
        sys.exit(2)
