import { describe, expect, it } from "vitest";
import { pdfReviewCandidateFingerprint } from "@ai-cognitive/domain";
import { buildPdfVisualReviewStorageRows } from "../src/pdf-visual-review-store.js";
import type { PdfSourceReviewPacket } from "../src/pdf-source-review-packet.js";

const SHA="a".repeat(64), PNG="b".repeat(64);
const figure={
  id:"f",kind:"DIAGRAM" as const,bbox:[1,2,300,400] as [number,number,number,number],
  caption:"test fixture",nodes:[{id:"left",label:"A"},{id:"right",label:"B"}],
  edges:[{from:"left",to:"right",label:"arrow",direction:"DIRECTED" as const}],
};
const identity={workspaceId:"ws",sourceDocumentId:"doc",ingestionRunId:"run",
  routingGeneration:1,sourcePdfSha256:SHA};
function packet():PdfSourceReviewPacket {
  return {
    schemaVersion:"pdf-source-review-packet-v1",authority:"SOURCE_BOUND_REVIEW_ONLY",
    sourcePdfSha256:SHA,totalPhysicalPages:2,examinedPages:1,independentGoldApproved:false,
    canonicalTextUpdated:false,persistedReviewCandidate:false,
    approvedForBookIntelligence:false,approvedForPodcast:false,
    pages:[{
      physicalPageIndex:0,sourcePdfSha256:SHA,sourcePngSha256:PNG,
      nativeText:{status:"EXTRACTED_UNVERIFIED",sourceMethod:"PDFJS_NATIVE",
        sourceBlockCount:1,excerpt:"PRIVATE_TEXT_MUST_NOT_BE_STORED",excerptTruncated:false},
      visual:{status:"CANDIDATE_UNVERIFIED",figures:[figure],failureReason:null},
      reviewRequired:true,approvedForBookIntelligence:false,approvedForPodcast:false,
    }],
  };
}

describe("opt-in PDF visual candidate storage projection",()=>{
  it("stores only bounded graph without PDF pages or source text and expires in 24h",()=>{
    const now=new Date("2026-10-28T10:00:00Z");
    const rows=buildPdfVisualReviewStorageRows(identity,packet(),now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({workspaceId:"ws",ingestionRunId:"run",
      sourcePdfSha256:SHA,sourcePngSha256:PNG,physicalPageIndex:0,
      expiresAt:new Date("2026-10-29T10:00:00Z")});
    expect(JSON.stringify(rows[0])).not.toContain("PRIVATE_TEXT_MUST_NOT_BE_STORED");
    expect(rows[0]!.candidateSha256).toBe(pdfReviewCandidateFingerprint(rows[0]!.candidateJson));
  });
  it("refuses source sha mismatch and any claimed approval",()=>{
    const p=packet();p.sourcePdfSha256="0".repeat(64);
    expect(()=>buildPdfVisualReviewStorageRows(identity,p)).toThrow("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
    const q=packet();(q as unknown as {approvedForPodcast:boolean}).approvedForPodcast=true;
    expect(()=>buildPdfVisualReviewStorageRows(identity,q)).toThrow("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
  });
  it("does not turn a failed visual call into an empty approved candidate",()=>{
    const p=packet();p.pages[0]!.visual={status:"REVIEW_REQUIRED",figures:[],failureReason:"VISION_REJECTED"};
    expect(buildPdfVisualReviewStorageRows(identity,p)).toEqual([]);
  });
  it("rejects duplicate physical-page candidates and malformed relationships",()=>{
    const p=packet();p.pages.push({...p.pages[0]!});p.examinedPages=2;
    expect(()=>buildPdfVisualReviewStorageRows(identity,p)).toThrow("PDF_VISUAL_CANDIDATE_AUTHORITY_INVALID");
    const q=packet();q.pages[0]!.visual.figures[0]!.edges[0]!.to="other";
    expect(()=>buildPdfVisualReviewStorageRows(identity,q)).toThrow("VISUAL_STRUCTURE_REJECTED");
  });
  it("has canonical fingerprints invariant to JSONB object key order",()=>{
    expect(pdfReviewCandidateFingerprint({schemaVersion:1,figures:[{a:1,b:2}]}))
      .toBe(pdfReviewCandidateFingerprint({figures:[{b:2,a:1}],schemaVersion:1}));
  });
});
