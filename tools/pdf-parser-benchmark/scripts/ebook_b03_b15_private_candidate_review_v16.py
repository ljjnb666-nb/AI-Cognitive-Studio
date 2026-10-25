#!/usr/bin/env python3
"""Private, non-interactive B03/B15 source-image vs GLM-candidate review packet.

Read original SHA-attested v13 tiles and saved v14/v15 candidates; no provider,
OCR, or gold approval. Model text appears only in offline private HTML.
Rebuild compares byte-identical output, without changing any frozen sources.
"""
import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import sys
import tempfile

import ebook_b03_b15_blind_visual_triage_v14 as prior
from ebook_private_glm_visual_reference import VisualGateError

VERSION=16
SUBDIR="b03_b15_candidate_source_review_v16"
INDEX="B03_B15_三份候选原图核验.private.html"
REPORT="b03_b15_candidate_review.v16.private.json"
EXACT_STATE={"completed":3,"unknown":1,"not_started":0}
COMPLETED=(("B03",67,"R1C2"),("B03",67,"R1C3"),("B15",109,"R3C2"))
UNKNOWN=("B03",67,"R2C2")
MAX_REPORT=16000
MAX_HTML=60000


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def strict_output(root):
    """Derive reproducible private artifacts from verified input, no writes."""
    folder,tiles=prior.source_contract(root)
    if prior.private_inventory(root)!=EXACT_STATE:
        raise VisualGateError("V16_EXPECTED_THREE_COMPLETE_ONE_UNKNOWN_CHANGED")
    source=folder/prior.SOURCE_DIR
    private=folder/prior.SUBDIR
    if private.is_symlink() or not private.is_dir():
        raise VisualGateError("V16_CANDIDATE_PRIVATE_FOLDER_UNSAFE")
    data=[]
    for book,page,region in prior.TARGETS:
        ident=f"{book}_p{page:04d}_{region}"
        j=private/(ident+".attempt.private.json")
        c=private/(ident+".candidate.private.json")
        image_name=f"{book}_p{page:04d}_{region}.private.png"
        if not (j.is_file() and not j.is_symlink()):
            raise VisualGateError("V16_ATTEMPT_FENCE_MISSING")
        attempt=prior.read_json(j,prior.MAX_RECORD)
        actual_sha=tiles[(book,page,region)][1]
        if (attempt.get("source_tile_sha256_private")!=actual_sha or
                attempt.get("state")!="REQUEST_INITIATED_NO_RETRY"):
            raise VisualGateError("V16_ATTEMPT_SOURCE_MISMATCH")
        row={"book_id":book,"physical_page":page,"region":region,
             "source_tile_sha256_private":actual_sha,
             "attempt_sha256_private":digest(j.read_bytes()),
             "private_image_name":image_name,
             "authority":"NO_INDEPENDENT_REFERENCE_NO_CER"}
        if (book,page,region)==UNKNOWN:
            if c.exists() or c.is_symlink():
                raise VisualGateError("V16_UNKNOWN_REQUEST_WAS_MUTATED")
            row.update({"state":"CHARGE_OUTCOME_UNKNOWN_NEVER_AUTO_RETRY",
                        "candidate_sha256_private":None,"character_count":None,
                        "uncertainty_count":None,"visual_flag_count":None})
        elif (book,page,region) in COMPLETED:
            if not c.is_file() or c.is_symlink():
                raise VisualGateError("V16_EXPECTED_CANDIDATE_MISSING")
            candidate=prior.read_json(c,prior.MAX_RECORD)
            if (candidate.get("schema_version")!=14 or
                    candidate.get("status")!=prior.AUTHORITY or
                    candidate.get("source_tile_sha256_private")!=actual_sha or
                    candidate.get("book_id")!=book or
                    candidate.get("physical_page")!=page or
                    candidate.get("region")!=region or
                    candidate.get("independent_gold_approved") is not False or
                    candidate.get("full_page_reference") is not False or
                    candidate.get("curve_correspondence_verified") is not False or
                    candidate.get("cer",object()) is not None):
                raise VisualGateError("V16_CANDIDATE_AUTHORITY_CHANGED")
            item=candidate.get("candidate")
            # Reuse the strict v14 schema, not a permissive HTML renderer.
            checked=prior.parse_response(json.dumps(item,ensure_ascii=False))
            if checked!=item:
                raise VisualGateError("V16_CANDIDATE_SCHEMA_CHANGED")
            row.update({"state":"MODEL_CANDIDATE_NOT_GOLD",
                        "candidate_sha256_private":digest(c.read_bytes()),
                        "character_count":len(item["transcription"]),
                        "uncertainty_count":len(item["uncertainties"]),
                        "visual_flag_count":len(item["visual_flags"]),
                        "has_observed_text":bool(item["transcription"].strip())})
            row["_model_candidate"]=item
        else:
            raise VisualGateError("V16_UNEXPECTED_REGION")
        data.append(row)
    if len(data)!=4 or {tuple(x[k] for k in ("book_id","physical_page","region"))
                        for x in data}!=set(prior.TARGETS):
        raise VisualGateError("V16_REGION_SET_CHANGED")
    receipt={
        "schema_version":VERSION,
        "evidence":"PRIVATE_SHA_BOUND_SOURCE_MODEL_CANDIDATE_TRIAGE_NO_GOLD",
        "v13_private_receipt_sha256":digest((source/prior.SOURCE_REPORT).read_bytes()),
        "v14_candidate_count":3,"v14_unknown_request_count":1,
        "new_model_calls":0,"independent_gold_approved":False,
        "full_page_coverage_verified":False,
        "reading_order_verified":False,"marker_to_curve_verified":False,
        "cer":None,
        "regions":[{k:v for k,v in row.items() if k!="_model_candidate"} for row in data],
    }
    report=prior.canonical(receipt)
    if len(report)>MAX_REPORT:
        raise VisualGateError("V16_PRIVATE_REPORT_SIZE_INVALID")
    html_data=render_html(data).encode("utf-8")
    if len(html_data)>MAX_HTML:
        raise VisualGateError("V16_PRIVATE_HTML_SIZE_INVALID")
    return folder,{REPORT:report,INDEX:html_data},receipt


