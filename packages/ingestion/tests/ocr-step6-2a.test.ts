import { describe, expect, it } from "vitest";
import { inspectPdfPage, type PdfPageEvidence } from "../src/pdf-routing.js";
import { decideOcrTier, parseOcrTierPolicyConfig, type OcrTierDecision } from "../src/ocr-tier-policy.js";
import {
  assessOcrCandidateQuality, assessStandardPreAdmission,
  OCR_QUALITY_MAX_TEXT_CHARS,
  OCR_STANDARD_MAX_RENDERED_PIXELS,
  OCR_STANDARD_MIN_AVAILABLE_MEMORY_BYTES,
  OCR_STANDARD_EXECUTION_ADMISSION_ENV,
  parseStep62aConfig,
  type OcrHostCapacitySnapshot, type OcrRasterEvidenceClaim, type Step62aConfig,
} from "../src/ocr-step6-2a.js";

const evidence = (changes: Partial<PdfPageEvidence> = {}): PdfPageEvidence => ({
  rawTextLength: 0, significantTextLength: 0, imageCount: 0,
  vectorPathCount: 0, annotationCount: 0, ...changes,
});
const raster = (physicalPageIndex = 66) => inspectPdfPage({
  physicalPageIndex, text: "", nativeBlockCount: 0, evidence: evidence({ imageCount: 1 }),
});
const native = () => inspectPdfPage({
  physicalPageIndex: 14, text: "native content", nativeBlockCount: 1,
  evidence: evidence({ rawTextLength: 14, significantTextLength: 13 }),
});
const on = parseOcrTierPolicyConfig({ OCR_TIER_STANDARD_EXPERIMENTAL_ENABLED: "true" });
const off = parseOcrTierPolicyConfig({});
const config = parseStep62aConfig({ [OCR_STANDARD_EXECUTION_ADMISSION_ENV]: "true" }, on);
const source: OcrRasterEvidenceClaim = {
  physicalPageIndex: 66, sourcePdfSha256: "a".repeat(64),
  renderedPageSha256: "b".repeat(64), sourceHashVerified: true,
  renderedPixels: 1955 * 2777,
};
const host: OcrHostCapacitySnapshot = {
  availableMemoryBytes: OCR_STANDARD_MIN_AVAILABLE_MEMORY_BYTES,
  activeOcrClaims: 0, maxConcurrentOcrClaims: 1,
};
function request(overrides: {
  inspection?: ReturnType<typeof raster>;
  tierDecision?: OcrTierDecision;
  config?: Step62aConfig;
  source?: OcrRasterEvidenceClaim | null;
  host?: OcrHostCapacitySnapshot | null;
} = {}) {
  const inspection = overrides.inspection ?? raster();
  return {
    inspection,
    tierDecision: overrides.tierDecision ?? decideOcrTier(inspection, on),
    config: overrides.config ?? config,
    source: overrides.source === undefined ? source : overrides.source,
    host: overrides.host === undefined ? host : overrides.host,
  };
}

describe("STEP6-2A: admission config default-off and strict AND", () => {
  it("defaults execution admission to OFF even when tier experiment is ON", () => {
    expect(parseStep62aConfig({}, on)).toEqual({
      standardExperimentalEnabled: true, executionAdmissionEnabled: false,
    });
    expect(parseStep62aConfig({}, off).executionAdmissionEnabled).toBe(false);
  });
  it("accepts only literal true/false and fails fast on malformed values", () => {
    for (const value of ["yes", "TRUE", "1", "", "false ", "on"]) {
      expect(() => parseStep62aConfig({ [OCR_STANDARD_EXECUTION_ADMISSION_ENV]: value }, on))
        .toThrow(/OCR_STEP6_2A_CONFIG_INVALID/);
    }
  });
  it("refuses a half-enabled execution flag when tier experiment is off", () => {
    expect(() => parseStep62aConfig({ [OCR_STANDARD_EXECUTION_ADMISSION_ENV]: "true" }, off))
      .toThrow("OCR_STEP6_2A_EXPERIMENTAL_FLAG_REQUIRED");
  });
  it("strictly disables execution-eligibility signal when any gate is OFF", () => {
    expect(assessStandardPreAdmission(request({ config: { standardExperimentalEnabled: false, executionAdmissionEnabled: false } })).reasons)
      .toEqual(["STANDARD_EXPERIMENTAL_DISABLED"]);
    expect(assessStandardPreAdmission(request({ config: parseStep62aConfig({}, on) })).reasons)
      .toEqual(["EXECUTION_ADMISSION_DISABLED"]);
  });
});

