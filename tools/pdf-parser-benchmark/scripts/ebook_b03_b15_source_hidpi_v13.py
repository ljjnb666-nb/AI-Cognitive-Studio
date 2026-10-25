#!/usr/bin/env python3
"""Source-only B03/B15 true PDF re-render into private high-DPI review tiles.

The source is SHA-pinned staged one-page PDF, verified against original book
by the existing five-book source_contract. No OCR, inference, source text,
reference authority or CER is generated. Private PNGs never leave D:.
"""
import argparse
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile

from ebook_fivebook_mineru_basic_matrix import source_contract
from ebook_multibook_native_matrix import _private_folder
from ebook_private_glm_visual_reference import VisualGateError
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant

TARGETS=(("B03",67),("B15",109))
SUBDIR="b03_b15_source_hidpi_v13"
REPORT="b03_b15_hidpi_source_review.v13.private.json"
INDEX="B03_B15_原页高分辨率九宫格.private.html"
ZOOM=3.0
MAX_PDF=35_000_000
MAX_PIXELS=12_000_000
MAX_SOURCE_PNG=18_000_000
MAX_TILE_PNG=7_000_000
MAX_RECEIPT=10_000


def sha(data):
    return hashlib.sha256(data).hexdigest()


def render_tiles(entries, *, fitz_module=None):
    if fitz_module is None:
        import fitz as fitz_module
    from PIL import Image, ImageFile
    Image.MAX_IMAGE_PIXELS=MAX_PIXELS
    ImageFile.LOAD_TRUNCATED_IMAGES=False
    result={}
    records=[]
    for book,page in TARGETS:
        entry=entries.get(book)
        if (not isinstance(entry,dict) or entry.get("physical_page")!=page
                or not isinstance(entry.get("single_pdf_sha256"),str)
                or len(entry["single_pdf_sha256"])!=64
                or not isinstance(entry.get("original_pdf_sha256"),str)
                or len(entry["original_pdf_sha256"])!=64):
            raise VisualGateError("HIDPI_SOURCE_ENTRY_INVALID")
        path=Path(entry.get("source_file",""))
        if (path.is_symlink() or not path.is_file() or
                not 0<path.stat().st_size<=MAX_PDF):
            raise VisualGateError("HIDPI_SOURCE_FILE_UNSAFE")
        pdf=path.read_bytes()
        if sha(pdf)!=entry["single_pdf_sha256"]:
            raise VisualGateError("HIDPI_STAGED_SOURCE_SHA_CHANGED")
        try:
            with fitz_module.open(stream=pdf,filetype="pdf") as doc:
                if doc.page_count!=1:
                    raise VisualGateError("HIDPI_STAGED_PAGE_COUNT_CHANGED")
                bitmap=doc[0].get_pixmap(matrix=fitz_module.Matrix(ZOOM,ZOOM),
                                         colorspace=fitz_module.csRGB,alpha=False)
                w,h=bitmap.width,bitmap.height
                if not 0<w*h<=MAX_PIXELS:
                    raise VisualGateError("HIDPI_RENDER_BUDGET_EXCEEDED")
                full=bitmap.tobytes("png")
            if not 0<len(full)<=MAX_SOURCE_PNG:
                raise VisualGateError("HIDPI_RENDER_BYTES_EXCEEDED")
            with Image.open(BytesIO(full)) as im:
                im.load()
                if im.format!="PNG" or im.size!=(w,h):
                    raise VisualGateError("HIDPI_RENDER_IMAGE_INVALID")
                tiles=[]
                for row in range(3):
                    for col in range(3):
                        left,top=col*w//3,row*h//3
                        right,bottom=(col+1)*w//3,(row+1)*h//3
                        if left>=right or top>=bottom:
                            raise VisualGateError("HIDPI_TILE_GEOMETRY_INVALID")
                        name=f"{book}_p{page:04d}_R{row+1}C{col+1}.private.png"
                        with BytesIO() as buffer:
                            im.crop((left,top,right,bottom)).save(buffer,format="PNG")
                            payload=buffer.getvalue()
                        if not 0<len(payload)<=MAX_TILE_PNG:
                            raise VisualGateError("HIDPI_TILE_BYTES_EXCEEDED")
                        result[name]=payload
                        tiles.append({"region":f"R{row+1}C{col+1}","filename":name,
                                      "crop_pixels":[left,top,right,bottom],
                                      "sha256_private":sha(payload)})
        except VisualGateError:
            raise
        except (OSError,ValueError,RuntimeError,MemoryError):
            raise VisualGateError("HIDPI_RENDER_FAILED") from None
        records.append({"book_id":book,"physical_page":page,
                        "original_book_pdf_sha256_private":entry["original_pdf_sha256"],
                        "staged_page_pdf_sha256_private":entry["single_pdf_sha256"],
                        "render_size_pixels":[w,h],"zoom_matrix":ZOOM,
                        "region_tiles":tiles,
                        "intrinsic_scan_detail_not_guaranteed":True,
                        "source_only_not_independent_gold":True})
    return result,records


