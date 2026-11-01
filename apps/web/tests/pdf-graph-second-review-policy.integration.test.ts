import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pdfGraphSecondReviewConsentSchema } from "../lib/pdf-graph-second-review-policy";
const valid = {
  mode: "INDEPENDENT_GRAPH_SECOND_REVIEW",
  physicalPageIndex: 3, sourcePngSha256: "b".repeat(64), candidateSha256: "c".repeat(64),
  consentToIndependentSecondReview: true,
  consentToExternalImageProcessing: true, consentToProviderCharges: true,
};
const load = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
describe("independent second-pass PDF graph review admission", () => {
  it("never accepts first-pass consent as the second paid authorization", () => {
    expect(pdfGraphSecondReviewConsentSchema.parse(valid)).toEqual(valid);
    expect(pdfGraphSecondReviewConsentSchema.safeParse({
      mode:"FIRST_MIXED_PAGE",consentToExternalImageProcessing:true,consentToProviderCharges:true,
    }).success).toBe(false);
    for(const field of ["consentToIndependentSecondReview","consentToExternalImageProcessing","consentToProviderCharges"] as const) {
      expect(pdfGraphSecondReviewConsentSchema.safeParse({ ...valid,[field]:false }).success).toBe(false);
    }
    expect(pdfGraphSecondReviewConsentSchema.safeParse({ ...valid,force:true }).success).toBe(false);
    expect(pdfGraphSecondReviewConsentSchema.safeParse({ ...valid,physicalPageIndex:2000 }).success).toBe(false);
    expect(pdfGraphSecondReviewConsentSchema.safeParse({ ...valid,candidateSha256:"wrong" }).success).toBe(false);
    expect(pdfGraphSecondReviewConsentSchema.safeParse({ ...valid,sourcePngSha256:"wrong" }).success).toBe(false);
  });
  it("enforces real session, canonical origin, live membership and current graph before DB admission", () => {
    const route=load("../app/api/studio/pdf-visual-review/[sourceDocumentId]/second-review/route.ts");
    for(const critical of [
      "disableCookieCache: true", "isAuthenticatedPdfVisualRequest(",
      "isTrustedPdfVisualRequestOrigin(", "process.env.BETTER_AUTH_URL",
      "pdfGraphSecondReviewConsentSchema.parse(body)",
      "workspaceMember.findUnique(", 'member.role === "VIEWER"',
      'status: "SUCCEEDED"', "sourcePage.findFirst(",
      "sourcePdfSha256: source.sha256", "sourcePngSha256: consent.sourcePngSha256",
      "candidateSha256: consent.candidateSha256",
      "projectStoredPdfVisualCandidate(candidate", "pdfGraphSecondReviewRequest.create(",
      "PDF_GRAPH_SECOND_REVIEW_ALREADY_AUTHORIZED",
      'status: "AUTHORIZED_NOT_DISPATCHED"', "modelInvoked: false",
    ]) expect(route).toContain(critical);
    expect(route).not.toContain("gateway.execute(");
    expect(route).not.toContain("processNextPdfVisualUserRequest(");
    expect(route).not.toContain("createGatewayPdfGraphModelReviewer(");
    expect(route).not.toContain("approvedForPodcast: true");
  });
  it("is disabled by default and reserves a separate database identity", () => {
    expect(load("../../../.env.example")).toContain("PDF_GRAPH_SECOND_REVIEW_REQUEST_ENABLED=false");
    const schema=load("../../../packages/db/prisma/schema.prisma");
    expect(schema).toContain("model PdfGraphSecondReviewRequest");
    expect(schema).toContain('@@unique([ingestionRunId, routingGeneration, physicalPageIndex]');
    expect(schema).toContain('status            String       @default("AUTHORIZED_NOT_DISPATCHED")');
    const migration=load("../../../packages/db/prisma/migrations/20261031180000_pdf_graph_second_review_request/migration.sql");
    expect(migration).toContain("PdfGraphSecondReviewRequest_one_per_page_uq");
    expect(migration).toContain("REFERENCES \"IngestionRun\"");
  });
});
