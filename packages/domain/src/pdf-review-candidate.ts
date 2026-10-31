import { createHash } from "node:crypto";

/** Canonical UTF-8 digest for bounded JSON graph receipts; stable across JSONB key reorder. */
export function pdfReviewCandidateFingerprint(value: unknown): string {
  const serialize = (input: unknown): string => {
    if (input === null || typeof input === "string" || typeof input === "boolean")
      return JSON.stringify(input);
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (Array.isArray(input)) return "[" + input.map(serialize).join(",") + "]";
    if (typeof input === "object" && input !== null && Object.getPrototypeOf(input) === Object.prototype) {
      const obj = input as Record<string, unknown>;
      return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + serialize(obj[k])).join(",") + "}";
    }
    throw new Error("PDF_REVIEW_CANDIDATE_INVALID_JSON");
  };
  return createHash("sha256").update(serialize(value), "utf8").digest("hex");
}
