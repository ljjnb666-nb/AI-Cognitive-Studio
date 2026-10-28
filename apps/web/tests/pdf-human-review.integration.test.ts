import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadVerifiedPdfForHumanReview } from "../lib/pdf-human-original-source";
import { assertPdfHumanReviewTransition, pdfHumanReviewActionSchema } from "../lib/pdf-human-review";

const original = new TextEncoder().encode("%PDF-1.7\nPRIVATE_PAGE_ONLY");
const digest = createHash("sha256").update(original).digest("hex");
const source = {storageKey:"private/s.pdf",sha256:digest,sizeBytes:BigInt(original.length),mediaType:"application/pdf"};
const storage=(bytes:Uint8Array=original)=>({
  headObject:async()=>({key:"private/s.pdf",size:bytes.length,contentType:"application/pdf"}),
  getObjectStream:async()=>({async *[Symbol.asyncIterator](){yield bytes;}}),
});
const CID="cmcmcmcmcmcmcmcmcmcmcmcm",EID="cmememememememememememe";

describe("private original PDF human comparison",()=>{
  it("verifies full bytes before making them available for review",async()=>{
    expect(await loadVerifiedPdfForHumanReview(storage(),source)).toEqual(original);
  });
  it("rejects swapped, oversized or non-PDF source",async()=>{
    await expect(loadVerifiedPdfForHumanReview(storage(new TextEncoder().encode("%PDF-1.7\nREPLACED")),source))
      .rejects.toThrow();
    await expect(loadVerifiedPdfForHumanReview(storage(),{...source,sizeBytes:110_000_001n}))
      .rejects.toThrow("PDF_REVIEW_PREVIEW_INVALID_SOURCE");
    await expect(loadVerifiedPdfForHumanReview(storage(),{...source,mediaType:"text/html"}))
      .rejects.toThrow("PDF_REVIEW_PREVIEW_INVALID_SOURCE");
  });
  it("rejects altered streaming bytes even when metadata length matches",async()=>{
    const other=new TextEncoder().encode("%PDF-1.7\nPRIVATE_PAGE_ONLY");
    other[10]=88;
    await expect(loadVerifiedPdfForHumanReview(storage(other),source))
      .rejects.toThrow("PDF_REVIEW_PREVIEW_SOURCE_SHA_MISMATCH");
  });
});

describe("append-only human review state machine",()=>{
  const action={candidateId:CID,candidateSha256:digest,previousEventId:null,
    action:"CONFIRM_STRUCTURE" as const,comparedWithOriginalPdf:true as const};
  it("requires explicit original-PDF comparison and refuses extra fields",()=>{
    expect(pdfHumanReviewActionSchema.parse(action)).toEqual(action);
    expect(pdfHumanReviewActionSchema.safeParse({...action,comparedWithOriginalPdf:false}).success).toBe(false);
    expect(pdfHumanReviewActionSchema.safeParse({...action,approvedForPodcast:true}).success).toBe(false);
  });
  it("supports first confirmation, withdrawal, then a new judgement",()=>{
    expect(()=>assertPdfHumanReviewTransition(null,action)).not.toThrow();
    expect(()=>assertPdfHumanReviewTransition({id:EID,action:"CONFIRM_STRUCTURE"},
      {action:"WITHDRAW",previousEventId:EID})).not.toThrow();
    expect(()=>assertPdfHumanReviewTransition({id:EID,action:"WITHDRAW"},
      {action:"REJECT_STRUCTURE",previousEventId:EID})).not.toThrow();
  });
  it("rejects stale concurrent decision and direct overwriting of verdict",()=>{
    expect(()=>assertPdfHumanReviewTransition({id:EID,action:"CONFIRM_STRUCTURE"},action))
      .toThrow("PDF_HUMAN_REVIEW_CONFLICT");
    expect(()=>assertPdfHumanReviewTransition({id:EID,action:"CONFIRM_STRUCTURE"},
      {action:"REJECT_STRUCTURE",previousEventId:EID}))
      .toThrow("PDF_HUMAN_REVIEW_WITHDRAW_FIRST");
    expect(()=>assertPdfHumanReviewTransition(null,
      {action:"WITHDRAW",previousEventId:null}))
      .toThrow("PDF_HUMAN_REVIEW_TRANSITION_INVALID");
  });
});
