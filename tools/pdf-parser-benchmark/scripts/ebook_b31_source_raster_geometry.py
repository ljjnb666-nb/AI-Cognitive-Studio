#!/usr/bin/env python3
"""B31 source-only raster geometry pilot, never a graph ground truth.

Reads only the immutable original-page PNG and provenance created from the
SHA-pinned PDF. No LLM replies, graph candidates, keys, external calls, OCR
text or image pixels are emitted to GitHub Actions.
"""
import argparse
from collections import deque
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

from ebook_private_glm_visual_reference import source_manifest, VisualGateError
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_b31_independent_source_packet import private_dir

SOURCE_NAME = "b31_source_only_page126"
REPORT_NAME = "b31_source_raster_geometry.private.json"
MAX_PNG_BYTES = 4_500_000
MAX_PIXELS = 4_000_000
TILE = 32


def read_evidence(root, manifest):
    _, folder = private_dir(root)
    image_path = folder / (SOURCE_NAME + ".private.png")
    meta_path = folder / (SOURCE_NAME + ".private.json")
    for file in (image_path, meta_path):
        if file.is_symlink() or not file.is_file():
            raise VisualGateError("RASTER_SOURCE_FILE_UNSAFE_OR_MISSING")
    if image_path.stat().st_size > MAX_PNG_BYTES or meta_path.stat().st_size > 65536:
        raise VisualGateError("RASTER_SOURCE_FILE_OVERSIZED")
    raw = image_path.read_bytes()
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"),
                          object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (UnicodeError, ValueError, TypeError):
        raise VisualGateError("RASTER_SOURCE_METADATA_INVALID") from None
    expected = source_manifest(manifest)["B31"]["sha256"]
    if (not isinstance(meta, dict) or meta.get("schema_version") != 1 or
            meta.get("book_id") != "B31" or
            type(meta.get("physical_page")) is not int or
            meta["physical_page"] != 126 or
            meta.get("source_document_sha256") != expected or
            meta.get("provenance") != "PDF_NATIVE_INDEPENDENT_OF_GLM_PREDICTION" or
            meta.get("human_verified") is not False or
            meta.get("certified_graph_f1", object()) is not None or
            meta.get("private_png_sha256") != hashlib.sha256(raw).hexdigest()):
        raise VisualGateError("RASTER_SOURCE_PROVENANCE_INVALID")
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise VisualGateError("RASTER_SOURCE_PNG_SIGNATURE_INVALID")
    return raw, meta, folder


