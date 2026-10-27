import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARSER_LIMITS } from "../src/document-parsers.js";
import {
  inspectPdfMixedPageVisualStructure,validatePdfVisualStructureCandidate,
  PDF_VISUAL_STRUCTURE_AUTHORITY,
} from "../src/pdf-visual-structure.js";
import { createZhipuVisualPageExecutor } from "../src/pdf-vision-zhipu-executor.js";

const img=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
const sha=(x:Uint8Array)=>createHash("sha256").update(x).digest("hex");
async function source(mixed=true) {
  const pdf=new PDFDocument({autoFirstPage:false});
  const passthrough=new PassThrough(), chunks:Buffer[]=[];
  passthrough.on("data",(b:Buffer)=>chunks.push(b));
  const completed=new Promise<Uint8Array>(r=>passthrough.on("end",()=>r(new Uint8Array(Buffer.concat(chunks)))));
  pdf.pipe(passthrough);
  pdf.addPage();pdf.text("Source paragraph retained",45,45);
  if(mixed)pdf.image(img,80,110,{width:110,height:90});
  pdf.addPage();pdf.text("Second canonical text",45,45);pdf.end();
  return completed;
}
function diagram() {
  return {schemaVersion:1,figures:[{id:"fig1",kind:"DIAGRAM",
    bbox:[100,100,700,500],caption:"Illustrative flow",
    nodes:[{id:"A",label:"client"},{id:"B",label:"server"}],
    edges:[{from:"A",to:"B",label:"bytes",direction:"DIRECTED"}]}]};
}
describe("mixed PDF -> actual source raster -> vision graph candidate (opt-in)",()=>{
  it("produces source-bound graph candidate from real PDF.js pixels without changing text authority",async()=>{
    const bytes=await source();
    const called=vi.fn(async (p:{pngBytes:Uint8Array;sourceSha256:string;pngSha256:string;physicalPageIndex:number})=>{
      expect(p.physicalPageIndex).toBe(0);
      expect(p.sourceSha256).toBe(sha(bytes));
      expect(p.pngSha256).toBe(sha(p.pngBytes));
      expect([...p.pngBytes.slice(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
      return diagram();
    });
    const report=await inspectPdfMixedPageVisualStructure(bytes,DEFAULT_PARSER_LIMITS,
      {enabled:true,executor:{inspect:called},maxPages:2});
    expect(called).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({pageCount:2,mixedPageCount:1,examinedPageCount:1,
      nativeTextUnchanged:true,productionRoutingChanged:false,goldApproved:false});
    expect(report.pages[0]).toMatchObject({authority:PDF_VISUAL_STRUCTURE_AUTHORITY,
      physicalPageIndex:0,status:"CANDIDATE_AVAILABLE",figureSemantics:"UNVERIFIED"});
    expect(report.pages[0]?.figures[0]?.edges[0]).toEqual(
      {from:"A",to:"B",label:"bytes",direction:"DIRECTED"});
  },60_000);

  it("preserves native text and does not invoke vision on plain PDF pages",async()=>{
    const called=vi.fn(async()=>diagram());
    const result=await inspectPdfMixedPageVisualStructure(await source(false),DEFAULT_PARSER_LIMITS,
      {enabled:true,executor:{inspect:called}});
    expect(result.pages).toEqual([]);
    expect(result.examinedPageCount).toBe(0);
    expect(called).not.toHaveBeenCalled();
  },40_000);

  it("records review-required rather than publishing malformed graph or provider errors",async()=>{
    const bytes=await source();
    for(const response of [
      {schemaVersion:1,figures:[{...diagram().figures[0],edges:[{from:"A",to:"MISSING",label:"x",direction:"DIRECTED"}]}]},
      {schemaVersion:1,figures:[],goldApproved:true},
    ]) {
      const result=await inspectPdfMixedPageVisualStructure(bytes,DEFAULT_PARSER_LIMITS,
        {enabled:true,executor:{inspect:async()=>response}});
      expect(result.pages[0]).toMatchObject({status:"REVIEW_REQUIRED",figures:[],
        failureReason:"INVALID_STRUCTURE",figureSemantics:"UNVERIFIED"});
    }
    const fail=await inspectPdfMixedPageVisualStructure(bytes,DEFAULT_PARSER_LIMITS,
      {enabled:true,executor:{inspect:async()=>{throw Error("timeout");}}});
    expect(fail.pages[0]).toMatchObject({status:"REVIEW_REQUIRED",figures:[],
      failureReason:"VISION_REJECTED"});
  },80_000);

  it("strictly refuses invented relation endpoints, dangerous label data and forged truth flags",()=>{
    expect(()=>validatePdfVisualStructureCandidate(diagram())).not.toThrow();
    expect(()=>validatePdfVisualStructureCandidate({schemaVersion:1,figures:[{
      ...diagram().figures[0],caption:"untrusted\u0000bytes"}]})).toThrow("VISUAL_STRUCTURE_REJECTED");
    expect(()=>validatePdfVisualStructureCandidate({schemaVersion:1,figures:[{
      ...diagram().figures[0],bbox:[900,900,500,500]}]})).toThrow("VISUAL_STRUCTURE_REJECTED");
    expect(()=>validatePdfVisualStructureCandidate({schemaVersion:1,figures:[{
      ...diagram().figures[0],nodes:[{id:"A",label:"x"},{id:"A",label:"z"}]}]})).toThrow("VISUAL_STRUCTURE_REJECTED");
    expect(()=>validatePdfVisualStructureCandidate({...diagram(),goldApproved:true}))
      .toThrow("VISUAL_STRUCTURE_REJECTED");
  });

  it("sends the true PNG to fixed provider endpoint and returns parseable structure via mocked transport",async()=>{
    const request=vi.fn(async (url:RequestInfo|URL,init?:RequestInit)=>{
      expect(String(url)).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string,string>).authorization).toBe("Bearer test-key");
      expect(init?.redirect).toBe("error");
      const body=JSON.parse(String(init?.body)) as {messages:Array<{content:unknown}>};
      expect(JSON.stringify(body.messages)).toContain("data:image/png;base64,");
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(diagram())},finish_reason:"stop"}]}),
        {status:200,headers:{"content-type":"application/json"}});
    });
    const exec=createZhipuVisualPageExecutor({apiKey:"test-key",model:"glm-4.6v",fetchImpl:request as typeof fetch});
    const pdf=await source();
    const report=await inspectPdfMixedPageVisualStructure(pdf,DEFAULT_PARSER_LIMITS,
      {enabled:true,executor:exec});
    expect(request).toHaveBeenCalledTimes(1);
    expect(report.pages[0]?.figures).toHaveLength(1);
  },60_000);

  it("rejects user endpoint/model mistakes and status failures without rerouting to other endpoints",async()=>{
    expect(()=>createZhipuVisualPageExecutor({apiKey:"",model:"glm-4.6v"})).toThrow();
    expect(()=>createZhipuVisualPageExecutor({apiKey:"test",model:"http://other"})).toThrow();
    const request=vi.fn(async()=>new Response("rate limited",{status:429}));
    const exec=createZhipuVisualPageExecutor({apiKey:"test",model:"glm-4.6v",fetchImpl:request as typeof fetch});
    const imageBytes=Buffer.alloc(64);
    img.copy(imageBytes,0,0,Math.min(img.length,64));
    const pngSha=sha(imageBytes);
    await expect(exec.inspect({physicalPageIndex:0,sourceSha256:"a".repeat(64),
      pngSha256:pngSha,pngBytes:new Uint8Array(imageBytes),width:1,height:1}))
      .rejects.toThrow("VISION_PROVIDER_STATUS_REJECTED");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not execute without explicit opt-in",async()=>{
    await expect(inspectPdfMixedPageVisualStructure(await source(),DEFAULT_PARSER_LIMITS,
      {enabled:false as true,executor:{inspect:async()=>diagram()}}))
      .rejects.toThrow("VISUAL_STRUCTURE_OPTIONS_REJECTED");
  });
});
