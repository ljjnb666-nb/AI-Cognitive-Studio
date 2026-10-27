import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARSER_LIMITS, extractNativePdf } from "@ai-cognitive/ingestion";
import type { ProviderGateway } from "@ai-cognitive/provider-gateway";
import { executeOnDemandPdfVisualReview, type PdfVisualReviewWorkerDeps } from "../src/pdf-visual-review.js";

const pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const graph={schemaVersion:1,figures:[{
  id:"f",kind:"DIAGRAM",bbox:[10,20,200,220],caption:"source figure",
  nodes:[{id:"left",label:"client"},{id:"right",label:"server"}],
  edges:[{from:"left",to:"right",label:"data",direction:"DIRECTED"}],
}]};
async function pdf(mixed=true):Promise<Uint8Array>{
  const doc=new PDFDocument({autoFirstPage:false});
  const pass=new PassThrough(), chunks:Buffer[]=[];
  pass.on("data",(value:Buffer)=>chunks.push(value));
  const done=new Promise<Uint8Array>(r=>pass.on("end",()=>r(new Uint8Array(Buffer.concat(chunks)))));
  doc.pipe(pass);
  doc.addPage();doc.text("Authenticated document source text",48,48);
  if(mixed)doc.image(pixel,80,100,{width:70,height:70});
  doc.addPage();doc.text("Unmixed page",48,48);
  doc.end();
  return done;
}
const task={enabled:true as const,allowExternalVisualModel:true as const,
  workspaceId:"ws-a",userId:"user-a",sourceDocumentId:"doc-a",ingestionRunId:"run-a",
  maxReviewPages:1 as const};
async function fixture(mixed=true) {
  const bytes=await pdf(mixed);
  const inspected=await extractNativePdf(bytes,DEFAULT_PARSER_LIMITS);
  const authorize=vi.fn(async()=>undefined);
  const loadRun=vi.fn(async()=>({
    id:"run-a",workspaceId:"ws-a",sourceDocumentId:"doc-a",status:"SUCCEEDED",
    routingGeneration:1,routingPlan:inspected.routingPlan,
    sourceDocument:{
      id:"doc-a",workspaceId:"ws-a",sizeBytes:BigInt(bytes.length),
      sha256:sha(bytes),mediaType:"application/pdf",storageKey:"private/known.pdf",
    }
  }));
  const headObject=vi.fn(async()=>({key:"private/known.pdf",size:bytes.length}));
  const getObjectStream=vi.fn(async()=> (async function*(){yield new Uint8Array(bytes)})());
  const execute=vi.fn(async(request:{routeSlot:string;text?:{messages:Array<{image?:{sha256:string;sourceSha256:string}}>} } )=>{
    expect(request.routeSlot).toBe("PDF_VISUAL_STRUCTURE");
    expect(request.text?.messages[0]?.image?.sourceSha256).toBe(sha(bytes));
    return {status:"SUCCEEDED" as const,response:{type:"STRUCTURED",structured:graph}};
  });
  const deps:PdfVisualReviewWorkerDeps={
    authorize,loadRun,storage:{headObject,getObjectStream},
    gateway:{execute} as unknown as ProviderGateway,
  };
  return {bytes,deps,authorize,loadRun,headObject,getObjectStream,execute};
}