describe("STEP6-2A: conservative raster-only standard pre-admission", () => {
  it("B03 p67 may become eligible, but NEVER grants execution authority", () => {
    const result = assessStandardPreAdmission(request());
    expect(result).toMatchObject({
      physicalPageIndex: 66, disposition: "ELIGIBLE_FOR_RUNTIME_RECHECK",
      suggestedTier: "standard", executionAuthorized: false,
      reasons: ["ELIGIBLE_FOR_RUNTIME_RECHECK"],
    });
  });
  it("does not mistake a candidate from disabled STEP6-1 for real standard permission", () => {
    const page = raster();
    expect(assessStandardPreAdmission(request({ tierDecision: decideOcrTier(page, off) })).reasons)
      .toEqual(["STANDARD_TIER_NOT_PROPOSED"]);
  });
  it("B16 native page cannot receive standard pre-admission", () => {
    const page = native();
    const result = assessStandardPreAdmission(request({ inspection: page, tierDecision: decideOcrTier(page, on) }));
    expect(result.disposition).toBe("BLOCKED");
    expect(result.executionAuthorized).toBe(false);
  });
  it("B15 chart and B03 scanned page are pre-OCR indistinguishable; neither is asserted to be a text page", () => {
    const b15 = raster(108);
    const b15Source = { ...source, physicalPageIndex: 108 };
    const result = assessStandardPreAdmission(request({ inspection: b15, source: b15Source }));
    expect(result.disposition).toBe("ELIGIBLE_FOR_RUNTIME_RECHECK");
    expect(result.executionAuthorized).toBe(false);
  });
  it("rejects an annotation-only page and an image-plus-annotation page", () => {
    for (const imageCount of [0, 1]) {
      const page = inspectPdfPage({
        physicalPageIndex: 66, text: "", nativeBlockCount: 0,
        evidence: evidence({ imageCount, annotationCount: 1 }),
      });
      expect(assessStandardPreAdmission(request({ inspection: page })).reasons)
        .toEqual(["RASTER_EVIDENCE_REQUIRED"]);
    }
  });
  it("rejects vector-only and image-plus-vector evidence conservatively", () => {
    for (const imageCount of [0, 1]) {
      const page = inspectPdfPage({
        physicalPageIndex: 66, text: "", nativeBlockCount: 0,
        evidence: evidence({ imageCount, vectorPathCount: 1 }),
      });
      expect(assessStandardPreAdmission(request({ inspection: page })).disposition).toBe("BLOCKED");
    }
  });
  it("rejects a conflicting page decision or mismatched physical index", () => {
    const wrongPage = { ...source, physicalPageIndex: 65 };
    expect(assessStandardPreAdmission(request({ source: wrongPage })).reasons)
      .toEqual(["SOURCE_ATTESTATION_INVALID"]);
    const decision = { ...decideOcrTier(raster(), on), physicalPageIndex: 99 };
    expect(assessStandardPreAdmission(request({ tierDecision: decision })).reasons)
      .toEqual(["PAGE_DECISION_MISMATCH"]);
  });
  it("never accepts missing, unverified or malformed source attestation", () => {
    expect(assessStandardPreAdmission(request({ source: null })).reasons).toEqual(["SOURCE_ATTESTATION_REQUIRED"]);
    expect(assessStandardPreAdmission(request({ source: { ...source, sourceHashVerified: false } })).reasons)
      .toEqual(["SOURCE_ATTESTATION_REQUIRED"]);
    expect(assessStandardPreAdmission(request({ source: { ...source, renderedPageSha256: "not-a-hash" } })).reasons)
      .toEqual(["SOURCE_ATTESTATION_INVALID"]);
    expect(assessStandardPreAdmission(request({ source: { ...source, renderedPixels: 0 } })).disposition).toBe("BLOCKED");
  });
  it("limits page pixels, with equal-to-cap permitted", () => {
    expect(assessStandardPreAdmission(request({ source: { ...source, renderedPixels: OCR_STANDARD_MAX_RENDERED_PIXELS } })).disposition)
      .toBe("ELIGIBLE_FOR_RUNTIME_RECHECK");
    expect(assessStandardPreAdmission(request({ source: { ...source, renderedPixels: OCR_STANDARD_MAX_RENDERED_PIXELS + 1 } })).reasons)
      .toEqual(["PIXEL_BUDGET_EXCEEDED"]);
  });
  it("defers rather than granting permission for unknown or malformed host capacity", () => {
    expect(assessStandardPreAdmission(request({ host: null })).reasons).toEqual(["HOST_CAPACITY_UNKNOWN"]);
    expect(assessStandardPreAdmission(request({ host: { ...host, activeOcrClaims: -1 } })).disposition).toBe("DEFERRED");
    expect(assessStandardPreAdmission(request({ host: { ...host, maxConcurrentOcrClaims: 0 } })).disposition).toBe("DEFERRED");
  });
  it("defers on exhausted host claims, without touching leases", () => {
    const result = assessStandardPreAdmission(request({ host: { ...host, activeOcrClaims: 1 } }));
    expect(result).toMatchObject({ disposition: "DEFERRED", reasons: ["HOST_CLAIMS_EXHAUSTED"], executionAuthorized: false });
  });
  it("defers with memory less than the reservation threshold", () => {
    expect(assessStandardPreAdmission(request({ host: { ...host, availableMemoryBytes: OCR_STANDARD_MIN_AVAILABLE_MEMORY_BYTES - 1 } })).reasons)
      .toEqual(["HOST_MEMORY_INSUFFICIENT"]);
  });
  it("returns identical, JSON-stable and timestamp-free results for replay", () => {
    const a = assessStandardPreAdmission(request());
    const b = assessStandardPreAdmission(request());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toContain("timestamp");
  });
});

