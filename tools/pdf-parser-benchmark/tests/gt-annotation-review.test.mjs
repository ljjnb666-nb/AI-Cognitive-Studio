import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createDraft, makeEmptyBlock, buildGroundTruth } from "../annotation/workspace.mjs";
import {
  parseBookSelection, bookLabel, pdfPreviewEligibility,
  parseNormalizedCandidate, sealBlindDraft, requireSealedComparison, comparePage,
  MAX_CANDIDATE_BYTES,
} from "../annotation/review.mjs";
import { startAnnotationServer } from "../annotation/server.mjs";

const source = id => ({ id, format:"pdf", sha256:"a".repeat(64), bytes:8192, pages:450,
  archive_member:"bookcase/" + id + "-原书.pdf" });
const selection = () => ({schema_version:"acs-real-book-fixtures-v1",selection:[
  source("RB-PDF-01"),source("RB-PDF-02"),source("RB-PDF-03")]});
function draft() {
  const d=createDraft("RB-PDF-11");
  d.pageSize={width:595,height:842};
  d.markersText="人工正文";
  d.pages[0].blocks=[{...makeEmptyBlock("heading"),text:"标题"},{...makeEmptyBlock("paragraph"),text:"人工正文"}];
  d.pages[1].blocks=[{...makeEmptyBlock("paragraph"),text:"只在人工稿"}];
  d.pages[2].blocks=[{...makeEmptyBlock("paragraph"),text:"第三页"}];
  return d;
}
function normalized() {
  return {parser:{name:"docling",version:"1.0",mode:"ocr"},fixtureId:"RB-PDF-11",readingOrderAvailable:true,
    ocr:{ocrModeRequested:true,ocrEnabled:true,engine:"test-ocr",pagesOcrSucceeded:2},
    pages:[
      {pageIndex:0,printedPageLabel:null,blocks:[
        {kind:"heading",text:"标题",pageIndex:0},{kind:"body",text:"人工正文",pageIndex:0},
        {kind:"body",text:"机器多出",pageIndex:0}]},
      {pageIndex:1,printedPageLabel:null,blocks:[{kind:"body",text:"机器独有",pageIndex:1}]},
      {pageIndex:2,printedPageLabel:null,blocks:[{kind:"body",text:"第三页",pageIndex:2}]}
    ]};
}
function throwsCode(action, code) {
  try { action(); throw new Error("SHOULD_REJECT"); }
  catch (e) {expect(e.code).toBe(code);}
}

