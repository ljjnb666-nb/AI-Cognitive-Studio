#!/usr/bin/env python3
"""Render private SHA-pinned B15/B31 page pixels locally; no network or gold claim."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
from ebook_private_glm_visual_reference import PAGES, VisualGateError, render_page, source_manifest
from ebook_private_native_pages import _raw_sources


def prepare(root, manifest, fitz):
    if not root.is_dir() or root.is_symlink():
        raise VisualGateError("PRIVATE_ROOT_INVALID")
    selected = source_manifest(manifest)
    known = {(item["size"], item["sha256"]): book for book,item in selected.items()}
    sources = {}
    for book, raw in _raw_sources(root, known):
        if book not in sources:
            sources[book] = raw
        if len(sources) == len(PAGES):
            break
    if set(sources) != set(PAGES):
        raise VisualGateError("PRIVATE_SOURCE_BYTES_MISSING")
    image_dir=root/"semantic_gate"/"visual_inputs"
    image_dir.mkdir(parents=True, exist_ok=True)
    if image_dir.is_symlink() or not image_dir.resolve().is_relative_to(root.resolve()):
        raise VisualGateError("PRIVATE_IMAGE_DIRECTORY_INVALID")
    diagnostics=[]
    for book in sorted(PAGES):
        page,kind=PAGES[book]
        source=sources[book]
        if len(source)!=selected[book]["size"] or hashlib.sha256(source).hexdigest()!=selected[book]["sha256"]:
            raise VisualGateError("PRIVATE_SOURCE_SHA_MISMATCH")
        image,rotation,dimensions=render_page(source,page,fitz)
        if rotation != (270 if book=="B15" else 0):
            raise VisualGateError("PDF_PAGE_ROTATION_CHANGED")
        file=image_dir/(book+"_p"+str(page)+"_display.png")
        digest=hashlib.sha256(image).hexdigest()
        if file.exists():
            if file.is_symlink() or file.stat().st_size>4_500_000 or hashlib.sha256(file.read_bytes()).hexdigest()!=digest:
                raise VisualGateError("EXISTING_PRIVATE_RENDER_MISMATCH")
        else:
            fd=os.open(file,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            with os.fdopen(fd,"wb") as output:
                output.write(image)
        diagnostics.append({"id":book,"physical_page":page,"rotation_degrees":rotation,
                            "image_bytes":len(image),"image_sha256":digest,
                            "dimensions":dimensions,"visual_roi":"UNVERIFIED"})
    return diagnostics


def main(argv=None):
    cli=argparse.ArgumentParser()
    cli.add_argument("--root",required=True)
    cli.add_argument("--manifest",required=True)
    a=cli.parse_args(argv)
    root=Path(a.root).resolve(strict=True)
    manifest=json.loads(Path(a.manifest).read_text(encoding="utf-8"))
    import fitz
    details=prepare(root,manifest,fitz)
    for row in details:
        print("ACS_PRIVATE_RENDER="+row["id"]+"|PAGE="+str(row["physical_page"])+
              "|ROTATION="+str(row["rotation_degrees"])+"|ROI=UNVERIFIED")
    print("ACS_PRIVATE_VISUAL_PIXEL_INPUTS_READY="+str(len(details)))
    print("ACS_PRIVATE_RENDER_CLOUD_UPLOAD=NO")
    return 0

if __name__=="__main__":
    try:
        sys.exit(main())
    except (VisualGateError,OSError,ValueError) as error:
        print("ACS_PRIVATE_RENDER_REJECTED="+(error.code if isinstance(error,VisualGateError) else type(error).__name__))
        sys.exit(2)
