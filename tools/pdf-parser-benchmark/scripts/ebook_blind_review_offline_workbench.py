#!/usr/bin/env python3
"""Source-only local Chinese review workbench for immutable B15/B03 images.

No OCR text and no external network. The only browser export is a local
DRAFT_UNVERIFIED transcription; NEVER an approved reference, gold or CER.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

from ebook_b15_b03_blind_source_review import (
    compute as audit_v9, _private_folder, safe_bytes, exclusive,
    SUBDIR, REPORT as V9,
)
from ebook_private_glm_visual_reference import VisualGateError

REPORT="blind_source_offline_review_workbench.v10.private.json"
HTML_NAME="原图核对工作台.private.html"
EVIDENCE="LOCAL_BLIND_SOURCE_ONLY_DRAFT_NOT_REFERENCE_OR_CER"
EXPECTED=(("B15",109,"R3C2"),("B03",67,"FULL"))
MAX_HTML=24000
MAX_REPORT=9500

_HTML=r'''<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<title>原图盲审工作台｜未核验草稿</title>
<style>
:root {color-scheme:light; font:15px/1.55 system-ui,"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1d2939}
*{box-sizing:border-box}body{margin:0}header{padding:17px 26px;background:#17253a;color:white;display:flex;justify-content:space-between;gap:15px;align-items:center;flex-wrap:wrap}
header strong{font-size:20px}.tag{border:1px solid #f0c36d;background:#fff8e4;color:#805200;border-radius:18px;padding:5px 11px;font-size:13px}
main{max-width:1580px;margin:auto;padding:20px;display:grid;grid-template-columns:minmax(390px,1.4fr) minmax(320px,0.8fr);gap:18px}
section{background:white;border:1px solid #e3e7eb;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px #1423380a}
section h2{font-size:17px;font-weight:650;margin:0;padding:14px 17px;border-bottom:1px solid #edf0f3}
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 15px;border-bottom:1px solid #e9ecf1}
button{font:inherit;cursor:pointer;border-radius:7px;border:1px solid #ced5de;background:#fff;padding:8px 12px;color:#24374d}
button[aria-pressed=true]{background:#173a65;color:white;border-color:#173a65}button.primary{color:white;background:#1a5b9b;border:0}
.viewport{height:min(70vh,760px);overflow:auto;background:#d8dce2;text-align:center;padding:20px}
.viewport img{display:block;max-width:none;margin:0 auto;image-rendering:auto;background:white;box-shadow:0 3px 16px #27354525}
.info{padding:10px 15px;color:#627084;font-size:13px;border-top:1px solid #e9ecf1}
form{padding:16px;display:flex;flex-direction:column;gap:13px}
label{display:flex;flex-direction:column;gap:5px;font-weight:600;font-size:14px}
textarea,select,input{font:inherit;border:1px solid #cfd7e0;padding:10px;border-radius:7px;color:#203043;background:#fff}
textarea{resize:vertical;min-height:155px}
.note{font-size:13px;color:#6b7887;padding:10px;border-radius:7px;background:#f4f6f8;line-height:1.75}
footer{padding:12px 22px;color:#647387;font-size:13px}
@media(max-width:900px){main{grid-template-columns:1fr;padding:10px}.viewport{height:50vh}}
</style></head><body>
<header><strong>原图盲审工作台</strong><span class="tag">仅原图 · 转录草稿未审核 · CER 未验证</span></header>
<main>
<section><h2>原始来源图片（不展示任何 OCR 候选）</h2>
<div class="toolbar"><button type="button" id="b15" aria-pressed="true">B15 · 第109页 · 下中局部</button>
<button type="button" id="b03" aria-pressed="false">B03 · 第67页 · 整页</button>
<label style="display:flex;flex-direction:row;align-items:center;gap:8px;font-weight:400">缩放 <input id="zoom" type="range" min="40" max="260" value="100" step="10"><output id="zoom-text">100%</output></label></div>
<div class="viewport"><img id="source-image" src="" alt="同源 PDF 原始渲染图片（不含 OCR 文字）"></div>
<div class="info" id="scope-description"></div></section>
<section><h2>视觉转录 · 本地未审核草稿</h2>
<form id="draft-form">
<div class="note">此页面只读取同目录原图；不发送请求、不自动识别、不调用模型、不保存任何服务器数据。切换图片前请导出当前草稿，页面关闭即清空填写内容。</div>
<label>区域类型<select id="category"><option value="UNCLASSIFIED">未分类</option><option value="PRINTED_TEXT">印刷文字</option><option value="FIGURE_LABEL">图片／图表标注</option><option value="TABLE">表格</option><option value="FORMULA">公式</option><option value="MIXED">混合</option><option value="UNREADABLE">无法确定</option></select></label>
<label>根据原图目视转录（可留空）<textarea id="transcript" placeholder="只看原图填写；不得复制 OCR 候选输出"></textarea></label>
<label>不确定之处、阅读顺序及检查说明<textarea id="uncertainties" rows="4" placeholder="记录模糊字形、裁切边界、图表文字等"></textarea></label>
<button type="button" class="primary" id="export">导出本地“未核验”JSON 草稿</button>
<div class="note" id="status" role="status">这不是独立参考文本准入表；此页面没有“审核通过”或“计算 CER”操作。</div>
</form></section></main>
<footer>隐私边界：原书、原图、任何转录草稿均留在本机；公开 CI 仅验证本地工作台及来源一致性。真实审核需另行证明。</footer>
<script>
"use strict";
const SOURCES=__SOURCES__;
let selected=0;
const el=id=>document.getElementById(id);
function display(){
 const x=SOURCES[selected], zoom=Number(el("zoom").value);
 el("source-image").src=x.relative_image_name;
 el("source-image").style.width=String(zoom)+"%";
 el("scope-description").textContent=x.book_id+" · 物理第"+x.physical_page+"页 · "+(x.scope==="FULL"?"整页源图":"下方中央原图裁片")+" · 来源已冻结，审核尚未开始";
 el("b15").setAttribute("aria-pressed",String(selected===0));
 el("b03").setAttribute("aria-pressed",String(selected===1));
 el("zoom-text").textContent=zoom+"%";
}
for(const [id,index] of [["b15",0],["b03",1]]){
 el(id).addEventListener("click",()=>{selected=index;el("transcript").value="";el("uncertainties").value="";el("category").value="UNCLASSIFIED";display();});
}
el("zoom").addEventListener("input",display);
el("export").addEventListener("click",()=>{
 const x=SOURCES[selected];
 const draft={schema_version:10,status:"DRAFT_UNVERIFIED",book_id:x.book_id,
 physical_page:x.physical_page,scope:x.scope,
 original_image_sha256_private:x.source_image_sha256_private,
 displayed_image_sha256_private:x.cropped_image_sha256_private,
 region_category:el("category").value,
 unverified_visual_transcription_draft:el("transcript").value,
 uncertainty_notes:el("uncertainties").value,
 reviewer_approval:null,independent_reference_verified:false,cer:null,
 note:"This local export is an unverified candidate, not an independent OCR reference."};
 const json=JSON.stringify(draft,null,2)+"\n";
 const url=URL.createObjectURL(new Blob([json],{type:"application/json"}));
 const link=document.createElement("a");link.href=url;
 link.download=x.book_id+"_p"+x.physical_page+"_"+x.scope+"_DRAFT_UNVERIFIED.json";
 document.body.appendChild(link);link.click();link.remove();
 URL.revokeObjectURL(url);
 el("status").textContent="已请求保存本地草稿；仍为未核验状态，不生成 CER 或审核批准。";
});
display();
</script></body></html>
'''


def make_html(pages):
    if (not isinstance(pages,list) or len(pages)!=2 or
            [(x.get("book_id"),x.get("physical_page"),x.get("scope"))
                for x in pages]!=list(EXPECTED)):
        raise VisualGateError("BLIND_WORKBENCH_PAGE_LIST_INVALID")
    entries=[]
    for item in pages:
        image=f'{item["book_id"]}_p{item["physical_page"]:04d}_{item["scope"]}.source.private.png'
        if any(not isinstance(item.get(k),str) or len(item[k])!=64
                or not all(c in "0123456789abcdef" for c in item[k])
                for k in ("source_image_sha256_private","cropped_image_sha256_private")):
            raise VisualGateError("BLIND_WORKBENCH_SHA_INVALID")
        entries.append(dict(book_id=item["book_id"],physical_page=item["physical_page"],
                            scope=item["scope"],relative_image_name=image,
                            source_image_sha256_private=item["source_image_sha256_private"],
                            cropped_image_sha256_private=item["cropped_image_sha256_private"]))
    payload=json.dumps(entries,ensure_ascii=False,separators=(",",":")).replace("<","\\u003c")
    return _HTML.replace("__SOURCES__",payload).encode("utf-8")


def run(root,manifest,*,write=False,audit=False,upstream_fn=audit_v9):
    if write==audit:
        raise VisualGateError("BLIND_WORKBENCH_MODE_REQUIRED")
    root=Path(root)
    upstream=upstream_fn(root,manifest,audit=True)
    if (upstream.get("image_count")!=2 or
            upstream.get("reviewed_reference_count")!=0 or
            upstream.get("independent_reference_created") is not False or
            upstream.get("cer",object()) is not None):
        raise VisualGateError("BLIND_WORKBENCH_NOT_UNREVIEWED_SOURCE")
    folder=_private_folder(root)
    subdir=folder/SUBDIR
    if subdir.is_symlink() or not subdir.is_dir():
        raise VisualGateError("BLIND_WORKBENCH_PRIVATE_DIR_UNSAFE")
    pages=upstream.get("pages")
    html=make_html(pages)
    if len(html)>MAX_HTML:
        raise VisualGateError("BLIND_WORKBENCH_HTML_TOO_LARGE")
    for item in pages:
        stem=f'{item["book_id"]}_p{item["physical_page"]:04d}_{item["scope"]}'
        image=subdir/(stem+".source.private.png")
        form=subdir/(stem+".blank.private.json")
        if hashlib.sha256(safe_bytes(image,45_000_000)).hexdigest()!=item["cropped_image_sha256_private"]:
            raise VisualGateError("BLIND_WORKBENCH_IMAGE_HASH_CHANGED")
        if hashlib.sha256(safe_bytes(form,4000)).hexdigest()!=item["blank_form_sha256_private"]:
            raise VisualGateError("BLIND_WORKBENCH_FORM_HASH_CHANGED")
    receipt=folder/REPORT
    target=subdir/HTML_NAME
    record={
        "schema_version":10,"evidence":EVIDENCE,
        "v9_private_receipt_sha256":hashlib.sha256(safe_bytes(folder/V9,16000)).hexdigest(),
        "workbench_html_sha256_private":hashlib.sha256(html).hexdigest(),
        "pages":[{"book_id":p["book_id"],"physical_page":p["physical_page"],
                  "scope":p["scope"],"image_sha256_private":p["cropped_image_sha256_private"]}
                 for p in pages],
        "offline_source_only":True,"review_draft_export_only":True,
        "independent_reference_created":False,"independent_review_count":0,
        "reviewer_approval":None,"cer":None,
        "model_calls":0,"external_network_calls":0,
    }
    raw=(json.dumps(record,ensure_ascii=False,sort_keys=True,
                    separators=(",",":"))+"\n").encode("utf-8")
    if len(raw)>MAX_REPORT:
        raise VisualGateError("BLIND_WORKBENCH_REPORT_LIMIT")
    if write:
        if any(p.exists() or p.is_symlink() for p in (target,receipt)):
            raise VisualGateError("BLIND_WORKBENCH_ALREADY_CREATED")
        exclusive(target,html)
        exclusive(receipt,raw)
    else:
        if safe_bytes(target,MAX_HTML)!=html or safe_bytes(receipt,MAX_REPORT)!=raw:
            raise VisualGateError("BLIND_WORKBENCH_FROZEN_TAMPERED")
    return record


def main():
    cli=argparse.ArgumentParser()
    cli.add_argument("--private-root",required=True)
    cli.add_argument("--manifest",required=True)
    mode=cli.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write",action="store_true")
    mode.add_argument("--audit-only",action="store_true")
    args=cli.parse_args()
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    rec=run(Path(args.private_root),manifest,write=args.write,audit=args.audit_only)
    print("ACS_REVIEW_WORKBENCH_STATUS="+("PRIVATE_CREATED" if args.write else "PRIVATE_VERIFIED"))
    print("ACS_REVIEW_WORKBENCH_SOURCE_IMAGES="+str(len(rec["pages"])))
    print("ACS_REVIEW_WORKBENCH_REFERENCE_COUNT=0")
    print("ACS_REVIEW_WORKBENCH_APPROVAL=NONE")
    print("ACS_REVIEW_WORKBENCH_CER=UNVERIFIED")
    print("ACS_REVIEW_WORKBENCH_NETWORK_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,UnicodeError,TypeError,OSError,RuntimeError):
        print("ACS_REVIEW_WORKBENCH_REJECTED=PRIVATE_SOURCE_OR_SAFETY_GATE")
        sys.exit(2)
