import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GroundTruth } from "../src/ground-truth.js";
import { PrivateQualityGateError, validateHumanReview, assertNativeParserIdentity, assertSubsetPageOwnership } from "../src/real-book-quality-gate.js";

const sourceSha = "a".repeat(64);
const subsetSha = "b".repeat(64);
const gtData = Buffer.from("synthetic-GT-annotation-by-independent-human", "utf8");
const gtHash = createHash("sha256").update(gtData).digest("hex");
const ids = new Map([
  ["RB-PDF-01", { expectedSha256: sourceSha }],
  ["RB-PDF-11", { expectedSha256: subsetSha }],
]);

function groundTruth(): GroundTruth {
  return {
    fixtureId: "RB-PDF-11", generator: "human-curated-from-original",
    pages: 3, pageSize: { width: 600, height: 800 }, ocrRequired: false,
    ocrRequiredPages: [], normalizationPolicy: "NFKC + remove whitespace",
    text: "synthetic prose only", keyMarkers: ["synthetic"], ocrKeyPhrases: [],
    blocks: [
      { id: "B1", page: 0, column: null, role: "paragraph", text: "synthetic" },
      { id: "B2", page: 1, column: null, role: "figure", text: "" },
      { id: "B3", page: 2, column: null, role: "paragraph", text: "prose only" },
    ],
    headings: [], lists: [], tables: [], formulas: [], noise: [],
  };
}
function review(): Record<string, unknown> {
  return {
    schema: "acs-real-book-human-ground-truth-review-v1",
    fixtureId: "RB-PDF-11", sourceFixtureId: "RB-PDF-01",
    sourceFixtureSha256: sourceSha, subsetFixtureSha256: subsetSha,
    groundTruthSha256: gtHash, sourcePages1Based: [22, 107, 192],
    pageAudits: [22, 107, 192].map((n, i) => ({
      subsetPageIndex: i, originalPhysicalPage1Based: n,
      textCheckedAgainstOriginal: true, figuresChecked: true,
      tablesChecked: true, formulasChecked: true, citationLocatorChecked: true,
    })),
    reviewers: ["reviewer-a", "reviewer-b"].map(reviewerId => ({
      reviewerId, confirmedAgainstOriginal: true,
      independentReview: true, reviewedAt: "2026-10-10T01:00:00.000Z",
    })),
  };
}
function rejected(code: string, r: unknown = review(), gt: GroundTruth = groundTruth()): void {
  try {
    validateHumanReview(r, "RB-PDF-11", gtData, gt, ids);
    throw new Error("EXPECTED_GATE_FAILURE");
  } catch (e) {
    expect(e).toBeInstanceOf(PrivateQualityGateError);
    expect((e as PrivateQualityGateError).code).toBe(code);
  }
}
describe("REAL-BOOK-QUALITY-01 human annotation release gate (synthetic only)", () => {
  it("permits structurally complete, pinned, two-reviewer GT attestation", () => {
    expect(() => validateHumanReview(review(), "RB-PDF-11", gtData, groundTruth(), ids)).not.toThrow();
  });
  it("rejects unreviewed or one-reviewer ground truth", () => {
    const r = review(); r.reviewers = [(r.reviewers as unknown[])[0]];
    rejected("HUMAN_REVIEW_INVALID", r);
  });
  it("rejects duplicated reviewer identities", () => {
    const r = review(); (r.reviewers as Array<Record<string, unknown>>)[1]!.reviewerId = "reviewer-a";
    rejected("HUMAN_REVIEW_DUPLICATE_REVIEWER", r);
  });
  it("rejects a changed GT SHA without approving new content", () => {
    const r = review(); r.groundTruthSha256 = "c".repeat(64);
    rejected("HUMAN_REVIEW_IDENTITY_MISMATCH", r);
  });
  it("rejects a changed parent/subset fixture SHA", () => {
    const r = review(); r.sourceFixtureSha256 = "d".repeat(64);
    rejected("HUMAN_REVIEW_IDENTITY_MISMATCH", r);
  });
  it("rejects duplicate or wrong physical-page review", () => {
    const r = review(); (r.pageAudits as Array<Record<string, unknown>>)[1]!.subsetPageIndex = 0;
    rejected("HUMAN_REVIEW_PAGE_COVERAGE", r);
    const wrong = review(); (wrong.pageAudits as Array<Record<string, unknown>>)[1]!.originalPhysicalPage1Based = 108;
    rejected("HUMAN_REVIEW_PAGE_MAP", wrong);
  });
  it("rejects machine-derived or empty incomplete GT", () => {
    rejected("GROUND_TRUTH_NOT_COMPLETE", review(), { ...groundTruth(), generator: "automatic-from-parser-output" });
    rejected("GROUND_TRUTH_NOT_COMPLETE", review(), { ...groundTruth(), text: "" });
  });
  it("rejects GT blocks on non-subset pages and duplicate block IDs", () => {
    const out = groundTruth(); out.blocks[0]!.page = 3;
    rejected("GROUND_TRUTH_PAGE_OUT_OF_RANGE", review(), out);
    const duplicate = groundTruth(); duplicate.blocks[1]!.id = "B1";
    rejected("GROUND_TRUTH_BLOCK_IDS_DUPLICATE", review(), duplicate);
  });
  it("rejects missing content annotation for any sampled physical page", () => {
    const gt = groundTruth();
    gt.blocks.splice(1, 1);
    rejected("GROUND_TRUTH_PAGE_CONTENT_MISSING", review(), gt);
  });
  it("rejects human GT text/ordered blocks that contradict one another", () => {
    const gt = groundTruth();
    gt.blocks[2]!.text = "different sentence never in canonical text";
    rejected("GROUND_TRUTH_TEXT_BLOCK_CONFLICT", review(), gt);
    const wrongMarker = groundTruth();
    wrongMarker.keyMarkers = ["not-in-human-transcript"];
    rejected("GROUND_TRUTH_MARKER_CONFLICT", review(), wrongMarker);
  });
  it("rejects inconsistent OCR-required flags and duplicate OCR pages", () => {
    const gt = groundTruth();
    gt.ocrRequired = false;
    gt.ocrRequiredPages = [0];
    rejected("GROUND_TRUTH_OCR_CONFLICT", review(), gt);
    const duplicate = groundTruth();
    duplicate.ocrRequired = true;
    duplicate.ocrRequiredPages = [0, 0];
    rejected("GROUND_TRUTH_OCR_CONFLICT", review(), duplicate);
  });
  it("allows verified native parser identities, not swapped engines or modes", () => {
    expect(() => assertNativeParserIdentity("pdfjs", "pdfjs-isolated", "pdfjs-isolated", "default", "default")).not.toThrow();
    expect(() => assertNativeParserIdentity("liteparse", "liteparse", "liteparse", "default", "default")).not.toThrow();
    expect(() => assertNativeParserIdentity("pdfjs", "liteparse", "pdfjs-isolated", "default", "default")).toThrow("PARSER_EVIDENCE_IDENTITY_MISMATCH");
    expect(() => assertNativeParserIdentity("liteparse", "liteparse", "liteparse", "ocr", "default")).toThrow("PARSER_EVIDENCE_IDENTITY_MISMATCH");
  });
  it("blocks swapped subset-page ownership and mismatched block bindings", () => {
    const sample = () => [0, 1, 2].map(pageIndex => ({ pageIndex, blocks: [{ pageIndex }] }));
    expect(() => assertSubsetPageOwnership({ pages: sample() })).not.toThrow();
    const swapped = sample(); swapped[0]!.pageIndex = 1;
    expect(() => assertSubsetPageOwnership({ pages: swapped })).toThrow("SUBSET_PAGE_INDEX_INVALID");
    const mismatched = sample(); mismatched[1]!.blocks[0]!.pageIndex = 2;
    expect(() => assertSubsetPageOwnership({ pages: mismatched })).toThrow("BLOCK_PAGE_BINDING_CONFLICT");
  });
  it("rejects invented reviewer approvals and incomplete source checks", () => {
    const r = review(); (r.reviewers as Array<Record<string, unknown>>)[0]!.confirmedAgainstOriginal = false;
    rejected("HUMAN_REVIEW_INVALID", r);
    const noFigures = review(); (noFigures.pageAudits as Array<Record<string, unknown>>)[0]!.figuresChecked = false;
    rejected("HUMAN_REVIEW_INVALID", noFigures);
  });
});
