import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** The OCR review request already owns the base endpoint on main. */
describe("OCR and mixed-graph PDF review API coexistence", () => {
  it("retains the OCR model review POST, its original consent and flag", () => {
    const ocr = read("../app/api/studio/pdf-visual-review/[sourceDocumentId]/route.ts");
    expect(ocr).toContain("requestOcrModelReview");
    expect(ocr).toContain("OCR_MODEL_REVIEW_CONSENT");
    expect(ocr).toContain("PDF_VISUAL_REVIEW_ON_DEMAND_ENABLED");
    expect(ocr).not.toContain("PDF_MIXED_GRAPH_REVIEW_REQUEST_ENABLED");
    expect(ocr).not.toContain("pdfVisualRequestConsentSchema");
  });
  it("keeps graph candidate review on a separate path, consent and opt-in flag", () => {
    const graph = read("../app/api/studio/pdf-visual-review/[sourceDocumentId]/mixed-graph/route.ts");
    expect(graph).toContain("pdfVisualRequestConsentSchema.parse(raw)");
    expect(graph).toContain("PDF_MIXED_GRAPH_REVIEW_REQUEST_ENABLED");
    expect(graph).toContain("auth.api.getSession(");
    expect(graph).toContain("disableCookieCache: true");
    expect(graph).toContain("isAuthenticatedPdfVisualRequest(");
    expect(graph).toContain("sourceDetail(sourceDocumentId, identity)");
    expect(graph).not.toContain("requestOcrModelReview");
    const policy = read("../lib/pdf-visual-request-policy.ts");
    expect(policy).toContain("consentToExternalImageProcessing: z.literal(true)");
    expect(policy).toContain("consentToProviderCharges: z.literal(true)");
    const component = read("../components/pdf-visual-review-request.tsx");
    expect(component).toContain(' + "/mixed-graph"');
    const originalOcrClient = read("../components/ocr-model-review-request.tsx");
    expect(originalOcrClient).toContain("${props.sourceDocumentId}");
    expect(originalOcrClient).not.toContain('"/mixed-graph"');
  });
});