def source_features(width, height, rgb, channels=3, tile=TILE):
    """Deterministic image-only ink geometry, with no semantic node inference."""
    if (type(width) is not int or type(height) is not int or
            type(channels) is not int or channels != 3 or
            width < 32 or height < 32 or width * height > MAX_PIXELS or
            len(rgb) != width * height * 3):
        raise VisualGateError("RASTER_RGB_SHAPE_INVALID")
    if type(tile) is not int or tile != TILE:
        raise VisualGateError("RASTER_TILE_INVALID")
    sample = []
    for x0, y0 in ((0, 0), (width - 8, 0), (0, height - 8),
                   (width - 8, height - 8)):
        for y in range(y0, y0 + 8):
            for x in range(x0, x0 + 8):
                i = (y * width + x) * 3
                sample.append((rgb[i] * 299 + rgb[i + 1] * 587 +
                               rgb[i + 2] * 114) // 1000)
    background = sorted(sample)[len(sample) // 2]
    foreground_is_dark = background >= 128
    bound = background - 32 if foreground_is_dark else background + 32
    gw, gh = (width + tile - 1) // tile, (height + tile - 1) // tile
    tile_counts = [0] * (gw * gh)
    foreground = bytearray(width * height)
    ink_pixels = 0
    box = [width, height, -1, -1]
    for y in range(height):
        ybase = y * width
        for x in range(width):
            at = ybase + x
            i = at * 3
            level = (rgb[i] * 299 + rgb[i + 1] * 587 +
                     rgb[i + 2] * 114) // 1000
            ink = level <= bound if foreground_is_dark else level >= bound
            if ink:
                foreground[at] = 1
                ink_pixels += 1
                tile_counts[(y // tile) * gw + (x // tile)] += 1
                box[0] = min(box[0], x)
                box[1] = min(box[1], y)
                box[2] = max(box[2], x)
                box[3] = max(box[3], y)

    # These are occupied RASTER TILES, not boxes for semantic diagram nodes.
    occupied = bytearray(gw * gh)
    for ty in range(gh):
        for tx in range(gw):
            tile_pixels = min(tile, width - tx * tile) * min(tile, height - ty * tile)
            occupied[ty * gw + tx] = int(
                tile_counts[ty * gw + tx] * 100 >= tile_pixels * 4)

    visited = bytearray(gw * gh)
    component_boxes = []
    for seed in range(gw * gh):
        if not occupied[seed] or visited[seed]:
            continue
        queue = deque([seed])
        visited[seed] = 1
        xlo, ylo = gw, gh
        xhi, yhi = 0, 0
        cells = 0
        while queue:
            pos = queue.popleft()
            cy, cx = divmod(pos, gw)
            cells += 1
            xlo, xhi = min(xlo, cx), max(xhi, cx)
            ylo, yhi = min(ylo, cy), max(yhi, cy)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < gw and 0 <= ny < gh:
                        idx = ny * gw + nx
                        if occupied[idx] and not visited[idx]:
                            visited[idx] = 1
                            queue.append(idx)
        component_boxes.append({
            "tile_box": [xlo, ylo, xhi, yhi],
            "tile_count": cells,
        })

    # Long uninterrupted raster runs are geometric hints, not proven edges.
    min_run = max(48, min(width, height) // 8)
    horizontal_rows = 0
    for y in range(height):
        run = 0
        for x in range(width):
            run = run + 1 if foreground[y * width + x] else 0
            if run >= min_run:
                horizontal_rows += 1
                break
    vertical_columns = 0
    for x in range(width):
        run = 0
        for y in range(height):
            run = run + 1 if foreground[y * width + x] else 0
            if run >= min_run:
                vertical_columns += 1
                break
    return {
        "schema_version": 1,
        "evidence": "SOURCE_RASTER_GEOMETRY_UNSUPERVISED_NOT_GOLD",
        "image_width": width,
        "image_height": height,
        "corner_median_luma": background,
        "foreground_polarity": "dark" if foreground_is_dark else "light",
        "foreground_pixels": ink_pixels,
        "foreground_bbox": None if box[2] < 0 else box,
        "tile_size": tile,
        "occupied_tiles": sum(occupied),
        "raster_tile_component_count": len(component_boxes),
        "raster_tile_components": component_boxes[:256],
        "component_boxes_truncated": len(component_boxes) > 256,
        "rows_with_long_ink_run": horizontal_rows,
        "columns_with_long_ink_run": vertical_columns,
        "line_run_min_length": min_run,
        "node_count_verified": False,
        "arrow_direction_verified": False,
        "independent_graph_gold": None,
        "certified_graph_f1": None,
    }


def run(root, manifest, fitz, *, write=False):
    png, meta, folder = read_evidence(root, manifest)
    path = folder / REPORT_NAME
    if path.exists() or path.is_symlink():
        raise VisualGateError("RASTER_REPORT_ALREADY_EXISTS")
    pixels = fitz.Pixmap(png)
    if (pixels.n != 3 or pixels.alpha or
            pixels.stride != pixels.width * 3 or
            pixels.width != meta["render_width"] or
            pixels.height != meta["render_height"]):
        raise VisualGateError("RASTER_SOURCE_DECODE_MISMATCH")
    result = source_features(pixels.width, pixels.height, pixels.samples)
    result["book_id"] = "B31"
    result["physical_page"] = 126
    result["source_page_png_sha256"] = meta["private_png_sha256"]
    result["source_document_sha256"] = meta["source_document_sha256"]
    if write:
        serialized = (json.dumps(result, ensure_ascii=True,
                                 sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(path, flags, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(serialized)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)
    import fitz
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    result = run(Path(args.private_root), manifest, fitz, write=args.write)
    print("ACS_B31_RASTER_STATUS=" + ("PRIVATE_REPORT_WRITTEN" if args.write else "READONLY_READY"))
    for key in ("foreground_pixels", "occupied_tiles",
                "raster_tile_component_count", "rows_with_long_ink_run",
                "columns_with_long_ink_run"):
        print("ACS_B31_RASTER_" + key.upper() + "=" + str(result[key]))
    # Availability is a capability hint ONLY, not a claim that OCR was run.
    print("ACS_B31_TESSERACT_ON_PATH=" + str(shutil.which("tesseract") is not None).upper())
    print("ACS_B31_OPENCV_INSTALLED=" + str(importlib.util.find_spec("cv2") is not None).upper())
    print("ACS_B31_ARROW_DIRECTION=UNVERIFIED")
    print("ACS_B31_GRAPH_GOLD=UNVERIFIED")
    print("ACS_B31_NEW_PROVIDER_CALLS=0")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VisualGateError, OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        code = exc.code if isinstance(exc, VisualGateError) else type(exc).__name__
        print("ACS_B31_RASTER_REJECTED=" + code)
        sys.exit(2)
