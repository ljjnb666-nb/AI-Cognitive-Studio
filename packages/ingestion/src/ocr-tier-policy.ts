/**
 * Deterministic OCR tier policy: page-type classification and MinerU tier
 * admission (OCR DYNAMIC TIER SLICE 1).
 *
 * Scope contract (STEP6-1):
 *  - ADDITIVE ONLY. This module never changes existing routing, executor, or
 *    configuration behaviour. MINERU_PINNED_TIER stays "flash"; standard is a
 *    CANDIDATE decision, never an execution: nothing here spawns processes,
 *    touches the database, or wires the executor seam.
 *  - Standard may enter the candidate decision ONLY through the explicit
 *    experimental switch OCR_TIER_STANDARD_EXPERIMENTAL_ENABLED (default
 *    off). With the switch off the policy answers OCR_FLASH_CANDIDATE for
 *    every OCR-routed page — byte-equivalent to today's behaviour.
 *  - Determinism: same inputs → same outputs. No timestamps, no ambient
 *    state, no randomness (matches the pdf-routing persistence contract).
 *
 * Classification honesty (2026-10-29 benchmark evidence): a scanned text page
 * (B03 p67: 0 text chars, 1 image) and a chart page (B15 p109: 0 text chars,
 * 1 image) are INDISTINGUISHABLE from pre-OCR page evidence alone. Pre-OCR
 * policy therefore separates NATIVE_TEXT / OCR_CANDIDATE / INSUFFICIENT_
 * EVIDENCE only; the SCANNED_TEXT vs CHART_DOMINANT refinement is a separate
 * deterministic POST-OCR classifier driven by structured engine output
 * signals (chart block markers, numeric-axis line leakage shape).
 */

import type { PdfPageInspection } from "./pdf-routing.js";

export const OCR_TIER_POLICY_VERSION = "ocr-tier-policy-v1";
export const OCR_PAGE_TIER_AUDIT_SCHEMA_VERSION = "ocr-page-tier-audit-v1";

/** Explicit experimental switch; absent or "false" keeps old behaviour. */
export const OCR_TIER_STANDARD_EXPERIMENTAL_ENV = "OCR_TIER_STANDARD_EXPERIMENTAL_ENABLED";

export const OCR_TIER_POLICY_REASON_CODES = [
  "NATIVE_TEXT_PRESENT",
  "OCR_ROUTE_EVIDENCE_PRESENT",
  "EMPTY_PAGE",
  "INSUFFICIENT_NATIVE_TEXT",
  "STANDARD_EXPERIMENTAL_DISABLED",
  "STANDARD_EXPERIMENTAL_ADMITTED",
] as const;
export type OcrTierPolicyReasonCode = (typeof OCR_TIER_POLICY_REASON_CODES)[number];

/** Pre-OCR page type. Chart/scanned split is intentionally deferred (see header). */
export type OcrTierPreOcrPageType = "NATIVE_TEXT" | "OCR_CANDIDATE" | "INSUFFICIENT_EVIDENCE";
/** Post-OCR refinement over an engine's actual output. */
export type OcrTierPostOcrPageType = "SCANNED_TEXT" | "CHART_DOMINANT" | "CHART_LEAKAGE_SUSPECTED" | "UNCLASSIFIED_OCR_OUTPUT";

/** Candidate tier decision. NOT an execution instruction. */
export type OcrTierDecisionTier = "NATIVE_PARSE" | "OCR_FLASH_CANDIDATE" | "OCR_STANDARD_CANDIDATE" | "NOT_OCR_CANDIDATE";

export type OcrTierPolicyConfig = { standardExperimentalEnabled: boolean };

export type OcrTierDecision = {
  policyVersion: typeof OCR_TIER_POLICY_VERSION;
  physicalPageIndex: number;
  preOcrPageType: OcrTierPreOcrPageType;
  tier: OcrTierDecisionTier;
  reasonCodes: OcrTierPolicyReasonCode[];
};