describe("Worker on-demand PDF visual candidate task",()=>{
  it("authenticates first, reads real private PDF, replay-checks and sends one mixed page through gateway",async()=>{
    const f=await fixture();
    const out=await executeOnDemandPdfVisualReview(task,f.deps);
    expect(f.authorize).toHaveBeenCalledWith("user-a","ws-a");
    expect(f.getObjectStream).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({
      taskMode:"ON_DEMAND_REVIEW_ONLY",sourceDocumentId:"doc-a",
      pageCount:2,mixedPageCount:1,examinedPageCount:1,
      reviewRequired:true,goldApproved:false,canonicalTextUpdated:false,
      persistedVisualContent:false,nativeTextUnchanged:true,
    });
    expect(out.pages[0]?.figures[0]?.edges[0]?.direction).toBe("DIRECTED");
    expect(out.pages[0]?.status).toBe("CANDIDATE_AVAILABLE");
  },90_000);

  it("rejects missing express image-to-provider consent before reading any record",async()=>{
    const f=await fixture();
    await expect(executeOnDemandPdfVisualReview({...task,allowExternalVisualModel:false as true},f.deps))
      .rejects.toThrow("PDF_VISUAL_WORKER_OPT_IN_REQUIRED");
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.loadRun).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("denies unauthorized tenants BEFORE storage or run lookup",async()=>{
    const f=await fixture();
    f.deps.authorize=vi.fn(async()=>{throw Error("ACCESS_DENIED");});
    await expect(executeOnDemandPdfVisualReview(task,f.deps)).rejects.toThrow("ACCESS_DENIED");
    expect(f.loadRun).not.toHaveBeenCalled();
    expect(f.headObject).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("refuses stale/cross-tenant/failed ingestion state without S3 read or provider cost",async()=>{
    for(const mutate of [
      (run:Record<string,unknown>)=>{run.workspaceId="other";},
      (run:Record<string,unknown>)=>{run.status="FAILED";},
      (run:Record<string,unknown>)=>{run.sourceDocumentId="other";},
      (run:Record<string,unknown>)=>{run.routingGeneration=null;},
    ]){
      const f=await fixture();
      const loaded=await f.deps.loadRun({workspaceId:"ws-a",ingestionRunId:"run-a"});
      mutate(loaded as unknown as Record<string,unknown>);
      f.deps.loadRun=async()=>loaded;
      await expect(executeOnDemandPdfVisualReview(task,f.deps))
        .rejects.toThrow("PDF_VISUAL_WORKER_SOURCE_NOT_READY");
      expect(f.headObject).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    }
  },60_000);

  it("refuses tampered source SHA before invoking PDF.js vision or paid gateway",async()=>{
    const f=await fixture();
    const loaded=(await f.deps.loadRun({workspaceId:"ws-a",ingestionRunId:"run-a"}))!;
    loaded.sourceDocument.sha256="0".repeat(64);
    f.deps.loadRun=async()=>loaded;
    await expect(executeOnDemandPdfVisualReview(task,f.deps))
      .rejects.toThrow("PDF_VISUAL_WORKER_SOURCE_SHA_MISMATCH");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("fences a stale/different routing plan before external vision",async()=>{
    const f=await fixture();
    const loaded=(await f.deps.loadRun({workspaceId:"ws-a",ingestionRunId:"run-a"}))!;
    const plan=structuredClone(loaded.routingPlan) as {pages:Array<{route:string}>};
    plan.pages[0]!.route="OCR_REQUIRED";
    loaded.routingPlan=plan;
    f.deps.loadRun=async()=>loaded;
    await expect(executeOnDemandPdfVisualReview(task,f.deps)).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  },45_000);

  it("does not invoke any vision provider for ordinary text-only PDFs",async()=>{
    const f=await fixture(false);
    const out=await executeOnDemandPdfVisualReview(task,f.deps);
    expect(out).toMatchObject({mixedPageCount:0,examinedPageCount:0,
      persistedVisualContent:false,reviewRequired:true});
    expect(f.execute).not.toHaveBeenCalled();
  },60_000);

  it("refuses streaming and metadata size discrepancy before model calls",async()=>{
    const f=await fixture();
    f.deps.storage.headObject=async()=>({key:"private/known.pdf",size:f.bytes.length+1});
    await expect(executeOnDemandPdfVisualReview(task,f.deps))
      .rejects.toThrow("PDF_VISUAL_WORKER_SOURCE_SIZE_MISMATCH");
    expect(f.execute).not.toHaveBeenCalled();
  });
});
