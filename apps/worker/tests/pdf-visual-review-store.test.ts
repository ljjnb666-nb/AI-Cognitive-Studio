import { describe, expect, it } from "vitest";
import { pdfReviewCandidateFingerprint } from "@ai-cognitive/domain";
import { buildPdfVisualReviewStorageRows } from "../src/pdf-visual-review-store.js";
import type { PdfVisualStructureResult } from "@ai-cognitive/ingestion";

const SHA = "a".repeat(64), PNG = "b".repeat(64);
const identity = {workspaceId:"w",sourceDocumentId:"d",ingestionRunId:"r",routingGeneration:1,sourcePdfSha256:SHA};
const figure = { id:"f", kind:"DIAGRAM" as const,
  bbox:[1,2,300,400] as [number,number,number,number], caption:"example",
  nodes:[{id:"left",label:"A"},{id:"right",label:"B"}],
  edges:[{from:"left",to:"right",label:"arrow",direction:"DIRECTED" as const}] };
function output():PdfVisualStructureResult {
  return {
    schemaVersion:"pdf-visual-structure-v1", authority:"UNVERIFIED_VISUAL_CANDIDATE",
    pageCount:2,mixedPageCount:1,examinedPageCount:1,
    pages:[{physicalPageIndex:0,sourceSha256:SHA,pngSha256:PNG,
      authority:"UNVERIFIED_VISUAL_CANDIDATE",figureSemantics:"UNVERIFIED",
      status:"CANDIDATE_AVAILABLE",figures:[structuredClone(figure)]}],
    nativeTextUnchanged:true,productionRoutingChanged:false,goldApproved:false,
  };
}
describe("source-bound visual candidate storage",()=>{
  it("stores only graph JSON for 24 hours, never PNG or canonical text",()=>{
    const row=buildPdfVisualReviewStorageRows(identity,output(),new Date("2026-10-28T10:00:00Z"))[0]!;
    expect(row).toMatchObject({workspaceId:"w",sourcePdfSha256:SHA,sourcePngSha256:PNG,
      expiresAt:new Date("2026-10-29T10:00:00Z")});
    expect(row.candidateSha256).toBe(pdfReviewCandidateFingerprint(row.candidateJson));
    expect(JSON.stringify(row)).not.toContain("pngBytes");
  });
  it("rejects source mismatch and forged Gold or publication authority",()=>{
    const x=output();x.pages[0]!.sourceSha256="0".repeat(64);
    expect(()=>buildPdfVisualReviewStorageRows(identity,x)).toThrow("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
    const y=output();(y as {goldApproved:boolean}).goldApproved=true;
    expect(()=>buildPdfVisualReviewStorageRows(identity,y)).toThrow("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
  });
  it("never stores failed, empty or fabricated visual nodes",()=>{
    const x=output();x.pages[0]!={...x.pages[0]!,status:"REVIEW_REQUIRED",failureReason:"VISION_REJECTED",figures:[]};
    expect(buildPdfVisualReviewStorageRows(identity,x)).toEqual([]);
    const y=output();y.pages[0]!.figures[0]!.edges[0]!.to="nonexistent";
    expect(()=>buildPdfVisualReviewStorageRows(identity,y)).toThrow("VISUAL_STRUCTURE_REJECTED");
  });
  it("rejects duplicate page, malformed source index and unauthorized extra fields",()=>{
    const x=output();x.pages.push({...x.pages[0]!});x.examinedPageCount=2;
    expect(()=>buildPdfVisualReviewStorageRows(identity,x)).toThrow("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
    const y=output();(y.pages[0]!.figures[0] as unknown as {gold:boolean}).gold=true;
    expect(()=>buildPdfVisualReviewStorageRows(identity,y)).toThrow("VISUAL_STRUCTURE_REJECTED");
  });
});