def html_page():
    groups=[]
    for book,page in TARGETS:
        imgs=[]
        for row in range(1,4):
            for col in range(1,4):
                name=f"{book}_p{page:04d}_R{row}C{col}.private.png"
                imgs.append(f'<figure><img loading="lazy" src="{name}" alt="{book} R{row}C{col}"><figcaption>R{row}C{col}</figcaption></figure>')
        groups.append(f'<section><h2>{book} · PDF 物理页 {page}</h2><div class="grid">'+''.join(imgs)+'</div></section>')
    return ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' file:; style-src \'unsafe-inline\'; connect-src \'none\'">'
            '<title>来源真 PDF 高分辨率九宫格（未审核）</title>'
            '<style>body{font:16px/1.5 system-ui,sans-serif;color:#17253d;background:#f2f5fa;margin:20px}'
            'section{background:white;margin:18px 0;padding:16px;border-radius:10px}'
            '.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}'
            'figure{margin:0;overflow:auto;border:1px solid #dde3ec}img{width:100%;display:block}'
            'figcaption{text-align:center;background:#f1f5f9}p{max-width:1100px}</style></head><body>'
            '<h1>B03 / B15 原始 PDF 重渲染 · 九宫格</h1>'
            '<p>本页仅来源像素：非 OCR、非自动校对、非独立金标准。'
            '每张九宫格由原始同源单页 PDF 重新渲染；若原始扫描像素不足，提高渲染比例不能恢复缺失笔画。'
            '所有原文和 SHA 仅留在本地私有目录；图例、标点、竖排与阅读顺序仍须独立复核。</p>'
            +''.join(groups)+'</body></html>')


def packet(root,manifest,*,contract_fn=source_contract,fitz_module=None):
    contract=contract_fn(root,manifest)
    if not isinstance(contract,(tuple,list)) or not contract:
        raise VisualGateError("HIDPI_SOURCE_CONTRACT_MISSING")
    folder=_private_folder(root)
    pictures,records=render_tiles(contract[0],fitz_module=fitz_module)
    receipt={"schema_version":13,
             "evidence":"SHA_BOUND_SOURCE_ONLY_HIDPI_TILES_NO_REFERENCE_NO_CER",
             "pages":len(TARGETS),"tiles":len(pictures),
             "reviewer_approval":None,"gold_reference":None,"cer":None,
             "ocr_or_model_calls":0,"source_pages":records}
    report=(json.dumps(receipt,sort_keys=True,ensure_ascii=False,
                       separators=(",",":"))+"\n").encode("utf-8")
    if len(report)>MAX_RECEIPT:
        raise VisualGateError("HIDPI_RECEIPT_TOO_LARGE")
    out={**pictures,REPORT:report,INDEX:html_page().encode("utf-8")}
    if len(out)!=20:
        raise VisualGateError("HIDPI_ARTIFACT_COUNT_INVALID")
    return folder,out,receipt


def execute(root,manifest,*,write=False,audit=False,contract_fn=source_contract,
            fitz_module=None):
    if write==audit:
        raise VisualGateError("HIDPI_EXPLICIT_MODE_REQUIRED")
    folder,outputs,receipt=packet(root,manifest,contract_fn=contract_fn,
                                  fitz_module=fitz_module)
    dest=folder/SUBDIR
    if audit:
        if (dest.is_symlink() or not dest.is_dir() or
                set(x.name for x in dest.iterdir())!=set(outputs)):
            raise VisualGateError("HIDPI_AUDIT_FILE_SET_INVALID")
        for name,raw in outputs.items():
            p=dest/name
            if p.is_symlink() or not p.is_file() or p.read_bytes()!=raw:
                raise VisualGateError("HIDPI_AUDIT_BYTES_CHANGED")
    else:
        if dest.exists() or dest.is_symlink():
            raise VisualGateError("HIDPI_PRIVATE_SNAPSHOT_ALREADY_EXISTS")
        with tempfile.TemporaryDirectory(prefix=".hidpi-v13-",dir=folder) as temp:
            temp_path=Path(temp)
            for name,raw in outputs.items():
                p=temp_path/name
                with p.open("xb") as dst:
                    dst.write(raw)
            if dest.exists() or dest.is_symlink():
                raise VisualGateError("HIDPI_PRIVATE_SNAPSHOT_ALREADY_EXISTS")
            os.rename(temp_path,dest)
    return receipt


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write",action="store_true")
    mode.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    try:
        raw=Path(args.manifest).read_bytes()
        manifest=json.loads(raw,object_pairs_hook=no_duplicate_keys,parse_constant=reject_constant)
        data=execute(Path(args.private_root),manifest,write=args.write,audit=args.audit_only)
        print("ACS_HIDPI_SOURCE="+("PRIVATE_CREATED" if args.write else "PRIVATE_AUDIT_PASS"))
        print("ACS_HIDPI_SOURCE_PAGES="+str(data["pages"]))
        print("ACS_HIDPI_SOURCE_TILES="+str(data["tiles"]))
        print("ACS_HIDPI_SOURCE_GOLD=NOT_APPROVED")
        print("ACS_HIDPI_SOURCE_MODEL_CALLS=0")
    except Exception:
        print("ACS_HIDPI_SOURCE=REJECTED")
        return 2
    return 0


if __name__=="__main__":
    sys.exit(main())
