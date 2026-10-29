import { describe, expect, it } from "vitest";
import { MINERU_PINNED_TIER } from "../src/mineru/mineru-commands.js";
import { inspectPdfPage, type PdfPageEvidence } from "../src/pdf-routing.js";
import {
  buildOcrPageTierAuditRecord,
  classifyOcrOutput,
  decideOcrTier,
  OCR_PAGE_TIER_AUDIT_SCHEMA_VERSION,
  OCR_TIER_POLICY_REASON_CODES,
  OCR_TIER_POLICY_VERSION,
  OCR_TIER_STANDARD_EXPERIMENTAL_ENV,
  parseOcrTierPolicyConfig,
} from "../src/ocr-tier-policy.js";

// ---------------------------------------------------------------------------
// Fixtures carry the REAL per-page evidence shapes measured in the
// 2026-10-29 five-book benchmark (benchmark-round2-20261029/provenance_pages.json).
// ---------------------------------------------------------------------------

const evidence = (overrides: Partial<PdfPageEvidence> = {}): PdfPageEvidence => ({
  rawTextLength: 0,
  significantTextLength: 0,
  imageCount: 0,
  vectorPathCount: 0,
  annotationCount: 0,
  ...overrides,
});

/** B16 p15: native text page — 707 text-layer chars, canonical blocks present. */
const b16NativeInspection = inspectPdfPage({
  physicalPageIndex: 14,
  text: "x".repeat(707),
  nativeBlockCount: 6,
  evidence: evidence({ rawTextLength: 707, significantTextLength: 707 }),
});

/** B03 p67 / B08 p64: scanned text page — zero text layer, one full-page image. */
const b03ScannedInspection = inspectPdfPage({
  physicalPageIndex: 66,
  text: "",
  nativeBlockCount: 0,
  evidence: evidence({ imageCount: 1 }),
});

/** B15 p109 PRE-OCR evidence is IDENTICAL to a scanned text page — proven by the benchmark. */
const b15ChartPreOcrInspection = inspectPdfPage({
  physicalPageIndex: 108,
  text: "",
  nativeBlockCount: 0,
  evidence: evidence({ imageCount: 1 }),
});

const configOff = parseOcrTierPolicyConfig({});
const configOn = parseOcrTierPolicyConfig({ [OCR_TIER_STANDARD_EXPERIMENTAL_ENV]: "true" });

// Real engine-output shapes (trimmed from the benchmark candidates).
const B03_P67_PLAIN_OCR = "实际上，焦虑是人体机体的一种应激本能。一定程度的焦虑，可以调\n动机体的生理防御功能，使人的心智活动增强，有利于摆脱困境。";
const B15_P109_RAPIDOCR_LEAKAGE = "命周期。每一个行业的发展都符合这条曲线所描述的情况（图\n1-4-15)，会经历上升的曙光期、快速上升的朝阳期、平稳发\n展的成熟期，以及之后的衰退期。\n收益↑\n曙光期朝阳期\n成熟期\n衰退期\n→ 时间\n0\n图 1-4-15\n100\n80\n60\n40";
const B15_P109_MINERU_MD = "命周期。每一个行业的发展都符合这条曲线所描述的情况（图1-4-15），会经历上升的曙光期。\n\n![Chart block](doc:58701b3/tier:standard/page:1/block:5)\n\n图1-4-16";

describe("ocr tier policy: compatibility invariants (slice 1)", () => {
  it("keeps MINERU_PINNED_TIER at flash — dynamic routing must not be faked by editing the pin", () => {
    expect(MINERU_PINNED_TIER).toBe("flash");
  });

  it("defaults the experimental standard switch to off and keeps behaviour byte-equivalent", () => {
    expect(configOff.standardExperimentalEnabled).toBe(false);
    expect(parseOcrTierPolicyConfig({ [OCR_TIER_STANDARD_EXPERIMENTAL_ENV]: "false" })).toEqual(configOff);
  });

  it("fails fast on malformed explicit switch values instead of guessing", () => {
    for (const bad of ["1", "TRUE", "yes", "on", ""]) {
      expect(() => parseOcrTierPolicyConfig({ [OCR_TIER_STANDARD_EXPERIMENTAL_ENV]: bad })).toThrowError(/OCR_TIER_CONFIG_INVALID/);
    }
  });
});

