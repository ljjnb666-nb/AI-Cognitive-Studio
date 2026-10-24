#!/usr/bin/env python3
"""Real MS Edge HEADLESS browser acceptance of private source-only workbench.

No downloads, installs, cloud, OCR or approval. All source pixels, HTML,
test transcription, and Edge stdout/stderr stay on the private D: drive.
The ONLY public stdout is anonymous PASS / BLOCKED and test-boolean counts.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from ebook_blind_review_offline_workbench import (
    run as audit_workbench, _private_folder, safe_bytes,
    HTML_NAME, SUBDIR, REPORT as V10,
)
from ebook_private_glm_visual_reference import VisualGateError

EVIDENCE="REAL_MS_EDGE_HEADLESS_BLIND_IMAGE_INTERACTION_NOT_OCR_GOLD"
MAX_IMAGE=45_000_000
MAX_HTML=24_000
MAX_STDOUT=2_000_000
MAX_STDERR=120_000
EDGE_TIMEOUT=65

# This is a temporary test-only injection into an ephemeral COPY, never the
# source-only frozen v10 workbench. It does not inject OCR candidate strings.
SMOKE=r"""
<script>
"use strict";
(async()=>{
 const get=id=>document.getElementById(id);
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const img=get("source-image");
 const waitImage=async()=>{
   for(let i=0;i<100;i++){
     if(img.complete&&img.naturalWidth>0&&img.naturalHeight>0) return true;
     await pause(65);
   }
   return false;
 };
 try {
   const initial=await waitImage();
   const initialName=img.getAttribute("src")||"";
   get("zoom").value="170";
   get("zoom").dispatchEvent(new Event("input",{bubbles:true}));
   const zoom=get("zoom-text").textContent==="170%"&&img.style.width==="170%";
   get("b03").click();
   const b03Image=await waitImage();
   const secondName=img.getAttribute("src")||"";
   const switchB03=b03Image&&secondName.includes("B03_p0067_FULL.source.private.png")&&
     get("b03").getAttribute("aria-pressed")==="true";
   get("category").value="FIGURE_LABEL";
   get("transcript").value="PRIVATE_TEST_VISUAL_DRAFT_NEVER_PRINT";
   get("uncertainties").value="PRIVATE_TEST_NOTE_NEVER_PRINT";
   let capturedBlob=null;
   const orig=URL.createObjectURL.bind(URL);
   URL.createObjectURL=(blob)=>{capturedBlob=blob;return orig(blob)};
   // Test-only interception: exercise the real export code and inspect the
   // generated Blob, but never allow the test token to land in Downloads
   // outside our D: private, disposable browser profile.
   const originalAnchorClick=HTMLAnchorElement.prototype.click;
   HTMLAnchorElement.prototype.click=function(){
     if(this.download&&this.download.endsWith("_DRAFT_UNVERIFIED.json"))return;
     return originalAnchorClick.call(this);
   };
   get("export").click();
   let exported=false;
   if(capturedBlob){
     const draft=JSON.parse(await capturedBlob.text());
     exported=draft.status==="DRAFT_UNVERIFIED"&&
       draft.book_id==="B03"&&draft.physical_page===67&&draft.scope==="FULL"&&
       draft.region_category==="FIGURE_LABEL"&&
       draft.unverified_visual_transcription_draft==="PRIVATE_TEST_VISUAL_DRAFT_NEVER_PRINT"&&
       draft.uncertainty_notes==="PRIVATE_TEST_NOTE_NEVER_PRINT"&&
       draft.reviewer_approval===null&&
       draft.independent_reference_verified===false&&draft.cer===null;
   }
   get("b15").click();
   const b15Image=await waitImage();
   const switchBack=b15Image&&
     (img.getAttribute("src")||"").includes("B15_p0109_R3C2.source.private.png")&&
     get("b15").getAttribute("aria-pressed")==="true"&&
     get("transcript").value===""&&get("uncertainties").value==="";
   const sourceInitial=initial&&initialName.includes("B15_p0109_R3C2.source.private.png");
   document.documentElement.setAttribute("data-acs-edge-real",
     [sourceInitial,zoom,switchB03,exported,switchBack].every(Boolean)?"PASS":"FAIL");
   document.documentElement.setAttribute("data-acs-edge-tests",
     String([sourceInitial,zoom,switchB03,exported,switchBack].filter(Boolean).length));
 } catch(_err){
   document.documentElement.setAttribute("data-acs-edge-real","FAIL");
   document.documentElement.setAttribute("data-acs-edge-tests","0");
 }
})();
</script>"""


def select_edge():
    candidates=[]
    for key in ("ProgramFiles(x86)","ProgramFiles"):
        if os.environ.get(key):
            candidates.append(Path(os.environ[key])/"Microsoft"/"Edge"/"Application"/"msedge.exe")
    candidates.extend([
        Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
        Path("C:/Program Files/Microsoft/Edge/Application/msedge.exe"),
    ])
    valid=[]
    for path in candidates:
        if (path.is_file() and not path.is_symlink()
                and path.resolve() not in valid):
            valid.append(path.resolve())
    if not valid:
        raise VisualGateError("EDGE_SMOKE_REAL_MS_EDGE_NOT_INSTALLED")
    return valid[0]


def make_test_html(frozen_html):
    # A new temporary browser fixture is intentionally distinct from the
    # freeze-protected original HTML. No OCR text is ever embedded.
    try:
        s=frozen_html.decode("utf-8")
    except UnicodeError:
        raise VisualGateError("EDGE_SMOKE_SOURCE_HTML_UTF8_INVALID") from None
    if (s.count("</body>")!=1 or
            "DRAFT_UNVERIFIED" not in s or
            "connect-src 'none'" not in s or
            "原图盲审工作台" not in s):
        raise VisualGateError("EDGE_SMOKE_SOURCE_HTML_CONTRACT_INVALID")
    return s.replace("</body>",SMOKE+"</body>").encode("utf-8")


def test_viewer(root,manifest,*,edge_fn=select_edge,runner=subprocess.run,
                audit_fn=audit_workbench):
    root=Path(root)
    prior=audit_fn(root,manifest,audit=True)
    if (prior.get("independent_reference_created") is not False
            or prior.get("independent_review_count")!=0
            or prior.get("review_draft_export_only") is not True
            or prior.get("external_network_calls")!=0
            or prior.get("cer",object()) is not None
            or len(prior.get("pages",[]))!=2):
        raise VisualGateError("EDGE_SMOKE_NOT_A_BLIND_SOURCE")
    folder=_private_folder(root)
    private=folder/SUBDIR
    if private.is_symlink() or not private.is_dir():
        raise VisualGateError("EDGE_SMOKE_PRIVATE_DIR_INVALID")
    original=safe_bytes(private/HTML_NAME,MAX_HTML)
    if hashlib.sha256(original).hexdigest()!=prior.get("workbench_html_sha256_private"):
        raise VisualGateError("EDGE_SMOKE_HTML_SHA_CHANGED")
    fixture=make_test_html(original)
    engine=Path(edge_fn())
    if engine.name.lower()!="msedge.exe" or engine.is_symlink() or not engine.is_file():
        raise VisualGateError("EDGE_SMOKE_WRONG_BROWSER")
    with tempfile.TemporaryDirectory(prefix=".edge-smoke-private-",dir=private) as temp:
        tempdir=Path(temp)
        target=tempdir/"smoke.html"
        target.write_bytes(fixture)
        for item in prior["pages"]:
            stem=f'{item["book_id"]}_p{item["physical_page"]:04d}_{item["scope"]}'
            source=private/(stem+".source.private.png")
            blob=safe_bytes(source,MAX_IMAGE)
            if hashlib.sha256(blob).hexdigest()!=item.get("image_sha256_private"):
                raise VisualGateError("EDGE_SMOKE_ORIGINAL_PNG_SHA_CHANGED")
            (tempdir/source.name).write_bytes(blob)
        profile=tempdir/"edge-profile"
        args=[
            str(engine),"--headless=new","--disable-gpu","--no-first-run",
            "--no-default-browser-check","--disable-background-networking",
            "--disable-component-update","--disable-sync",
            "--disable-extensions","--disable-features=Translate",
            "--proxy-server=http://127.0.0.1:1",
            "--user-data-dir="+str(profile),
            "--virtual-time-budget=15000",
            "--dump-dom",target.as_uri(),
        ]
        env=os.environ.copy()
        env.update({
            "HTTP_PROXY":"http://127.0.0.1:1",
            "HTTPS_PROXY":"http://127.0.0.1:1",
            "ALL_PROXY":"http://127.0.0.1:1",
            "NO_PROXY":"",
        })
        try:
            done=runner(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                        timeout=EDGE_TIMEOUT,check=False)
        except subprocess.TimeoutExpired:
            raise VisualGateError("EDGE_SMOKE_BROWSER_TIMEOUT") from None
        if (done.returncode!=0 or len(done.stdout or b"")>MAX_STDOUT or
                len(done.stderr or b"")>MAX_STDERR):
            raise VisualGateError("EDGE_SMOKE_PRIVATE_BROWSER_EXEC_FAILED")
        # DO NOT print, persist, or upload dumped DOM: it contains private SHA
        # and test-only draft text. Only recognize strict boolean verdicts.
        dom=(done.stdout or b"").decode("utf-8",errors="replace")
        m=re.search(r'\bdata-acs-edge-real="(PASS|FAIL)"',dom)
        t=re.search(r'\bdata-acs-edge-tests="([0-5])"',dom)
        if not m or not t or m.group(1)!="PASS" or t.group(1)!="5":
            raise VisualGateError("EDGE_SMOKE_BROWSER_INTERACTION_FAILED")
    return {
        "evidence":EVIDENCE,"real_edge_binary_used":True,
        "private_source_images_displayed":2,"browser_interactions_passed":5,
        "local_unverified_export_content_verified":True,
        "no_ocr_or_network_calls_in_app":True,
        "browser_network_packets_measured":False,
        "not_a_gold_reference":True,"cer":None,
    }


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--private-root",required=True)
    p.add_argument("--manifest",required=True)
    a=p.parse_args()
    manifest=json.loads(Path(a.manifest).read_text(encoding="utf-8"))
    data=test_viewer(Path(a.private_root),manifest)
    print("ACS_EDGE_SMOKE_REAL_BROWSER=PASS")
    print("ACS_EDGE_SMOKE_INTERACTIONS="+str(data["browser_interactions_passed"]))
    print("ACS_EDGE_SMOKE_IMAGES="+str(data["private_source_images_displayed"]))
    print("ACS_EDGE_SMOKE_DRAFT=UNVERIFIED")
    print("ACS_EDGE_SMOKE_CER=UNVERIFIED")


if __name__=="__main__":
    try:
        main()
    except VisualGateError as error:
        # Only a fixed enum is allowed in public CI: no private paths, model
        # errors, OCR strings, DOM content or browser process diagnostics.
        code=str(error)
        if not re.fullmatch(r"EDGE_SMOKE_[A-Z0-9_]{3,90}",code):
            code="EDGE_SMOKE_UNCLASSIFIED_PRIVATE_REJECTION"
        print("ACS_EDGE_SMOKE_REJECTED="+code)
        sys.exit(2)
    except (ValueError,TypeError,OSError,UnicodeError,RuntimeError):
        print("ACS_EDGE_SMOKE_REJECTED=EDGE_SMOKE_PRIVATE_OR_IO_EXCEPTION")
        sys.exit(2)
