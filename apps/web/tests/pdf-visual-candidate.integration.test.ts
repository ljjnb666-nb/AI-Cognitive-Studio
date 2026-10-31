import { describe, expect, it } from "vitest";
import { pdfReviewCandidateFingerprint } from "@ai-cognitive/ingestion";
import { projectStoredPdfVisualCandidate } from "../lib/pdf-visual-candidate";

const SHA="a".repeat(64),PNG="b".repeat(64);
const graph={schemaVersion:1,figures:[{
  id:"f",kind:"DIAGRAM",bbox:[1,2,300,400],caption:"fixture",
  nodes:[{id:"a",label:"A"},{id:"b",label:"B"}],
  edges:[{from:"a",to:"b",label:"next",direction:"DIRECTED"}],
}]};
const expected={physicalPageIndex:0,sourcePdfSha256:SHA,routingGeneration:1};
function row(){
  return {physicalPageIndex:0,sourcePdfSha256:SHA,sourcePngSha256:PNG,
    routingGeneration:1,candidateJson:structuredClone(graph),
    candidateSha256:pdfReviewCandidateFingerprint(graph),
    expiresAt:new Date("2026-10-29T00:00:00Z")};
}
const now=new Date("2026-10-28T00:00:00Z");

describe("source-scoped visual graph read model",()=>{
  it("renders only verified graph integrity and remains explicitly unreviewed",()=>{
    const v=projectStoredPdfVisualCandidate(row(),expected,now);
    expect(v).toMatchObject({authority:"UNVERIFIED_VISUAL_CANDIDATE",reviewStatus:"NOT_REVIEWED",
      approvedForPodcast:false,approvedForBookIntelligence:false,sourcePngSha256:PNG});
    expect(v!.figures[0]!.edges[0]!.direction).toBe("DIRECTED");
  });
  it("never shows cross-PDF or wrong-page candidate",()=>{
    expect(()=>projectStoredPdfVisualCandidate({...row(),sourcePdfSha256:"c".repeat(64)},expected,now))
      .toThrow("PDF_VISUAL_READ_SOURCE_OR_EXPIRY_INVALID");
    expect(()=>projectStoredPdfVisualCandidate({...row(),physicalPageIndex:1},expected,now))
      .toThrow("PDF_VISUAL_READ_SOURCE_OR_EXPIRY_INVALID");
    expect(()=>projectStoredPdfVisualCandidate({...row(),routingGeneration:2},expected,now))
      .toThrow("PDF_VISUAL_READ_SOURCE_OR_EXPIRY_INVALID");
  });
  it("rejects expired review candidate",()=>{
    expect(()=>projectStoredPdfVisualCandidate(row(),expected,new Date("2026-10-29T00:00:00Z")))
      .toThrow("PDF_VISUAL_READ_SOURCE_OR_EXPIRY_INVALID");
  });
  it("rejects changed graph text or malformed edge; never silently shows false graph",()=>{
    const a=row();a.candidateJson.figures[0]!.caption="changed";
    expect(()=>projectStoredPdfVisualCandidate(a,expected,now))
      .toThrow("PDF_VISUAL_READ_CANDIDATE_INTEGRITY_INVALID");
    const b=row();b.candidateJson.figures[0]!.edges[0]!.to="none";
    expect(()=>projectStoredPdfVisualCandidate(b,expected,now)).toThrow("VISUAL_STRUCTURE_REJECTED");
  });
  it("read with no authorized candidate is safely empty, never calls a model",()=>{
    expect(projectStoredPdfVisualCandidate(null,expected,now)).toBeNull();
  });
});