describe("STEP6-2A: OCR output quality can NEVER grant publication", () => {
  it("rejects empty and whitespace-only candidate output", () => {
    expect(assessOcrCandidateQuality(" \n  ").disposition).toBe("REJECT_CANDIDATE");
    expect(assessOcrCandidateQuality("").publicationAuthorized).toBe(false);
  });
  it("rejects NUL/control characters and exceeds-text-limit", () => {
    expect(assessOcrCandidateQuality("abc\0def").reasons).toEqual(["OCR_OUTPUT_INVALID"]);
    expect(assessOcrCandidateQuality("a".repeat(OCR_QUALITY_MAX_TEXT_CHARS + 1)).reasons).toEqual(["OCR_OUTPUT_TOO_LARGE"]);
  });
  it("B03 ordinary OCR remains an unverified candidate, not automatically ACCEPTED", () => {
    const result = assessOcrCandidateQuality("第一章 这是一段扫描文本。\n第二段");
    expect(result).toMatchObject({ disposition: "CANDIDATE_ONLY", publicationAuthorized: false, reasons: ["OCR_TEXT_PRESENT_UNVERIFIED"] });
  });
  it("B15 RapidOCR axis-tick leakage requires review, despite nonempty text", () => {
    const text = "部分正文\n收益↑\n→ 时间\n0\n100\n80\n60\n40\n图注";
    expect(assessOcrCandidateQuality(text)).toMatchObject({
      disposition: "REVIEW_REQUIRED", publicationAuthorized: false, reasons: ["CHART_LEAKAGE_SUSPECTED"],
    });
  });
  it("even genuine-looking MinerU chart Markdown is an untrusted marker needing verification", () => {
    const text = "正文\n![Chart block](fake:untrusted)\n图注";
    expect(assessOcrCandidateQuality(text)).toMatchObject({
      disposition: "REVIEW_REQUIRED", publicationAuthorized: false,
      reasons: ["CHART_MARKER_NEEDS_STRUCTURAL_VERIFICATION"],
    });
  });
  it("an arrow in ordinary prose alone is not enough to reject the candidate", () => {
    const result = assessOcrCandidateQuality("这是一段A→B的普通叙述。\n第二段正常正文。");
    expect(result.disposition).toBe("CANDIDATE_ONLY");
    expect(result.publicationAuthorized).toBe(false);
  });
  it("deterministic output signals are derived from the text, not caller-provided claims", () => {
    const text = "![Chart block](somewhere)\n100";
    expect(assessOcrCandidateQuality(text)).toEqual(assessOcrCandidateQuality(text));
  });
});
