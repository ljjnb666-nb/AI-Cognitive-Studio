#!/usr/bin/env python3
"""Independent B31 PDF page pixel evidence, never model-produced graph gold.

Render only the SHA-pinned ORIGINAL PDF page. Never import/read LLM replies,
prediction/candidate files, private keys, or external endpoints.
Source-only packet is private and NOT a verified topology reference.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from ebook_private_native_pages import _raw_sources
from ebook_private_glm_visual_reference import source_manifest, VisualGateError

BOOK = "B31"
PHYSICAL = 126
PACKET_BASENAME = "b31_source_only_page126"
PNG_LIMIT = 4_500_000


def private_dir(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise VisualGateError("SOURCE_PACKET_PRIVATE_ROOT_UNSAFE")
    safe = root.resolve(strict=True)
    output = safe / "semantic_gate"
    if output.is_symlink() or not output.is_dir():
        raise VisualGateError("SOURCE_PACKET_OUTPUT_DIRECTORY_MISSING_OR_UNSAFE")
    if not output.resolve(strict=True).is_relative_to(safe):
        raise VisualGateError("SOURCE_PACKET_OUTPUT_ESCAPE")
    return safe, output


def pinned_pdf(root, manifest):
    source = source_manifest(manifest)[BOOK]
    table = {(source["size"], source["sha256"]): BOOK}
    found = None
    for book, raw in _raw_sources(root, table):
        if book != BOOK:
            continue
        if found is not None:
            raise VisualGateError("SOURCE_PACKET_AMBIGUOUS_MATCH")
        found = raw
        # Duplicate source copies are possible; first SHA-exact match suffices.
        break
    if found is None:
        raise VisualGateError("SOURCE_PACKET_PDF_NOT_FOUND")
    if len(found) != source["size"] or hashlib.sha256(found).hexdigest() != source["sha256"]:
        raise VisualGateError("SOURCE_PACKET_SOURCE_MISMATCH")
    return found, source


def independent_observation(pdf_bytes, source, fitz):
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        if document.page_count != source["total_physical_pages"]:
            raise VisualGateError("SOURCE_PACKET_PAGE_COUNT_MISMATCH")
        page = document[PHYSICAL - 1]
        if int(page.rotation) != 0:
            raise VisualGateError("SOURCE_PACKET_ROTATION_MISMATCH")
        pixel = page.get_pixmap(matrix=fitz.Matrix(1.4, 1.4),
                                alpha=False, colorspace=fitz.csRGB)
        if pixel.width > 2500 or pixel.height > 2500:
            raise VisualGateError("SOURCE_PACKET_RENDER_LIMIT")
        png = pixel.tobytes("png")
        if not 0 < len(png) <= PNG_LIMIT:
            raise VisualGateError("SOURCE_PACKET_PNG_SIZE_LIMIT")
        # Counts are independent source format observations, not graph nodes.
        drawing_paths = len(page.get_drawings())
        image_placements = len(page.get_images(full=True))
        text_blocks = sum(1 for block in page.get_text("blocks")
                          if len(block) > 6 and block[6] == 0)
        return png, {
            "schema_version": 1,
            "provenance": "PDF_NATIVE_INDEPENDENT_OF_GLM_PREDICTION",
            "book_id": BOOK,
            "physical_page": PHYSICAL,
            "source_document_sha256": source["sha256"],
            "original_pdf_pages": document.page_count,
            "rotation": int(page.rotation),
            "render_width": pixel.width,
            "render_height": pixel.height,
            "private_png_sha256": hashlib.sha256(png).hexdigest(),
            "native_drawing_paths": drawing_paths,
            "native_image_entries": image_placements,
            "native_text_blocks": text_blocks,
            "interpretation": "SOURCE_ONLY_NOT_GRAPH_GOLD",
            "certified_graph_f1": None,
            "human_verified": False,
        }


def exclusive_bytes(path, content):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(content)


def run(root, manifest, fitz, *, write_packet=False):
    safe, folder = private_dir(root)
    image_path = folder / (PACKET_BASENAME + ".private.png")
    meta_path = folder / (PACKET_BASENAME + ".private.json")
    if image_path.exists() or image_path.is_symlink() or meta_path.exists() or meta_path.is_symlink():
        raise VisualGateError("SOURCE_PACKET_ALREADY_EXISTS_NO_REPLACEMENT")
    raw, source = pinned_pdf(safe, manifest)
    png, metadata = independent_observation(raw, source, fitz)
    if write_packet:
        # No uploads and no edits to request/reply/candidate. If a partial
        # write occurs, future runs fail closed rather than overwrite.
        exclusive_bytes(image_path, png)
        exclusive_bytes(meta_path, (
            json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode("utf-8"))
    return {**metadata, "written": write_packet}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--private-root", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--write-packet", action="store_true")
    args = ap.parse_args(argv)
    import fitz
    root = Path(args.private_root)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    result = run(root, manifest, fitz, write_packet=args.write_packet)
    print("ACS_B31_SOURCE_PACKET=" + ("PRIVATE_WRITTEN" if result["written"] else "READONLY_READY"))
    print("ACS_B31_SOURCE_NATIVE_DRAWINGS=" + str(result["native_drawing_paths"]))
    print("ACS_B31_SOURCE_NATIVE_IMAGE_ENTRIES=" + str(result["native_image_entries"]))
    print("ACS_B31_SOURCE_NATIVE_TEXT_BLOCKS=" + str(result["native_text_blocks"]))
    print("ACS_B31_SOURCE_RENDER_PIXELS=" + str(result["render_width"] * result["render_height"]))
    print("ACS_B31_SOURCE_INDEPENDENT_GRAPH_GOLD=UNVERIFIED")
    print("ACS_B31_SOURCE_NEW_PROVIDER_REQUESTS=0")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VisualGateError, OSError, ValueError, TypeError) as exc:
        print("ACS_B31_SOURCE_PACKET_REJECTED=" +
              (exc.code if isinstance(exc, VisualGateError) else type(exc).__name__))
        sys.exit(2)