describe("ocr tier policy: pre-OCR decisions over real page shapes", () => {
  it("B16 native page stays on NATIVE_PARSE regardless of the standard switch", () => {
    for (const config of [configOff, configOn]) {
      const decision = decideOcrTier(b16NativeInspection, config);
      expect(decision).toMatchObject({ preOcrPageType: "NATIVE_TEXT", tier: "NATIVE_PARSE" });
      expect(decision.reasonCodes).toEqual(["NATIVE_TEXT_PRESENT"]);
    }
  });

  it("B03 scanned page: flash candidate by default; standard candidate only with the explicit switch", () => {
    expect(decideOcrTier(b03ScannedInspection, configOff)).toMatchObject({ preOcrPageType: "OCR_CANDIDATE", tier: "OCR_FLASH_CANDIDATE" });
    const on = decideOcrTier(b03ScannedInspection, configOn);
    expect(on.tier).toBe("OCR_STANDARD_CANDIDATE");
    expect(on.reasonCodes).toEqual(["OCR_ROUTE_EVIDENCE_PRESENT", "STANDARD_EXPERIMENTAL_ADMITTED"]);
  });

  it("B15 chart page is indistinguishable from scanned text PRE-OCR (documented boundary), never misrouted as native", () => {
    const decision = decideOcrTier(b15ChartPreOcrInspection, configOff);
    expect(decision.preOcrPageType).toBe("OCR_CANDIDATE");
    expect(decision.tier).toBe("OCR_FLASH_CANDIDATE");
  });

  it("empty page and raw-text-without-blocks page are NOT_OCR_CANDIDATE with typed reasons", () => {
    const empty = inspectPdfPage({ physicalPageIndex: 0, text: "", nativeBlockCount: 0, evidence: evidence() });
    expect(decideOcrTier(empty, configOn)).toMatchObject({ preOcrPageType: "INSUFFICIENT_EVIDENCE", tier: "NOT_OCR_CANDIDATE", reasonCodes: ["EMPTY_PAGE"] });
    const insufficient = inspectPdfPage({ physicalPageIndex: 1, text: "raw", nativeBlockCount: 0, evidence: evidence({ rawTextLength: 3, significantTextLength: 3 }) });
    expect(decideOcrTier(insufficient, configOff)).toMatchObject({ tier: "NOT_OCR_CANDIDATE", reasonCodes: ["INSUFFICIENT_NATIVE_TEXT"] });
  });

  it("annotation-only page still reaches the OCR candidate path (04B-0 invariant preserved)", () => {
    const page = inspectPdfPage({ physicalPageIndex: 2, text: "", nativeBlockCount: 0, evidence: evidence({ annotationCount: 1 }) });
    expect(decideOcrTier(page, configOff).tier).toBe("OCR_FLASH_CANDIDATE");
  });

  it("is deterministic: identical inputs produce deeply equal decisions", () => {
    expect(decideOcrTier(b03ScannedInspection, configOn)).toEqual(decideOcrTier(b03ScannedInspection, configOn));
  });
});

