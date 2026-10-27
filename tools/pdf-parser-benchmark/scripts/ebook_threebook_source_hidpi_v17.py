#!/usr/bin/env python3
"""Private SHA-bound high-DPI original-page packet for B08/B29/B31.

Only existing verified staged PDFs, no OCR or AI, no publisher text in logs.
This creates review pixels, NEVER independent gold or CER.
"""
import argparse
from io import BytesIO
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

from ebook_fivebook_mineru_basic_matrix import source_contract
from ebook_multibook_native_matrix import _private_folder
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

TARGETS = (("B08",64), ("B29",72), ("B31",126))
SUBDIR = "b08_b29_b31_source_hidpi_v17"
REPORT = "b08_b29_b31_source_hidpi.v17.private.json"
INDEX = "B08_B29_B31_来源原图九宫格.private.html"
ZOOM = 3.0
MAX_PDF = 35_000_000
MAX_PIXELS = 12_000_000
MAX_FULL = 18_000_000
MAX_TILE = 7_000_000
MAX_REPORT = 18_000


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(data):
    return (json.dumps(data,sort_keys=True,ensure_ascii=False,
                       separators=(",",":"))+"\n").encode("utf-8")


def packet(root, manifest, *, contract_fn=source_contract, fitz_module=None):
    if fitz_module is None:
        import fitz as fitz_module
    from PIL import Image, ImageFile
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    contract = contract_fn(root,manifest)
    if not isinstance(contract,(tuple,list)) or not contract or not isinstance(contract[0],dict):
        raise VisualGateError("THREEBOOK_SOURCE_CONTRACT_INVALID")
    source=contract[0]
    folder=_private_folder(root)
    blobs={}
    reports=[]
    sections=[]
    for book,page in TARGETS:
        info=source.get(book)
        if (not isinstance(info,dict) or info.get("physical_page")!=page or
            not isinstance(info.get("single_pdf_sha256"),str) or
            not isinstance(info.get("original_pdf_sha256"),str) or
            len(info["single_pdf_sha256"])!=64 or
            len(info["original_pdf_sha256"])!=64):
            raise VisualGateError("THREEBOOK_SOURCE_IDENTITY_INVALID")
        path=Path(info.get("source_file",""))
        if (path.is_symlink() or not path.is_file() or
            not 0<path.stat().st_size<=MAX_PDF):
            raise VisualGateError("THREEBOOK_SOURCE_FILE_INVALID")
        raw=path.read_bytes()
        if sha(raw)!=info["single_pdf_sha256"]:
            raise VisualGateError("THREEBOOK_SOURCE_PDF_SHA_CHANGED")
        try:
            with fitz_module.open(stream=raw,filetype="pdf") as doc:
                if doc.page_count!=1:
                    raise VisualGateError("THREEBOOK_STAGED_PAGE_COUNT_INVALID")
                pix=doc[0].get_pixmap(matrix=fitz_module.Matrix(ZOOM,ZOOM),
                                      colorspace=fitz_module.csRGB,alpha=False)
                w,h=pix.width,pix.height
                if not 0<w*h<=MAX_PIXELS:
                    raise VisualGateError("THREEBOOK_RENDER_PIXELS_EXCEEDED")
                full=pix.tobytes("png")
            if not 0<len(full)<=MAX_FULL:
                raise VisualGateError("THREEBOOK_RENDER_SIZE_EXCEEDED")
            with Image.open(BytesIO(full)) as im:
                im.load()
                if im.format!="PNG" or im.size!=(w,h):
                    raise VisualGateError("THREEBOOK_RENDER_INVALID")
                full_name=f"{book}_p{page:04d}_FULL.private.png"
                blobs[full_name]=full
                cells=[]
                figures=[]
                for r in range(3):
                    for c in range(3):
                        bounds=(c*w//3,r*h//3,(c+1)*w//3,(r+1)*h//3)
                        name=f"{book}_p{page:04d}_R{r+1}C{c+1}.private.png"
                        with BytesIO() as dest:
                            im.crop(bounds).save(dest,format="PNG")
                            tile=dest.getvalue()
                        if not 0<len(tile)<=MAX_TILE:
                            raise VisualGateError("THREEBOOK_TILE_TOO_LARGE")
                        blobs[name]=tile
                        cells.append(dict(region=f"R{r+1}C{c+1}",filename=name,
                                          bounds=list(bounds),sha256_private=sha(tile)))
                        figures.append(f'<figure><img loading="lazy" src="{name}" '
                                       f'alt="{book} R{r+1}C{c+1}"><figcaption>R{r+1}C{c+1}</figcaption></figure>')
        except VisualGateError:
            raise
        except (OSError,ValueError,RuntimeError,MemoryError):
            raise VisualGateError("THREEBOOK_RENDER_FAILED") from None
        reports.append(dict(book_id=book,physical_page=page,
                            original_pdf_sha256_private=info["original_pdf_sha256"],
                            staged_pdf_sha256_private=info["single_pdf_sha256"],
                            full_png_name=full_name,full_png_sha256_private=sha(full),
                            full_png_dimensions=[w,h],zoom_matrix=ZOOM,tiles=cells,
                            no_inference=True,independent_gold=False))
        sections.append(f'<section><h2>{book} · PDF 物理页 {page}</h2><div class="grid">'
                        +''.join(figures)+'</div></section>')
    html=('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
          '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' file:; style-src \'unsafe-inline\'; connect-src \'none\'; script-src \'none\'; form-action \'none\'">'
          '<title>三书原始物理页高分辨率来源核验</title><style>'
          'body{font:16px/1.5 system-ui,sans-serif;background:#f5f7fa;color:#152538;margin:20px}'
          'section{background:white;padding:16px;margin:20px 0;border-radius:12px}'
          '.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}'
          'figure{margin:0;overflow:auto;border:1px solid #ccd6e3}img{display:block;width:100%}'
          'figcaption{text-align:center}</style></head><body><h1>B08 / B29 / B31 原始来源九宫格</h1>'
          '<p>仅使用私有 SHA 固定的原始物理页，无 OCR、模型或人工批准；图表、正文与全页 Gold 尚待独立核验。</p>'
          +''.join(sections)+'</body></html>').encode('utf-8')
    report=dict(schema_version=17,status="SOURCE_ONLY_NOT_GOLD",pages=3,tiles=27,
                full_images=3,source_contract_validated=True,
                zero_provider_calls=True,independent_approval=False,
                full_page_reference=None,cer=None,rows=reports)
    blob=encode(report)
    if len(blob)>MAX_REPORT or len(blobs)!=30:
        raise VisualGateError("THREEBOOK_PACKET_INVALID")
    blobs[REPORT]=blob
    blobs[INDEX]=html
    return folder,blobs,report


def execute(root,manifest,*,write=False,audit=False,contract_fn=source_contract):
    if write==audit:
        raise VisualGateError("THREEBOOK_EXPLICIT_MODE_REQUIRED")
    folder,blobs,report=packet(root,manifest,contract_fn=contract_fn)
    target=folder/SUBDIR
    if audit:
        if target.is_symlink() or not target.is_dir() or {x.name for x in target.iterdir()}!=set(blobs):
            raise VisualGateError("THREEBOOK_AUDIT_FILE_SET_CHANGED")
        for name,raw in blobs.items():
            p=target/name
            if p.is_symlink() or not p.is_file() or p.read_bytes()!=raw:
                raise VisualGateError("THREEBOOK_AUDIT_BYTES_CHANGED")
    else:
        if target.exists() or target.is_symlink():
            raise VisualGateError("THREEBOOK_SNAPSHOT_ALREADY_EXISTS")
        with tempfile.TemporaryDirectory(prefix=".threebook-v17-",dir=folder) as temporary:
            staging=Path(temporary)
            for name,raw in blobs.items():
                with (staging/name).open("xb") as stream:
                    stream.write(raw)
            if target.exists() or target.is_symlink():
                raise VisualGateError("THREEBOOK_SNAPSHOT_ALREADY_EXISTS")
            os.rename(staging,target)
    return report


def main():
    cli=argparse.ArgumentParser()
    cli.add_argument("--private-root",required=True)
    cli.add_argument("--manifest",required=True)
    mode=cli.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write",action="store_true")
    mode.add_argument("--audit-only",action="store_true")
    args=cli.parse_args()
    try:
        manifest=json.loads(Path(args.manifest).read_text('utf-8'),
                            object_pairs_hook=no_duplicate_keys,parse_constant=reject_constant)
        result=execute(Path(args.private_root),manifest,write=args.write,audit=args.audit_only)
        print("ACS_THREEBOOK_HIDPI_V17="+("PRIVATE_CREATED" if args.write else "PRIVATE_AUDIT_PASS"))
        print("ACS_THREEBOOK_HIDPI_V17_PAGES="+str(result['pages']))
        print("ACS_THREEBOOK_HIDPI_V17_TILES="+str(result['tiles']))
        print("ACS_THREEBOOK_HIDPI_V17_GOLD=UNVERIFIED")
        print("ACS_THREEBOOK_HIDPI_V17_MODEL_CALLS=0")
    except Exception:
        print("ACS_THREEBOOK_HIDPI_V17=REJECTED")
        return 2
    return 0

if __name__=='__main__':
    sys.exit(main())
