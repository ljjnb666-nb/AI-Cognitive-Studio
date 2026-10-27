#!/usr/bin/env python3
"""B08 page 64: privately compare SHA-verified neighboring source pages.

Source-only, never an automatic bleed-through conclusion, reference or CER.
Original PDF/pixels stay in the Windows private benchmark directory.
"""
import argparse
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys
import tempfile

BOOK="B08"
FOCUS=64
NEIGHBORS=(63,65)
SUBDIR="b08_adjacent_source_review_v24"
REPORT="b08_adjacent_source.v24.private.json"
INDEX="B08_疑似透印相邻原页镜像审阅.private.html"
FOCUS_PNG="B08_p0064_FULL.private.png"
ZOOM=3.0
MAX_RAW=200_000_000
MAX_IMAGE=18_000_000
MAX_PIXELS=12_000_000
MAX_RECEIPT=15_000
SHA=re.compile(r'^[0-9a-f]{64}$')

class SourceError(ValueError):
    pass

def require(condition,code):
    if not condition: raise SourceError(code)

def digest(raw):return hashlib.sha256(raw).hexdigest()
def canonical(data):return (json.dumps(data,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode('utf8')
def json_safely(data):
    def nodupe(items):
        x={}
        for k,v in items:
            if k in x:raise SourceError('DUPLICATE_JSON_KEYS')
            x[k]=v
        return x
    return json.loads(data.decode('utf8'),object_pairs_hook=nodupe,parse_constant=lambda x: (_ for _ in ()).throw(SourceError('INVALID_JSON_CONSTANT')))

def checked_file(path,max_len):
    require(not path.is_symlink() and path.is_file(),'SOURCE_FILE_MISSING_OR_SYMLINK')
    size=path.stat().st_size
    require(0<size<=max_len,'SOURCE_FILE_SIZE_INVALID')
    return path.read_bytes()

def private_folder(root):
    root=Path(root)
    require(root.is_dir() and not root.is_symlink(),'PRIVATE_ROOT_INVALID')
    parent=root/'semantic_gate'
    folder=parent/'multibook_matrix_20261023'
    require(parent.is_dir() and not parent.is_symlink() and folder.is_dir() and not folder.is_symlink(),'PRIVATE_MATRIX_MISSING')
    return folder

def validate_png(blob):
    from PIL import Image,ImageFile
    Image.MAX_IMAGE_PIXELS=MAX_PIXELS
    ImageFile.LOAD_TRUNCATED_IMAGES=False
    try:
        with Image.open(BytesIO(blob)) as im:
            im.load()
            require(im.format=='PNG' and im.mode in ('L','RGB','RGBA'),'IMAGE_INVALID')
            require(0<im.width*im.height<=MAX_PIXELS,'IMAGE_PIXEL_BUDGET')
            return [im.width,im.height]
    except (OSError,MemoryError,ValueError) as exc:
        if isinstance(exc,SourceError):raise
        raise SourceError('IMAGE_DECODE_FAILED') from None

def build(root,manifest,*,raw_sources_fn=None,fitz_module=None):
    if fitz_module is None:import fitz as fitz_module
    if raw_sources_fn is None:
        from ebook_private_native_pages import _raw_sources as raw_sources_fn
    folder=private_folder(root)
    sources=[r for r in manifest.get('sources',[]) if isinstance(r,dict) and r.get('id')==BOOK]
    require(len(sources)==1,'B08_MANIFEST_MISSING_OR_DUPLICATE')
    row=sources[0]
    require(type(row.get('size')) is int and 0<row['size']<=MAX_RAW and
            isinstance(row.get('sha256'),str) and SHA.fullmatch(row['sha256']) and
            type(row.get('total_physical_pages')) is int and row['total_physical_pages']>=65,'B08_MANIFEST_INVALID')
    v17=folder/'b08_b29_b31_source_hidpi_v17'
    require(v17.is_dir() and not v17.is_symlink(),'V17_PRIVATE_SOURCE_MISSING')
    receipt=json_safely(checked_file(v17/'b08_b29_b31_source_hidpi.v17.private.json',MAX_RECEIPT))
    entries=receipt.get('rows',[])
    entries=[e for e in entries if isinstance(e,dict) and e.get('book_id')==BOOK]
    require(receipt.get('schema_version')==17 and receipt.get('status')=='SOURCE_ONLY_NOT_GOLD' and len(entries)==1 and
            entries[0].get('physical_page')==FOCUS and entries[0].get('original_pdf_sha256_private')==row['sha256'] and
            entries[0].get('full_png_name')==FOCUS_PNG and
            entries[0].get('independent_gold') is False,'V17_RECEIPT_PROVENANCE_INVALID')
    focus=checked_file(v17/FOCUS_PNG,MAX_IMAGE)
    require(digest(focus)==entries[0].get('full_png_sha256_private'),'V17_FOCUS_PNG_SHA_INVALID')
    focal_size=validate_png(focus)
    require(focal_size==entries[0].get('full_png_dimensions'),'V17_FOCUS_DIMENSIONS_CHANGED')
    known={(row['size'],row['sha256']):BOOK}
    matched=None
    for book,raw in raw_sources_fn(Path(root),known):
        if book!=BOOK:continue
        require(len(raw)==row['size'] and digest(raw)==row['sha256'],'ORIGINAL_BOOK_SHA_INVALID')
        matched=raw
        break
    require(matched is not None,'ORIGINAL_B08_PDF_MISSING')
    pngs={FOCUS_PNG:focus}
    mapped=[]
    try:
        with fitz_module.open(stream=matched,filetype='pdf') as doc:
            require(doc.page_count==row['total_physical_pages'],'ORIGINAL_PAGE_COUNT_CHANGED')
            for page in NEIGHBORS:
                pix=doc[page-1].get_pixmap(matrix=fitz_module.Matrix(ZOOM,ZOOM),
                                            alpha=False,colorspace=fitz_module.csRGB)
                require(0<pix.width*pix.height<=MAX_PIXELS,'NEIGHBOR_PIXELS_EXCEEDED')
                data=pix.tobytes('png')
                require(0<len(data)<=MAX_IMAGE,'NEIGHBOR_IMAGE_BYTES_EXCEEDED')
                size=validate_png(data)
                name=f'B08_p{page:04d}_SOURCE.private.png'
                pngs[name]=data
                mapped.append(dict(physical_page=page,filename=name,
                                   png_sha256_private=digest(data),render_dimensions=size,
                                   scan_backside_identity_unverified=True))
    except (OSError,RuntimeError,MemoryError) as ex:
        raise SourceError('ORIGINAL_PDF_RENDER_FAILED') from None
    # CSS mirror does NOT alter source images; the reader judges correspondence.
    html='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'">
<title>B08 相邻原页透印核验 v24</title><style>
body{font:15px/1.45 system-ui,sans-serif;color:#19283a;background:#f4f6f9;margin:20px}
section{background:#fff;padding:16px;margin:16px 0;border-radius:9px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
img{width:100%;display:block} .mirror{transform:scaleX(-1)}
figure{margin:0;border:1px solid #d9e1ea}figcaption{padding:5px;background:#f1f5f9}
</style></head><body><h1>B08 第64物理页 · 相邻原图镜像复核</h1>
<p>原始来源 PDF SHA 固定；对比 p63/p65 两邻页及各自水平镜像，仅供判断疑似反面透印。页面相邻 ≠ 实际纸张背面；本文件不自动批准任何文字或 OCR Gold。</p>
<section class="grid"><figure><img src="B08_p0063_SOURCE.private.png"><figcaption>物理 p63</figcaption></figure>
<figure><img src="B08_p0064_FULL.private.png"><figcaption>物理 p64 · 淡色区重点检查</figcaption></figure>
<figure><img src="B08_p0065_SOURCE.private.png"><figcaption>物理 p65</figcaption></figure></section>
<section class="grid"><figure><img class="mirror" src="B08_p0063_SOURCE.private.png"><figcaption>p63 水平镜像</figcaption></figure>
<figure><img src="B08_p0064_FULL.private.png"><figcaption>p64 原图</figcaption></figure>
<figure><img class="mirror" src="B08_p0065_SOURCE.private.png"><figcaption>p65 水平镜像</figcaption></figure></section>
<p>若存在上下错位、翻转、缩放差异，单凭视觉相似不能判为同一印刷面。所有内容均保留在 Windows D: 私有目录，不上传。</p></body></html>'''.encode('utf8')
    report=dict(schema_version=24,status='SOURCE_ONLY_ADJACENT_PAGES_NOT_BLEEDTHROUGH_GOLD',
                focus_book=BOOK,focus_physical_page=FOCUS,adjacent_physical_pages=list(NEIGHBORS),
                original_pdf_sha256_private=row['sha256'],original_page_count=row['total_physical_pages'],
                focus_png_sha256_private=digest(focus),focus_dimensions=focal_size,
                same_frozen_v17_source=True,neighbors=mapped,
                adjacent_page_is_physical_verso_unverified=True,
                bleedthrough_alignment_verified=False,bleedthrough_classification='UNDETERMINED',
                reference_gold_approved=False,full_page_cer=None,cloud_calls=0,ocr_calls=0)
    blob=canonical(report)
    require(len(blob)<=MAX_RECEIPT,'RECEIPT_BUDGET_EXCEEDED')
    pngs[REPORT]=blob
    pngs[INDEX]=html
    require(len(pngs)==5,'PRIVATE_FILE_COUNT_INVALID')
    return folder,pngs,report

def execute(root,manifest,*,write=False,audit=False,**kwargs):
    require(write!=audit,'EXPLICIT_MODE_REQUIRED')
    folder,payloads,report=build(root,manifest,**kwargs)
    dest=folder/SUBDIR
    if audit:
        require(dest.is_dir() and not dest.is_symlink() and
                {p.name for p in dest.iterdir()}==set(payloads),'FROZEN_FILE_SET_CHANGED')
        for name,raw in payloads.items():
            require(checked_file(dest/name,MAX_IMAGE)==raw,'FROZEN_CONTENT_CHANGED')
    else:
        require(not dest.exists() and not dest.is_symlink(),'PRIVATE_SNAPSHOT_EXISTS')
        with tempfile.TemporaryDirectory(prefix='.b08-neighbor-v24-',dir=folder) as tmp:
            stage=Path(tmp)
            for name,raw in payloads.items():
                with (stage/name).open('xb') as f:f.write(raw)
            require(not dest.exists(),'PRIVATE_SNAPSHOT_RACE')
            os.rename(stage,dest)
    return report

def main():
    a=argparse.ArgumentParser()
    a.add_argument('--private-root',required=True)
    a.add_argument('--manifest',required=True)
    v=a.add_mutually_exclusive_group(required=True)
    v.add_argument('--write',action='store_true')
    v.add_argument('--audit-only',action='store_true')
    args=a.parse_args()
    try:
        manifest=json_safely(Path(args.manifest).read_bytes())
        r=execute(args.private_root,manifest,write=args.write,audit=args.audit_only)
        print('ACS_B08_V24='+('PRIVATE_CREATED' if args.write else 'PRIVATE_AUDIT_PASS'))
        print('ACS_B08_V24_SOURCE_PAGES='+str(1+len(r['neighbors'])))
        print('ACS_B08_V24_ADJACENT_PAGES=2')
        print('ACS_B08_V24_FROZEN_V17=UNCHANGED')
        print('ACS_B08_V24_BLEEDTHROUGH=UNDETERMINED')
        print('ACS_B08_V24_GOLD=UNVERIFIED')
        print('ACS_B08_V24_NEW_MODEL_CALLS=0')
    except Exception:
        # No exception payloads, full paths, private hashes or source text in public logs.
        print('ACS_B08_V24=REJECTED')
        return 2
    return 0

if __name__=='__main__':sys.exit(main())