const tierConfigInvalid = "OCR_TIER_CONFIG_INVALID";

/**
 * Strict parser: the switch accepts only "true"/"false" (case-sensitive) or
 * absence. Any other value is a malformed explicit configuration and fails
 * fast — an ambiguous experimental flag must never silently mean "on".
 */
export function parseOcrTierPolicyConfig(env: Readonly<Record<string, string | undefined>>): OcrTierPolicyConfig {
  const raw = env[OCR_TIER_STANDARD_EXPERIMENTAL_ENV];
  if (raw === undefined || raw === "false") return { standardExperimentalEnabled: false };
  if (raw === "true") return { standardExperimentalEnabled: true };
  throw new Error(`${tierConfigInvalid}:${OCR_TIER_STANDARD_EXPERIMENTAL_ENV}`);
}

/**
 * Pre-OCR tier admission over the EXISTING page inspection (single source of
 * routing truth — this policy consumes, never recomputes, routing evidence).
 */
export function decideOcrTier(inspection: PdfPageInspection, config: OcrTierPolicyConfig): OcrTierDecision {
  if (inspection.hasTextEvidence) {
    return {
      policyVersion: OCR_TIER_POLICY_VERSION,
      physicalPageIndex: inspection.physicalPageIndex,
      preOcrPageType: "NATIVE_TEXT",
      tier: "NATIVE_PARSE",
      reasonCodes: ["NATIVE_TEXT_PRESENT"],
    };
  }
  if (inspection.route === "OCR_REQUIRED") {
    return {
      policyVersion: OCR_TIER_POLICY_VERSION,
      physicalPageIndex: inspection.physicalPageIndex,
      preOcrPageType: "OCR_CANDIDATE",
      tier: config.standardExperimentalEnabled ? "OCR_STANDARD_CANDIDATE" : "OCR_FLASH_CANDIDATE",
      reasonCodes: config.standardExperimentalEnabled ? ["OCR_ROUTE_EVIDENCE_PRESENT", "STANDARD_EXPERIMENTAL_ADMITTED"] : ["OCR_ROUTE_EVIDENCE_PRESENT", "STANDARD_EXPERIMENTAL_DISABLED"],
    };
  }
  return {
    policyVersion: OCR_TIER_POLICY_VERSION,
    physicalPageIndex: inspection.physicalPageIndex,
    preOcrPageType: "INSUFFICIENT_EVIDENCE",
    tier: "NOT_OCR_CANDIDATE",
    reasonCodes: inspection.reasonCodes.includes("INSUFFICIENT_NATIVE_TEXT") ? ["INSUFFICIENT_NATIVE_TEXT"] : ["EMPTY_PAGE"],
  };
}

// ---------------------------------------------------------------------------
// Post-OCR deterministic classification (SCANNED_TEXT vs CHART signals).
// ---------------------------------------------------------------------------

export const OCR_OUTPUT_CHART_MARKER = "![Chart block]";
export const OCR_OUTPUT_IMAGE_MARKER = "![Image block]";
/** Standalone numeric line ratio at which plain OCR output smells like chart leakage. */
export const OCR_CHART_LEAKAGE_NUMERIC_LINE_RATIO = 0.2;
const AXIS_TOKEN_PATTERN = /[↑→←↓]|收益率?↑|→\s*时间/;

export type OcrOutputSignals = {
  chartBlockCount: number;
  imageBlockCount: number;
  /** Ratio of non-empty lines that are standalone numbers (e.g. axis ticks "80"). */
  numericStandaloneLineRatio: number;
  axisTokensFound: boolean;
};

export type OcrOutputClassification = {
  postOcrPageType: OcrTierPostOcrPageType;
  signals: OcrOutputSignals;
};