describe("ocr tier policy: post-OCR chart classification over real engine outputs", () => {
  it("classifies B03 p67 plain OCR body text as SCANNED_TEXT", () => {
    expect(classifyOcrOutput({ text: B03_P67_PLAIN_OCR }).postOcrPageType).toBe("SCANNED_TEXT");
  });

  it("detects B15 p109 chart leakage shape in plain-line OCR output (quality-gate trigger)", () => {
    const result = classifyOcrOutput({ text: B15_P109_RAPIDOCR_LEAKAGE });
    expect(result.postOcrPageType).toBe("CHART_LEAKAGE_SUSPECTED");
    expect(result.signals.numericStandaloneLineRatio).toBeGreaterThanOrEqual(0.2);
    expect(result.signals.axisTokensFound).toBe(true);
  });

  it("classifies B15 p109 structured MinerU output as CHART_DOMINANT via Chart block markers", () => {
    const result = classifyOcrOutput({ text: B15_P109_MINERU_MD });
    expect(result.postOcrPageType).toBe("CHART_DOMINANT");
    expect(result.signals.chartBlockCount).toBe(1);
  });

  it("numeric lines WITHOUT axis tokens do not trigger the leakage heuristic", () => {
    const numbered = "第一章\n第二章\n第三章\n第四章\n1\n2\n3\n4\n5";
    expect(classifyOcrOutput({ text: numbered }).postOcrPageType).toBe("SCANNED_TEXT");
  });

  it("empty OCR output is UNCLASSIFIED, never guessed", () => {
    expect(classifyOcrOutput({ text: "  \n \n" }).postOcrPageType).toBe("UNCLASSIFIED_OCR_OUTPUT");
  });
});

describe("ocr tier policy: per-page audit record", () => {
  it("records decision + real execution facts + output signals with fixed key order and no timestamps", () => {
    const decision = decideOcrTier(b03ScannedInspection, configOn);
    const postOcr = classifyOcrOutput({ text: B03_P67_PLAIN_OCR });
    const record = buildOcrPageTierAuditRecord({
      decision,
      standardExperimentalEnabled: true,
      postOcr,
      engineExecution: { engine: "mineru", engineVersion: "4.0.3", tier: "standard", modelManifestSha256: "a".repeat(64) },
    });
    expect(record.schemaVersion).toBe(OCR_PAGE_TIER_AUDIT_SCHEMA_VERSION);
    expect(record.policyVersion).toBe(OCR_TIER_POLICY_VERSION);
    expect(record).toEqual({
      schemaVersion: OCR_PAGE_TIER_AUDIT_SCHEMA_VERSION,
      policyVersion: OCR_TIER_POLICY_VERSION,
      physicalPageIndex: 66,
      preOcrPageType: "OCR_CANDIDATE",
      postOcrPageType: "SCANNED_TEXT",
      decidedTier: "OCR_STANDARD_CANDIDATE",
      standardExperimentalEnabled: true,
      reasonCodes: ["OCR_ROUTE_EVIDENCE_PRESENT", "STANDARD_EXPERIMENTAL_ADMITTED"],
      engineExecution: { engine: "mineru", engineVersion: "4.0.3", tier: "standard", modelManifestSha256: "a".repeat(64) },
      ocrOutputSignals: postOcr.signals,
    });
    expect(Object.keys(record)).not.toContain("timestamp");
    expect(JSON.stringify(record)).toBe(JSON.stringify(buildOcrPageTierAuditRecord({ decision, standardExperimentalEnabled: true, postOcr, engineExecution: { engine: "mineru", engineVersion: "4.0.3", tier: "standard", modelManifestSha256: "a".repeat(64) } })));
  });

  it("leaves execution facts null pre-execution (decision-only records are valid)", () => {
    const record = buildOcrPageTierAuditRecord({ decision: decideOcrTier(b16NativeInspection, configOff), standardExperimentalEnabled: false });
    expect(record.engineExecution).toBeNull();
    expect(record.ocrOutputSignals).toBeNull();
    expect(record.postOcrPageType).toBeNull();
  });

  it("exposes only typed reason codes", () => {
    const record = buildOcrPageTierAuditRecord({ decision: decideOcrTier(b03ScannedInspection, configOff), standardExperimentalEnabled: false });
    for (const code of record.reasonCodes) expect(OCR_TIER_POLICY_REASON_CODES).toContain(code);
  });
});
