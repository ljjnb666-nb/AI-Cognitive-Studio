import { describe, it, expect, vi } from "vitest";
import { createPdfPageViewer, MAX_CANVAS_PIXELS, MAX_INLINE_PDF_BYTES } from "../annotation/preview.mjs";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createDraft, makeEmptyBlock, buildGroundTruth } from "../annotation/workspace.mjs";
import {
  parseBookSelection, bookLabel, pdfPreviewEligibility,
  parseNormalizedCandidate, sealBlindDraft, requireSealedComparison, comparePage,
  MAX_CANDIDATE_BYTES,
} from "../annotation/review.mjs";
import { startAnnotationServer } from "../annotation/server.mjs";
import { parseNormalizedOutput } from "../src/schema.ts";

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
  it("imports a synthetic actual NormalizedOutput Zod contract, including full OCR fields", () => {
    const actual=normalized();
    actual.ocr={...actual.ocr,model:null,modelRevision:null,language:"zh",
      pagesOcrProcessed:2,pagesRequiringOcr:2};
    for (const page of actual.pages) {
      for (const block of page.blocks) {
        block.bbox=null; block.confidence=null; block.sourceMethod="ocr";
      }
    }
    const persisted=parseNormalizedOutput(actual);
    const candidate=parseNormalizedCandidate(persisted,"RB-PDF-11");
    expect(candidate.pages.map(p=>p.index)).toEqual([0,1,2]);
    expect(candidate.ocrLabel).toMatch(/上游声明 OCR 已启用/);
    for (const parserName of ["pdfjs-isolated","liteparse","docling","mineru"]) {
      persisted.parser.name=parserName;
      expect(parseNormalizedCandidate(persisted,"RB-PDF-11").parser).toBe(parserName);
    }
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
      expect(index.headers.get("content-security-policy")).toContain("frame-src 'none'");
      expect(index.headers.get("content-security-policy")).toContain("worker-src 'self'");
      expect(index.headers.get("content-security-policy")).toContain("font-src blob: data:");
      expect(index.headers.get("content-security-policy")).toContain("img-src blob: data:");
      expect(index.headers.get("content-security-policy")).toContain("connect-src 'none'");
      const html=await index.text();
      expect(html).not.toContain("<iframe");
      expect(html).toContain("id=\"pdf-canvas\"");
      expect((await fetch(new URL("preview.mjs",app.url))).status).toBe(200);
      const vendor=await fetch(new URL("vendor/pdf.mjs",app.url));
      expect(vendor.status).toBe(200);
      expect((await vendor.text()).length).toBeGreaterThan(1000);
      expect((await fetch(new URL("vendor/pdf.worker.mjs",app.url))).status).toBe(200);
      expect((await fetch(new URL("vendor/../../package.json",app.url))).status).toBe(404);
      expect(html).toContain("id=\"comparison\"");
      expect(html).toContain("id=\"book-map-file\"");
      expect((await fetch(new URL("private/normalized.json",app.url))).status).toBe(404);
      expect((await fetch(app.url,{method:"POST",body:"private"})).status).toBe(404);
    }finally{await app.close();}
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

function syntheticViewer(overrides = {}) {
  const statuses = [], visited = [], destroys = [];
  const canvas = { hidden:true, width:0, height:0, getContext:() => ({}) };
  const doc = {numPages:400, destroy:vi.fn(() => { destroys.push("document"); }),
    getPage:vi.fn(async physicalPage => {
      visited.push(physicalPage);
      return {getViewport:({scale}) => ({width:1100*scale,height:1500*scale}),
        render:vi.fn(() => ({promise:Promise.resolve(),cancel:vi.fn()})),
        cleanup:vi.fn()};
    }),...overrides};
  const lib = {getDocument:vi.fn(options => ({
    promise:Promise.resolve(doc),destroy:vi.fn(() => { destroys.push("load"); })
  }))};
  const viewer=createPdfPageViewer({
    canvas, onStatus:state => statuses.push(state),
    loadPdfJs:async () => lib,
  });
  const file={size:1024,arrayBuffer:async () => new Uint8Array([37,80,68,70,45,49,46,55]).buffer};
  return {canvas,statuses,visited,destroys,doc,lib,viewer,file};
}
describe("02 Edge preview repair — offline, synthetic browser rendering contract", () => {
  it("renders true physical pages and bounds pixels, never opening a blob iframe or URL", async () => {
    const v=syntheticViewer();
    await v.viewer.open(v.file,22);
    expect(v.visited).toEqual([22]);
    expect(v.canvas.hidden).toBe(false);
    expect(v.canvas.width*v.canvas.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(v.lib.getDocument.mock.calls[0][0]).toMatchObject({
      isEvalSupported:false,enableXfa:false,useWasm:false,disableAutoFetch:true,disableRange:true,
    });
    expect(v.lib.getDocument.mock.calls[0][0].data).toBeInstanceOf(Uint8Array);
    await v.viewer.go(107);
    await v.viewer.go(192);
    expect(v.visited).toEqual([22,107,192]);
    v.viewer.clear();
    expect(v.canvas.width).toBe(0);
    expect(v.destroys).toContain("document");
    expect(v.statuses.at(-1).kind).toBe("empty");
  });
  it("does not allocate very large local books or pretend a page outside source exists", async () => {
    const v=syntheticViewer({numPages:25});
    await v.viewer.open({...v.file,size:MAX_INLINE_PDF_BYTES+1,
      arrayBuffer:() => {throw Error("must not read bytes");}},22);
    expect(v.statuses.at(-1).kind).toBe("external");
    await v.viewer.go(192);
    expect(v.statuses.at(-1).message).toContain("192");
    expect(v.lib.getDocument).not.toHaveBeenCalled();
    await v.viewer.open(v.file,107);
    expect(v.statuses.at(-1).kind).toBe("error");
    expect(v.statuses.at(-1).message).toMatch(/完整原书/);
    expect(v.canvas.hidden).toBe(true);
  });
  it("keeps latest requested physical page while document bytes are still loading", async () => {
    const v=syntheticViewer();
    let resolveBytes;
    const pending = { ...v.file, arrayBuffer:() => new Promise(resolve => {resolveBytes=resolve;}) };
    const promise=v.viewer.open(pending,22);
    await Promise.resolve(); await Promise.resolve();
    await v.viewer.go(107);
    for(let i=0;i<4 && !resolveBytes;i++) await Promise.resolve();
    expect(resolveBytes).toBeTypeOf("function");
    resolveBytes(new Uint8Array([37,80,68,70,45,49,46,55]).buffer);
    await promise;
    expect(v.visited).toEqual([107]);
  });
  it("closed/replaced selection cannot resurrect an old asynchronous PDF", async () => {
    const v=syntheticViewer();
    let release;
    const pending={...v.file,arrayBuffer:() => new Promise(resolve=>{release=resolve;})};
    const task=v.viewer.open(pending,22);
    await Promise.resolve(); await Promise.resolve();
    v.viewer.clear();
    for(let i=0;i<4 && !release;i++) await Promise.resolve();
    expect(release).toBeTypeOf("function");
    release(new Uint8Array([37,80,68,70,45,49,46,55]).buffer);
    await task;
    expect(v.lib.getDocument).not.toHaveBeenCalled();
    expect(v.canvas.hidden).toBe(true);
  });
  it("does not reuse a canvas across books until a canceled render has settled", async () => {
    const v=syntheticViewer();
    let releaseRender;
    v.doc.getPage.mockImplementationOnce(async p => {
      v.visited.push(p);
      return {getViewport:({scale}) => ({width:400*scale,height:400*scale}),
        cleanup:vi.fn(),render:() => ({
          promise:new Promise(resolve=>{releaseRender=resolve;}),cancel:vi.fn(),
        })};
    });
    const first=v.viewer.open(v.file,22);
    for(let i=0;i<20 && !releaseRender;i++) await Promise.resolve();
    expect(releaseRender).toBeTypeOf("function");
    const second=v.viewer.open(v.file,107);
    for(let i=0;i<10;i++) await Promise.resolve();
    expect(v.visited).toEqual([22]); // next book must not paint the busy canvas
    releaseRender();
    await Promise.all([first,second]);
    expect(v.visited).toEqual([22,107]);
    expect(v.statuses.at(-1).kind).toBe("ready");
  });
  it("damaged PDF fails visibly with external reader fallback, without leaking private content", async () => {
    const v=syntheticViewer();
    v.lib.getDocument.mockImplementationOnce(() => ({
      promise:Promise.reject(new Error("sensitive PDF contents")),destroy:vi.fn(),
    }));
    await v.viewer.open(v.file,22);
    expect(v.statuses.at(-1).kind).toBe("error");
    expect(v.statuses.at(-1).message).toMatch(/系统 PDF 阅读器/);
    expect(v.statuses.at(-1).message).not.toContain("sensitive");
    expect(v.canvas.hidden).toBe(true);
  });
  it("maintains code-only private isolation and Chinese source-file mismatch guidance", async () => {
    const app=await readFile(new URL("../annotation/app.mjs",import.meta.url),"utf8");
    const html=await readFile(new URL("../annotation/index.html",import.meta.url),"utf8");
    const server=await readFile(new URL("../annotation/server.mjs",import.meta.url),"utf8");
    expect(app).toContain("请重新选择完整原书，不要选三页实验样本");
    expect(app).toContain('exposedFixtures.add(draft.fixtureId)');
    expect(html).not.toContain("<iframe");
    expect(server).toContain("connect-src 'none'");
    expect(server).toContain("worker-src 'self'");
    expect(server).not.toMatch(/\/api\/pdf|PDF_UPLOAD|readFile\(request\.url/u);
  });
});