describe("annotator-02 offline reference contracts — synthetic only", () => {
  it("maps exactly three original-book filenames to frozen source IDs without writing private names into GT", () => {
    const names=parseBookSelection(selection());
    expect(bookLabel(names,"RB-PDF-12")).toBe("RB-PDF-02-原书.pdf");
    expect(bookLabel(names,"RB-PDF-13")).toBe("RB-PDF-03-原书.pdf");
    expect(bookLabel(null,"RB-PDF-11")).toMatch(/未导入/);
    expect(JSON.stringify(buildGroundTruth(draft()))).not.toContain("原书.pdf");
    expect(Object.keys(names)).toEqual(["RB-PDF-01","RB-PDF-02","RB-PDF-03"]);
  });
  it("rejects missing, duplicate, malformed or traversing private book mappings", () => {
    const short=selection(); short.selection.pop();
    throwsCode(()=>parseBookSelection(short),"BOOK_MAPPING_INCOMPLETE");
    const dup=selection();dup.selection.push(source("RB-PDF-02"));
    throwsCode(()=>parseBookSelection(dup),"BOOK_MAPPING_SOURCE_INVALID");
    const escaped=selection();escaped.selection[0].archive_member="../../secret.pdf";
    throwsCode(()=>parseBookSelection(escaped),"BOOK_MAPPING_MEMBER_INVALID");
    const badsha=selection();badsha.selection[1].sha256="fake";
    throwsCode(()=>parseBookSelection(badsha),"BOOK_MAPPING_SOURCE_INVALID");
    const wrongpage=selection();wrongpage.selection[2].pages=200;
    throwsCode(()=>parseBookSelection(wrongpage),"BOOK_MAPPING_PAGE_OUT_OF_RANGE");
  });
  it("allows preview only for matching local source name/size, explicitly without SHA attestation", () => {
    const names=parseBookSelection(selection());
    expect(pdfPreviewEligibility({name:"RB-PDF-01.pdf",size:8192},"RB-PDF-11",names))
      .toMatchObject({source:"RB-PDF-01",originalPhysicalPage:22,verifiedBySha:false});
    expect(pdfPreviewEligibility({name:"RB-PDF-01-原书.pdf",size:8192},"RB-PDF-11",names).verifiedBySha).toBe(false);
    throwsCode(()=>pdfPreviewEligibility({name:"RB-PDF-02.pdf",size:8192},"RB-PDF-11",names),"SOURCE_PDF_FILENAME_MISMATCH");
    throwsCode(()=>pdfPreviewEligibility({name:"RB-PDF-01.pdf",size:8193},"RB-PDF-11",names),"SOURCE_PDF_SIZE_MISMATCH");
    throwsCode(()=>pdfPreviewEligibility({name:"RB-PDF-01.pdf",size:170*1024*1024+1},"RB-PDF-11",null),"SOURCE_PDF_SIZE_INVALID");
  });
  it("imports a real normalized-shape candidate without upgrading its OCR claims to verified GT", () => {
    const c=parseNormalizedCandidate(normalized(),"RB-PDF-11");
    expect(c).toMatchObject({fixtureId:"RB-PDF-11",parser:"docling",mode:"ocr",
      sourceStatus:"UNVERIFIED_LOCAL_CANDIDATE",ocrLabel:"上游声明 OCR 已启用",
      engine:"test-ocr",unknownBindings:0});
    expect(c.pages.map(p=>p.index)).toEqual([0,1,2]);
    expect(c.pages[0].blocks[2].text).toBe("机器多出");
    expect(c).not.toHaveProperty("score");
    expect(c).not.toHaveProperty("reviewers");
  });
  it("rejects wrong fixture IDs, missing page, duplicate page or cross-page blocks", () => {
    throwsCode(()=>parseNormalizedCandidate(normalized(),"RB-PDF-12"),"CANDIDATE_SCHEMA_OR_FIXTURE_MISMATCH");
    const two=normalized();two.pages.pop();
    throwsCode(()=>parseNormalizedCandidate(two,"RB-PDF-11"),"CANDIDATE_SCHEMA_OR_FIXTURE_MISMATCH");
    const dup=normalized();dup.pages[2].pageIndex=1;
    throwsCode(()=>parseNormalizedCandidate(dup,"RB-PDF-11"),"CANDIDATE_PAGE_LAYOUT_INVALID");
    const swapped=normalized();swapped.pages[0].blocks[0].pageIndex=2;
    throwsCode(()=>parseNormalizedCandidate(swapped,"RB-PDF-11"),"CANDIDATE_PAGE_BINDING_INVALID");
  });
  it("marks null block page binding as unknown instead of inventing original source pages", () => {
    const n=normalized();n.pages[1].blocks[0].pageIndex=null;
    const c=parseNormalizedCandidate(n,"RB-PDF-11");
    expect(c.unknownBindings).toBe(1);
    expect(c.pages[1].blocks[0].pageIndex).toBeNull();
  });
  it("never invents OCR success when status is null or OCR provenance is absent", () => {
    const none=normalized();delete none.ocr;
    expect(parseNormalizedCandidate(none,"RB-PDF-11").ocrLabel).toBe("OCR 证据未提供");
    const uncertain=normalized();uncertain.ocr.ocrEnabled=null;
    expect(parseNormalizedCandidate(uncertain,"RB-PDF-11").ocrLabel).toMatch(/仅请求 OCR/);
    const wrong=normalized();wrong.ocr.pagesOcrSucceeded=-1;
    throwsCode(()=>parseNormalizedCandidate(wrong,"RB-PDF-11"),"CANDIDATE_OCR_PROVENANCE_INVALID");
  });
  it("seals exact human snapshot and rejects mutations or different candidate identities", () => {
    const d=draft(), c=parseNormalizedCandidate(normalized(),"RB-PDF-11");
    const locked=sealBlindDraft(d);
    expect(requireSealedComparison(locked,d,c)).toBe(true);
    d.pages[0].blocks[1].text="看过候选后修改";
    throwsCode(()=>requireSealedComparison(locked,d,c),"BLIND_GT_SEAL_REQUIRED");
    throwsCode(()=>requireSealedComparison(null,d,c),"BLIND_GT_SEAL_REQUIRED");
    const another={...c,fixtureId:"RB-PDF-13"};
    throwsCode(()=>requireSealedComparison(locked,draft(),another),"BLIND_GT_SEAL_REQUIRED");
  });
  it("per-page comparison preserves order and distinguishes exact, human-only and candidate-only", () => {
    const d=draft(), c=parseNormalizedCandidate(normalized(),"RB-PDF-11"),seal=sealBlindDraft(d);
    const result=comparePage(seal,d,c,0);
    expect(result.sourcePage).toBe(22);
    expect(result.rows.map(x=>x.status)).toEqual(["一致（仅文本）","一致（仅文本）","候选有／人工未对齐"]);
    expect(comparePage(seal,d,c,1).rows.map(x=>x.status)).toEqual(["文字不同／待人工核对"]);
    expect(comparePage(seal,d,c,2).sourcePage).toBe(192);
    expect(result.note).toMatch(/不代表准确率/);
  });
  it("does not overclaim a segment match; changed glyphs remain subject to human review", () => {
    const n=normalized();n.pages[0].blocks[1].text="人工正丈";
    const d=draft(),seal=sealBlindDraft(d),c=parseNormalizedCandidate(n,"RB-PDF-11");
    const rows=comparePage(seal,d,c,0).rows;
    expect(rows.filter(x=>x.status==="一致（仅文本）")).toHaveLength(1);
    expect(rows.some(x=>x.status==="文字不同／待人工核对")).toBe(true);
    expect(rows.some(x=>x.status==="候选有／人工未对齐")).toBe(true);
    const paired=rows.find(x=>x.status==="文字不同／待人工核对");
    expect([paired.humanText,paired.candidateText]).toEqual(["人工正文","人工正丈"]);
  });
  it("drops unknown untrusted candidate keys before presenting content", () => {
    const c=normalized();c.malicious={upload:"https://example.test/private"};
    c.pages[0].blocks[0].untrusted="<script>alert(1)</script>";
    const parsed=parseNormalizedCandidate(c,"RB-PDF-11");
    expect(JSON.stringify(parsed)).not.toContain("example.test");
    expect(JSON.stringify(parsed)).not.toContain("<script>");
  });
});
describe("annotator-02 static and HTTP privacy barrier", () => {
  it("serves one local comparison module but never reads private filesystem or accepts upload API", async () => {
    const app=await startAnnotationServer();
    try{
      const [js,index,cross]=await Promise.all([
        fetch(new URL("review.mjs",app.url)),fetch(app.url),fetch(new URL("D%3A/private.pdf",app.url))
      ]);
      expect(js.status).toBe(200);expect(await js.text()).toContain("export function comparePage");
      expect(cross.status).toBe(404);
      expect(index.headers.get("content-security-policy")).toContain("frame-src blob:");
      expect(index.headers.get("content-security-policy")).toContain("connect-src 'none'");
      const html=await index.text();
      expect(html).toContain("sandbox=\"allow-scripts\"");
      expect(html).toContain("id=\"comparison\"");
      expect(html).toContain("id=\"book-map-file\"");
      expect((await fetch(new URL("private/normalized.json",app.url))).status).toBe(404);
      expect((await fetch(app.url,{method:"POST",body:"private"})).status).toBe(404);
    }finally{await app.close();}
  });
  it("shows an accessible local result beside each file chooser on both success and failure", async () => {
    const html=await readFile(new URL("../annotation/index.html",import.meta.url),"utf8");
    const script=await readFile(new URL("../annotation/app.mjs",import.meta.url),"utf8");
    const style=await readFile(new URL("../annotation/styles.css",import.meta.url),"utf8");
    for(const id of ["map-status","pdf-status","candidate-status"]) {
      expect(html).toContain('id="'+id+'" class="small local-file-status" role="status" aria-live="polite"');
      expect(script).toContain('referenceStatus("'+id+'"');
      expect(script).toContain('referenceError("'+id+'"');
    }
    expect(script).toContain('const imported = parseBookSelection(JSON.parse(await file.text()))');
    expect(script).toContain('pdfPreviewEligibility(file, pendingFixture, mapping)');
    expect(script).toContain('不要选择 RB-PDF-11/12/13 三页子集');
    expect(script).toContain('请选原始 real_book_selection.json，而非 fixtures.manifest.json');
    expect(style).toContain('.local-file-status[data-state="error"]');
    expect(style).toContain('.local-file-status[data-state="success"]');
    expect(script).not.toContain('window.alert(');
  });
  it("keeps imported content outside persistent browser stores and remote APIs", async () => {
    const app=await readFile(new URL("../annotation/app.mjs",import.meta.url),"utf8");
    const review=await readFile(new URL("../annotation/review.mjs",import.meta.url),"utf8");
    const html=await readFile(new URL("../annotation/index.html",import.meta.url),"utf8");
    for(const text of [app,review]){
      for(const word of ["fetch(","XMLHttpRequest(","new WebSocket(","localStorage.","sessionStorage.","sendBeacon(","serviceWorker.register("]){
        expect(text).not.toContain(word);
      }
    }
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/https?:\/\/[^\s"']+/u);
    expect(app).toContain("if (!gtExported || !candidates[selectedCandidate])");
    expect(app).toContain("exposedFixtures.add(draft.fixtureId)");
    expect(MAX_CANDIDATE_BYTES).toBeLessThanOrEqual(24*1024*1024);
  });
});
