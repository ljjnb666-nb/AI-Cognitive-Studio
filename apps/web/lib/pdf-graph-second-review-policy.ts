import { z } from "zod";

/** Explicit scope for a SECOND, independently authorized, potentially billed call.
 * First-pass mixed-graph consent never satisfies this schema. */
export const pdfGraphSecondReviewConsentSchema = z.strictObject({
  mode: z.literal("INDEPENDENT_GRAPH_SECOND_REVIEW"),
  physicalPageIndex: z.number().int().min(0).max(1999),
  sourcePngSha256: z.string().regex(/^[0-9a-f]{64}$/),
  candidateSha256: z.string().regex(/^[0-9a-f]{64}$/),
  consentToIndependentSecondReview: z.literal(true),
  consentToExternalImageProcessing: z.literal(true),
  consentToProviderCharges: z.literal(true),
});