/**
 * Deterministic post-OCR page classification over the engine's actual output:
 *  - CHART_DOMINANT: structured engine emitted at least one Chart block
 *    (MinerU standard on B15 p109 emits two + clean body text).
 *  - CHART_LEAKAGE_SUSPECTED: plain-line engines (RapidOCR on B15 p109)
 *    leak axis ticks into text — numeric standalone line ratio ≥ threshold
 *    AND axis tokens present. This is a quality-gate trigger, not a page
 *    type for publication.
 *  - SCANNED_TEXT: otherwise (B03 p67 shape).
 */
export function classifyOcrOutput(output: { text: string }): OcrOutputClassification {
  const chartBlockCount = occurrences(output.text, OCR_OUTPUT_CHART_MARKER);
  const imageBlockCount = occurrences(output.text, OCR_OUTPUT_IMAGE_MARKER);
  const lines = output.text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const numericLines = lines.filter((line) => /^[0-9]+([.,][0-9]+)?%?$/.test(line)).length;
  const numericStandaloneLineRatio = lines.length === 0 ? 0 : numericLines / lines.length;
  const axisTokensFound = AXIS_TOKEN_PATTERN.test(output.text);
  const signals: OcrOutputSignals = { chartBlockCount, imageBlockCount, numericStandaloneLineRatio, axisTokensFound };
  let postOcrPageType: OcrTierPostOcrPageType;
  if (chartBlockCount > 0) postOcrPageType = "CHART_DOMINANT";
  else if (numericStandaloneLineRatio >= OCR_CHART_LEAKAGE_NUMERIC_LINE_RATIO && axisTokensFound) postOcrPageType = "CHART_LEAKAGE_SUSPECTED";
  else postOcrPageType = lines.length === 0 ? "UNCLASSIFIED_OCR_OUTPUT" : "SCANNED_TEXT";
  return { postOcrPageType, signals };
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// Per-page tier audit record (requirement: durable record of the tier that
// ACTUALLY ran, the model identity, and the quality-judgement evidence).
// ---------------------------------------------------------------------------

export type OcrEngineExecutionFact = {
  engine: string;
  engineVersion: string;
  tier: string;
  /** SHA-256 over the ordered model manifest actually used (nullable pre-execution). */
  modelManifestSha256: string | null;
};

export type OcrPageTierAuditRecord = {
  schemaVersion: typeof OCR_PAGE_TIER_AUDIT_SCHEMA_VERSION;
  policyVersion: typeof OCR_TIER_POLICY_VERSION;
  physicalPageIndex: number;
  preOcrPageType: OcrTierPreOcrPageType;
  postOcrPageType: OcrTierPostOcrPageType | null;
  decidedTier: OcrTierDecisionTier;
  standardExperimentalEnabled: boolean;
  reasonCodes: OcrTierPolicyReasonCode[];
  engineExecution: OcrEngineExecutionFact | null;
  ocrOutputSignals: OcrOutputSignals | null;
};

/** Deterministic audit assembly: fixed key order, no timestamps, replay-safe. */
export function buildOcrPageTierAuditRecord(input: {
  decision: OcrTierDecision;
  standardExperimentalEnabled: boolean;
  postOcr?: OcrOutputClassification | null;
  engineExecution?: OcrEngineExecutionFact | null;
}): OcrPageTierAuditRecord {
  return {
    schemaVersion: OCR_PAGE_TIER_AUDIT_SCHEMA_VERSION,
    policyVersion: input.decision.policyVersion,
    physicalPageIndex: input.decision.physicalPageIndex,
    preOcrPageType: input.decision.preOcrPageType,
    postOcrPageType: input.postOcr?.postOcrPageType ?? null,
    decidedTier: input.decision.tier,
    standardExperimentalEnabled: input.standardExperimentalEnabled,
    reasonCodes: [...input.decision.reasonCodes],
    engineExecution: input.engineExecution ?? null,
    ocrOutputSignals: input.postOcr?.signals ?? null,
  };
}