def render_html(rows):
    """Render untrusted model strings HTML-escaped, with no scripts or uploads."""
    cards=[]
    for row in rows:
        book,page,region=(row[k] for k in ("book_id","physical_page","region"))
        label=html.escape(f"{book} · PDF物理页{page} · {region}")
        src=html.escape("../"+prior.SOURCE_DIR+"/"+row["private_image_name"],quote=True)
        if row["state"]=="MODEL_CANDIDATE_NOT_GOLD":
            model=row["_model_candidate"]
            text=html.escape(model["transcription"],quote=True)
            uncertain="".join("<li>"+html.escape(v,quote=True)+"</li>"
                               for v in model["uncertainties"])
            flags="".join("<li>"+html.escape(v,quote=True)+"</li>"
                          for v in model["visual_flags"])
            if not uncertain: uncertain="<li>模型未标记；不代表没有错误</li>"
            if not flags: flags="<li>模型未标记；不代表已通过审核</li>"
            message=("<h3>未经核准的模型视觉候选</h3>"
                     "<pre class='candidate'>"+text+"</pre>"
                     "<h4>模型标记的不确定性</h4><ul>"+uncertain+"</ul>"
                     "<h4>视觉观察备注</h4><ul>"+flags+"</ul>"
                     "<p class='warning'>必须对照左侧真实来源像素逐字审核；"
                     "模型未标错不等于正确，禁止用作独立金标准。</p>")
        else:
            message=("<h3>未生成模型候选</h3>"
                     "<p class='warning'>此前请求已有收费防重凭据，但结果未知。"
                     "不可自行清理凭据或自动重试，也不允许用 OCR 内容补作金标准。</p>")
        cards.append("<section><h2>"+label+"</h2><div class='compare'>"
                     "<div><img loading='lazy' alt='"+label+"' src='"+src+"'>"
                     "<p>来源：v13 高分辨率原图局部</p></div>"
                     "<div>"+message+"</div></div></section>")
    doc=("<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
         "<meta http-equiv='Content-Security-Policy' "
         "content=\"default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; "
         "script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'\">"
         "<meta name='viewport' content='width=device-width,initial-scale=1'>"
         "<title>B03/B15 私有来源-候选核验 v16</title>"
         "<style>body{font:16px/1.6 system-ui,'Microsoft YaHei',sans-serif;"
         "background:#f2f5fa;color:#182b42;margin:18px}section{background:white;"
         "margin:20px 0;padding:18px;border-radius:10px}.compare{display:grid;"
         "grid-template-columns:1fr 1fr;gap:18px}img{width:100%;height:auto;"
         "image-rendering:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;"
         "padding:14px;background:#f4f6fa;border-radius:6px}.warning{color:#a33c25}"
         "@media(max-width:900px){.compare{grid-template-columns:1fr}}</style>"
         "</head><body><h1>私有原图与模型候选核验 · 仅草稿</h1>"
         "<p>来源图像 + 已有候选文字，**不是**独立金标准；"
         "没有 OCR 输出参与盲识别，没有新的云端调用。"
         "3 个区域有候选，1 个历史请求结果未知；"
         "并非整页覆盖、阅读顺序或图表符号—曲线关联已验证。</p>"
         +"".join(cards)+"</body></html>")
    if "<script" in doc.lower() or "javascript:" in doc.lower():
        raise VisualGateError("V16_UNSAFE_HTML_CONSTRUCT")
    return doc


