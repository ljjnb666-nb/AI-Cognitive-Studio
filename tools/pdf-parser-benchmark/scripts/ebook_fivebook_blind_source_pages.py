#!/usr/bin/env python3
"""Offline source-only reviewer packet for the *five* existing PDF OCR-focus pages.

No OCR strings, human approval, pseudo-gold, CER, model inference, network
calls, or production routing changes. Original pixels and full SHA stay in
the user's private Windows D: benchmark directory.
"""
import argparse
from io import BytesIO
import hashlib
import json
import os
from pathlib import Path
import sys

from ebook_multibook_native_matrix import audit_existing as audit_native, _private_folder, MAX_PNG
from ebook_private_glm_visual_reference import VisualGateError
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant

TARGETS=(("B03",67),("B08",64),("B15",109),("B29",72),("B31",126))
SUBDIR="fivebook_blind_original_pages_v12"
REPORT="fivebook_blind_source_review.v12.private.json"
INDEX="五书原图独立核对.private.html"
SCHEMA=12
MAX_REPORT=12000
MAX_HTML=24000
NO_GOLD="SOURCE_ONLY_FIVEBOOK_PRIVATE_PACKET_NOT_APPROVED"

HTML_TEMPLATE=r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'">
<title>五书原图独立核对｜仅私有草稿</title>
<style>
:root{font:15px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#1e293b;background:#f3f5f8}
body{margin:0}header{background:#152b4b;color:white;padding:15px 22px}
main{padding:15px;display:grid;grid-template-columns:minmax(330px,1.4fr) minmax(300px,.8fr);gap:14px}
section{background:white;border:1px solid #d8e0e8;border-radius:9px;padding:15px}
#viewport{height:68vh;overflow:auto;background:#e4e7eb;padding:12px;text-align:center}
#page{width:100%;max-width:none;display:block;margin:auto}
button,select,textarea,input{font:inherit;padding:8px}
textarea{width:100%;box-sizing:border-box;min-height:160px}
label{display:block;margin:9px 0}
.small{color:#5f6b7d;font-size:13px}button{cursor:pointer}
@media(max-width:850px){main{grid-template-columns:1fr}#viewport{height:44vh}}
</style></head><body>
<header><strong>五书同源原图盲审｜仅离线私有草稿</strong>
<span> · 独立金标准尚未核准 · CER 不计算</span></header>
<main><section>
<label>物理页 <select id="pick"></select></label>
<label>图像缩放 <input id="scale" type="range" min="60" max="260" value="100" step="10">
<output id="scaleout">100%</output></label>
<div id="viewport"><img id="page" alt="来源 PNG，无 OCR 识别候选"></div>
<p class="small" id="sourceinfo"></p></section><section>
<p><strong>来源逐字复核草稿</strong></p>
<p class="small">先看原图，不展示任何 OCR 输出。无法辨认的字符必须记录为未决；不得凭猜测填写已核准参考。</p>
<label>内容类型<select id="kind">
<option value="BODY">正文</option><option value="SIDEBAR">侧栏/竖排</option>
<option value="FIGURE">图表</option><option value="FORMULA">公式</option>
<option value="MIXED">混合</option><option value="UNREADABLE">无法辨认</option>
</select></label>
<p class="small">完整页九宫格核对状态（仅为草稿记录，不代表独立审批）。请逐格放大检查，不能看清时选择“未辨认”，不能标记“已核对”。</p>
<div id="coveragegrid"></div>
<label>仅根据原图独立转录整页文字<textarea id="text" placeholder="视觉转录草稿，不是 OCR"></textarea></label>
<label>未决文字、完整页覆盖和阅读顺序<textarea id="uncertain" placeholder="记录模糊字、未看过的区域、图表不确定性"></textarea></label>
<button id="export" type="button">导出私有未审核草稿 JSON</button>
<p class="small" id="feedback">无自动保存、无服务器上传、无批准按钮；草稿只能供另一次独立来源审核。</p>
</section></main>
<script>"use strict";
const PAGES=__PAGES__;
const $=id=>document.getElementById(id);
for(let i=0;i<PAGES.length;i++){
 const x=PAGES[i],o=document.createElement("option");
 o.value=String(i);o.textContent=x.book_id+" · 第 "+x.physical_page+" 物理页";$("pick").append(o);
}
const REGION_IDS=["R1C1","R1C2","R1C3","R2C1","R2C2","R2C3","R3C1","R3C2","R3C3"];
for(const code of REGION_IDS){
 const label=document.createElement("label");label.textContent=code+" ";
 label.style.display="inline-block";label.style.margin="3px";
 const sel=document.createElement("select");sel.dataset.region=code;
 for(const [value,name] of [["UNREVIEWED","未核对"],["VISUAL_DRAFT_REVIEWED","仅目视草稿"],["UNRESOLVED","字迹未辨"]]){
  const opt=document.createElement("option");opt.value=value;opt.textContent=name;sel.append(opt);
 }
 label.append(sel);$("coveragegrid").append(label);
}
function resetDraft(){
 $("text").value="";$("uncertain").value="";$("kind").value="BODY";
 for(const sel of $("coveragegrid").querySelectorAll("select"))sel.value="UNREVIEWED";
}
function show(){
 const x=PAGES[Number($("pick").value)],scale=Number($("scale").value);
 $("page").src=x.private_png_name;
 $("page").style.width=String(scale)+"%";
 $("scaleout").textContent=String(scale)+"%";
 $("sourceinfo").textContent=x.book_id+" · PDF 物理页 "+x.physical_page+" · 仅原始渲染 PNG，不含 OCR 候选";
}
$("pick").addEventListener("change",()=>{
 resetDraft();show();
});
$("scale").addEventListener("input",show);
$("export").addEventListener("click",()=>{
 const x=PAGES[Number($("pick").value)];
 const record={schema_version:12,status:"DRAFT_UNVERIFIED",book_id:x.book_id,
  physical_page:x.physical_page,scope:"COMPLETE_SOURCE_PAGE_DRAFT",
  source_png_sha256_private:x.source_png_sha256_private,
  visual_transcription_draft:$("text").value,content_type:$("kind").value,
  unresolved_regions:$("uncertain").value,
  nine_grid_review_draft:REGION_IDS.map(region=>{
   const input=Array.from($("coveragegrid").querySelectorAll("select")).find(e=>e.dataset.region===region);
   return {region_id:region,review_draft_state:input.value};
  }),
  sidebars_and_vertical_text_reviewed:false,
  all_visible_text_and_punctuation_transcribed:false,
  page_reading_order_reviewed:false,
  reviewer_approval:null,independent_gold_available:false,
  full_page_coverage_verified:false,cer:null};
 const u=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)+"\n"],{type:"application/json"}));
 const a=document.createElement("a");a.href=u;a.download=x.book_id+"_p"+x.physical_page+"_SOURCE_ONLY_DRAFT.json";
 document.body.append(a);a.click();a.remove();URL.revokeObjectURL(u);
 $("feedback").textContent="仅请求下载未核准草稿；不会写入已冻结金标准。";
});
$("pick").value="0";show();
</script></body></html>"""

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def canonical(obj):
    return (json.dumps(obj,ensure_ascii=False,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")

def private_bytes(path,limit):
    if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=limit:
        raise VisualGateError("FIVEBOOK_BLIND_SOURCE_MISSING_OR_UNSAFE")
    return path.read_bytes()

def validate_image(blob,width,height):
    from PIL import Image,ImageFile
    Image.MAX_IMAGE_PIXELS=4_000_000
    ImageFile.LOAD_TRUNCATED_IMAGES=False
    try:
        with Image.open(BytesIO(blob)) as im:
            im.load()
            if im.format!="PNG" or im.size!=(width,height) or im.mode not in ("RGB","RGBA","L"):
                raise VisualGateError("FIVEBOOK_BLIND_IMAGE_INVALID")
    except VisualGateError:
        raise
    except (OSError,ValueError,MemoryError):
        raise VisualGateError("FIVEBOOK_BLIND_IMAGE_INVALID") from None

def source_pages(root,manifest,*,native_fn=audit_native):
    folder=_private_folder(root)
    native=native_fn(root,manifest)
    if native.get("selected_native_pages")!=24 or native.get("ocr_focus_image_count")!=5:
        raise VisualGateError("FIVEBOOK_BLIND_NATIVE_SOURCE_NOT_READY")
    corpus=native.get("corpus_id")
    manifest_items={x.get("id"):x for x in manifest.get("sources",[]) if isinstance(x,dict)}
    rows={x.get("book_id"):x for x in native.get("rows",[]) if isinstance(x,dict)}
    if len(rows)!=6 or len(manifest_items)<6:
        raise VisualGateError("FIVEBOOK_BLIND_SOURCE_SET_CHANGED")
    result=[]
    for book,page in TARGETS:
        row=rows.get(book)
        manifest_row=manifest_items.get(book)
        if (not isinstance(row,dict) or not isinstance(manifest_row,dict) or
            row.get("source_document_sha256")!=manifest_row.get("sha256") or
            page not in manifest_row.get("ocr_physical_pages",[])):
            raise VisualGateError("FIVEBOOK_BLIND_PDF_PAGE_IDENTITY_CHANGED")
        pages=[p for p in row.get("pages",[]) if p.get("physical_page")==page]
        if len(pages)!=1:
            raise VisualGateError("FIVEBOOK_BLIND_FOCUS_PAGE_CHANGED")
        info=pages[0]
        name=f"{book}_p{page:04d}.private.png"
        if info.get("ocr_focus_png")!=name:
            raise VisualGateError("FIVEBOOK_BLIND_PNG_IDENTITY_CHANGED")
        png=private_bytes(folder/name,MAX_PNG)
        if sha(png)!=info.get("ocr_focus_png_sha256"):
            raise VisualGateError("FIVEBOOK_BLIND_SOURCE_SHA_MISMATCH")
        width,height=info.get("ocr_focus_width"),info.get("ocr_focus_height")
        if any(type(v) is not int or v<60 or v>3000 for v in (width,height)) or width*height>4_000_000:
            raise VisualGateError("FIVEBOOK_BLIND_DIMENSIONS_CHANGED")
        validate_image(png,width,height)
        result.append(dict(book_id=book,physical_page=page,
            original_pdf_sha256_private=row["source_document_sha256"],
            source_png_sha256_private=sha(png),private_png_name=name,
            width=width,height=height,bytes=png))
    return folder,corpus,result

def form(row):
    return dict(schema_version=SCHEMA,book_id=row["book_id"],physical_page=row["physical_page"],
        original_pdf_sha256_private=row["original_pdf_sha256_private"],
        source_png_sha256_private=row["source_png_sha256_private"],
        status="SOURCE_ONLY_UNREVIEWED",reference_scope="COMPLETE_PAGE_NOT_ATTESTED",
        visual_transcription_draft=None,reviewer_approval=None,
        all_nine_grid_regions_reviewed=False,sidebars_reviewed=False,
        no_unresolved_text=False,independent_gold_available=False,cer=None)

def make_html(rows):
    payload=[dict(book_id=x["book_id"],physical_page=x["physical_page"],
        private_png_name=x["private_png_name"],
        source_png_sha256_private=x["source_png_sha256_private"]) for x in rows]
    html=HTML_TEMPLATE.replace("__PAGES__",json.dumps(payload,ensure_ascii=False,
        separators=(",",":")).replace("<","\\u003c")).encode("utf-8")
    if len(html)>MAX_HTML:
        raise VisualGateError("FIVEBOOK_BLIND_HTML_TOO_LARGE")
    return html

def exclusive(path,data):
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
    if hasattr(os,"O_NOFOLLOW"):flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as f:f.write(data)

def run(root,manifest,*,write=False,audit=False,native_fn=audit_native):
    if write==audit:
        raise VisualGateError("FIVEBOOK_BLIND_EXPLICIT_MODE_REQUIRED")
    folder,corpus,rows=source_pages(root,manifest,native_fn=native_fn)
    out=folder/SUBDIR
    if out.is_symlink() or (out.exists() and not out.is_dir()):
        raise VisualGateError("FIVEBOOK_BLIND_OUTPUT_FOLDER_UNSAFE")
    html=make_html(rows)
    report=dict(schema_version=SCHEMA,status=NO_GOLD,corpus_id=corpus,
        focus_source_page_count=5,source_sha_pinned=True,source_only=True,
        original_pdf_image_reviewed_by_independent_reviewer=False,
        reviewer_approvals=0,reference_text_created=False,cer=None,
        filenames=[x["private_png_name"] for x in rows],
        sha_of_private_html=sha(html))
    payloads=[(out/x["private_png_name"],x["bytes"]) for x in rows]
    payloads += [(out/(x["book_id"]+f'_p{x["physical_page"]:04d}.unreviewed.private.json'),
                 canonical(form(x))) for x in rows]
    payloads += [(out/INDEX,html),(out/REPORT,canonical(report))]
    if write:
        if any(path.exists() or path.is_symlink() for path,_ in payloads):
            raise VisualGateError("FIVEBOOK_BLIND_ALREADY_EXISTS_NO_OVERWRITE")
        if not out.exists():out.mkdir(mode=0o700)
        for path,data in payloads:exclusive(path,data)
    else:
        for path,data in payloads:
            if private_bytes(path,MAX_PNG if path.suffix==".png" else MAX_HTML)!=data:
                raise VisualGateError("FIVEBOOK_BLIND_FROZEN_OUTPUT_CHANGED")
    return report

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
        report=run(args.private_root,manifest,write=args.write,audit=args.audit_only)
        print("ACS_FIVEBOOK_BLIND_V11="+("PRIVATE_CREATED" if args.write else "PRIVATE_VERIFIED"))
        print("ACS_FIVEBOOK_BLIND_V11_SOURCE_IMAGES=5")
        print("ACS_FIVEBOOK_BLIND_V11_INDEPENDENT_APPROVALS=0")
        print("ACS_FIVEBOOK_BLIND_V11_GOLD=UNVERIFIED")
        print("ACS_FIVEBOOK_BLIND_V11_NEW_OCR_OR_CLOUD_CALLS=0")
    except Exception:
        # No exception text: upstream may mention copyrighted pages or private paths.
        print("ACS_FIVEBOOK_BLIND_V11=REJECTED")
        return 2
    return 0

if __name__=="__main__":
    sys.exit(main())
