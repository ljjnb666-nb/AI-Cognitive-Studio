import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pdfReviewCandidateFingerprint } from "@ai-cognitive/ingestion";
import { projectPdfPageEvidence } from "../lib/pdf-page-review";
import { projectStoredPdfVisualCandidate } from "../lib/pdf-visual-candidate";
import { buildPdfSourceGraphReviewPacket } from "../lib/pdf-source-graph-packet";

const sha = "a".repeat(64), png = "b".repeat(64);
const graph = { schemaVersion: 1, figures: [{
  id: "g1", kind: "DIAGRAM", bbox: [20, 30, 300, 250], caption: "synthetic fixture",
  nodes: [{ id: "n1", label: "input" }, { id: "n2", label: "output" }],
  edges: [{ from: "n1", to: "n2", label: "transforms", direction: "DIRECTED" }],
}] };
function input(count = 1, withGraph = true, long = false) {
  const evidence = projectPdfPageEvidence({
    sourceSha256: sha, physicalPageIndex: 3, recordedPageIndex: 3,
    sourceBlockCount: count,
    blocks: count === 0 ? [] : [{ id: "b0", ordinal: 4, kind: "PARAGRAPH",
      text: long ? "A".repeat(8000) : "same physical page text" }],
  });
  const row = {
    physicalPageIndex: 3, sourcePdfSha256: sha, sourcePngSha256: png,
    routingGeneration: 4, candidateJson: structuredClone(graph),
    candidateSha256: pdfReviewCandidateFingerprint(graph),
    expiresAt: new Date("2050-01-01"),
  };
  const visual = withGraph ? projectStoredPdfVisualCandidate(
    row, { physicalPageIndex: 3, sourcePdfSha256: sha, routingGeneration: 4 },
    new Date("2030-01-01"),
  ) : null;
  return { workspaceId: "workspace", sourceDocumentId: "source",
    extractionId: "extraction", ingestionRunId: "run", routingGeneration: 4,
    evidence, visual };
}

describe("bounded PDF source+graph review packet for independent model input", () => {
  it("joins saved extraction text and SHA-verified graph without creating approved facts", () => {
    const packet = buildPdfSourceGraphReviewPacket(input());
    expect(packet).toMatchObject({
      schemaVersion: "pdf-source-graph-review-packet-v1",
      authority: "SOURCE_BOUND_UNVERIFIED_REVIEW_INPUT",
      source: { physicalPageIndex: 3, pdfSha256: sha, sourcePngSha256: png,
        routingGeneration: 4, ingestionRunId: "run" },
      coverage: { state: "SOURCE_TEXT_AND_VISUAL_CANDIDATE",
        originalPageImageRequired: true, sourceTextPreviewTruncated: false },
      independentModelReviewStatus: "NOT_REVIEWED",
      approvedForBookIntelligence: false, approvedForPodcast: false, publishable: false,
    });
    expect(packet.text.parsedBlocks[0]?.excerpt).toBe("same physical page text");
    expect(packet.visual?.figures[0]?.edges[0]?.direction).toBe("DIRECTED");
    expect(packet.visual?.candidateSha256).toBe(pdfReviewCandidateFingerprint(graph));
    expect(JSON.stringify(packet)).not.toContain("storageKey");
  });
  it("does not mistake an absent graph for an empty authenticated figure", () => {
    const packet = buildPdfSourceGraphReviewPacket(input(2, false));
    expect(packet.coverage.state).toBe("NO_VISUAL_CANDIDATE");
    expect(packet.visual).toBeNull();
    expect(packet.publishable).toBe(false);
  });
  it("preserves truncation and never marks partial evidence as complete", () => {
    const packet = buildPdfSourceGraphReviewPacket(input(2, true, true));
    expect(packet.coverage.state).toBe("TRUNCATED_SOURCE_PREVIEW");
    expect(packet.coverage.sourceTextPreviewTruncated).toBe(true);
    expect(packet.text.parsedBlocks[0]?.excerpt.length).toBe(6000);
    expect(packet.publishable).toBe(false);
  });
  it("rejects altered source authority and malformed source linkage", () => {
    const bad = input();
    expect(() => buildPdfSourceGraphReviewPacket({
      ...bad, routingGeneration: 0,
    })).toThrow("PDF_SOURCE_GRAPH_PACKET_AUTHORITY_INVALID");
    expect(() => buildPdfSourceGraphReviewPacket({
      ...bad, evidence: { ...bad.evidence, sourceSha256: "not-a-sha" },
    })).toThrow("PDF_SOURCE_GRAPH_PACKET_AUTHORITY_INVALID");
    expect(() => buildPdfSourceGraphReviewPacket({
      ...bad, visual: { ...bad.visual!, approvedForPodcast: true as false },
    })).toThrow("PDF_SOURCE_GRAPH_PACKET_AUTHORITY_INVALID");
  });
  it("rejects corrupt, cross-PDF, wrong page or expired graph at source read boundary", () => {
    const row = {
      physicalPageIndex: 3, sourcePdfSha256: sha, sourcePngSha256: png,
      routingGeneration: 4, candidateJson: graph,
      candidateSha256: pdfReviewCandidateFingerprint(graph),
      expiresAt: new Date("2050-01-01"),
    };
    expect(() => projectStoredPdfVisualCandidate({ ...row,
      sourcePdfSha256: "c".repeat(64) },
      { physicalPageIndex: 3, sourcePdfSha256: sha, routingGeneration: 4 },
      new Date("2030-01-01"))).toThrow();
    expect(() => projectStoredPdfVisualCandidate({ ...row, physicalPageIndex: 4 },
      { physicalPageIndex: 3, sourcePdfSha256: sha, routingGeneration: 4 },
      new Date("2030-01-01"))).toThrow();
    expect(() => projectStoredPdfVisualCandidate({ ...row, candidateSha256: "f".repeat(64) },
      { physicalPageIndex: 3, sourcePdfSha256: sha, routingGeneration: 4 },
      new Date("2030-01-01"))).toThrow();
    expect(() => projectStoredPdfVisualCandidate({ ...row, expiresAt: new Date("2029-01-01") },
      { physicalPageIndex: 3, sourcePdfSha256: sha, routingGeneration: 4 },
      new Date("2030-01-01"))).toThrow();
  });
  it("read-only endpoint demands real login, live membership and current run/page", () => {
    const route = readFileSync(fileURLToPath(new URL(
      "../app/api/studio/pdf-visual-review/[sourceDocumentId]/review-packet/route.ts",
      import.meta.url)), "utf8");
    for (const invariant of [
      "disableCookieCache: true", "isAuthenticatedPdfVisualRequest(",
      "workspaceMember.findUnique(", "sourceDetail(sourceDocumentId, identity)",
      'status: "SUCCEEDED"', "sourceDocument: { sha256: source.sha256",
      "sourcePage.findFirst(", "projectStoredPdfVisualCandidate(",
      "projectPdfPageEvidence(", "Cache-Control",
    ]) expect(route).toContain(invariant);
    expect(route).not.toContain("export async function POST");
    expect(route).not.toContain("gateway.execute");
  });
});