def execute(root,*,write=False,audit=False):
    if write==audit:
        raise VisualGateError("V16_EXPLICIT_WRITE_OR_AUDIT_REQUIRED")
    folder,outputs,receipt=strict_output(root)
    dest=folder/SUBDIR
    if audit:
        if (dest.is_symlink() or not dest.is_dir() or
                set(x.name for x in dest.iterdir())!=set(outputs)):
            raise VisualGateError("V16_REVIEW_PACKET_FILE_SET_CHANGED")
        for name,raw in outputs.items():
            p=dest/name
            if p.is_symlink() or not p.is_file() or p.read_bytes()!=raw:
                raise VisualGateError("V16_REVIEW_PACKET_TAMPERED")
    else:
        if dest.exists() or dest.is_symlink():
            raise VisualGateError("V16_REVIEW_PACKET_ALREADY_EXISTS")
        with tempfile.TemporaryDirectory(prefix=".review-v16-",dir=folder) as td:
            temp=Path(td)
            for name,raw in outputs.items():
                with (temp/name).open("xb") as stream:
                    stream.write(raw)
            if dest.exists() or dest.is_symlink():
                raise VisualGateError("V16_REVIEW_PACKET_ALREADY_EXISTS")
            os.rename(temp,dest)
    return receipt


def main(argv=None):
    ap=argparse.ArgumentParser()
    ap.add_argument("--private-root",required=True)
    mode=ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write",action="store_true")
    mode.add_argument("--audit-only",action="store_true")
    args=ap.parse_args(argv)
    try:
        result=execute(Path(args.private_root),write=args.write,
                       audit=args.audit_only)
        print("ACS_V16_REVIEW="+("PRIVATE_CREATED" if args.write else "PRIVATE_AUDIT_PASS"))
        print("ACS_V16_MODEL_CANDIDATES="+str(result["v14_candidate_count"]))
        print("ACS_V16_UNKNOWN_CHARGE_FENCES="+str(result["v14_unknown_request_count"]))
        print("ACS_V16_NEW_MODEL_CALLS=0")
        print("ACS_V16_GOLD=NOT_APPROVED")
    except Exception:
        print("ACS_V16_REVIEW=REJECTED")
        return 2
    return 0


if __name__=="__main__":
    sys.exit(main())
