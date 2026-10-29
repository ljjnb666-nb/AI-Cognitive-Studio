/**
 * STEP6-2A: PURE, non-authoritative OCR standard pre-admission and output
 * quality signals. No Worker wiring, DB writes, process spawns or publishing.
 *
 * The inputs below are evidence *claims* supplied by a future trusted caller.
 * This module does NOT independently prove a source hash, claim ownership or
 * host lease. Even an eligible decision never grants execution authority.
 */
import type { PdfPageInspection } from "./pdf-routing.js";
import {
  classifyOcrOutput,
  OCR_TIER_POLICY_VERSION,
  type OcrTierDecision,
  type OcrTierPolicyConfig,
  type OcrOutputSignals,
} from "./ocr-tier-policy.js";

export const OCR_STEP6_2A_POLICY_VERSION = "ocr-step6-2a-v1" as const;
export const OCR_STANDARD_EXECUTION_ADMISSION_ENV = "OCR_TIER_STANDARD_EXECUTION_ADMISSION_ENABLED" as const;

/** Conservative *admission-planning* ceilings, NOT real-time host leasing. */
export const OCR_STANDARD_MAX_RENDERED_PIXELS = 12_000_000;
export const OCR_STANDARD_MIN_AVAILABLE_MEMORY_BYTES = 2_684_354_560; // 2.5 GiB
export const OCR_QUALITY_MAX_TEXT_CHARS = 50_000;

export type Step62aConfig = OcrTierPolicyConfig & { executionAdmissionEnabled: boolean };

/**
 * Pure strict config parser; distinct from the existing MinerU runtime config.
 * Both flags must be explicitly "true" before an eligibility signal is possible.
 * It does not activate this policy anywhere in the production Worker.
 */
export function parseStep62aConfig(
  environment: Readonly<Record<string, string | undefined>>,
  tierPolicy: OcrTierPolicyConfig,
): Step62aConfig {
  const value = environment[OCR_STANDARD_EXECUTION_ADMISSION_ENV];
  if (value !== undefined && value !== "true" && value !== "false") {
    throw new Error("OCR_STEP6_2A_CONFIG_INVALID:" + OCR_STANDARD_EXECUTION_ADMISSION_ENV);
  }
  const executionAdmissionEnabled = value === "true";
  if (executionAdmissionEnabled && !tierPolicy.standardExperimentalEnabled) {
    throw new Error("OCR_STEP6_2A_EXPERIMENTAL_FLAG_REQUIRED");
  }
  return { standardExperimentalEnabled: tierPolicy.standardExperimentalEnabled, executionAdmissionEnabled };
}

/** Attestation facts must come from a trusted, independently verified source. */
export type OcrRasterEvidenceClaim = {
  physicalPageIndex: number;
  sourcePdfSha256: string;
  renderedPageSha256: string;
  sourceHashVerified: boolean;
  renderedPixels: number;
};

/** Snapshot only. Actual worker capacity must be acquired and fenced later. */
export type OcrHostCapacitySnapshot = {
  availableMemoryBytes: number;
  activeOcrClaims: number;
  maxConcurrentOcrClaims: number;
};

export const OCR_STEP6_2A_ADMISSION_REASONS = [
  "STANDARD_EXPERIMENTAL_DISABLED",
  "EXECUTION_ADMISSION_DISABLED",
  "STANDARD_TIER_NOT_PROPOSED",
  "PAGE_DECISION_MISMATCH",
  "RASTER_EVIDENCE_REQUIRED",
  "SOURCE_ATTESTATION_REQUIRED",
  "SOURCE_ATTESTATION_INVALID",
  "PIXEL_BUDGET_EXCEEDED",
  "HOST_CAPACITY_UNKNOWN",
  "HOST_CLAIMS_EXHAUSTED",
  "HOST_MEMORY_INSUFFICIENT",
  "ELIGIBLE_FOR_RUNTIME_RECHECK",
] as const;
export type OcrStep62aAdmissionReason = (typeof OCR_STEP6_2A_ADMISSION_REASONS)[number];
export type OcrStep62aAdmission = {
  policyVersion: typeof OCR_STEP6_2A_POLICY_VERSION;
  physicalPageIndex: number;
  disposition: "BLOCKED" | "DEFERRED" | "ELIGIBLE_FOR_RUNTIME_RECHECK";
  /** Always false: the caller must separately acquire leases/verify source and claims. */
  executionAuthorized: false;
  suggestedTier: "standard" | null;
  reasons: OcrStep62aAdmissionReason[];
};

function admission(
  physicalPageIndex: number,
  disposition: OcrStep62aAdmission["disposition"],
  reason: OcrStep62aAdmissionReason,
): OcrStep62aAdmission {
  return {
    policyVersion: OCR_STEP6_2A_POLICY_VERSION,
    physicalPageIndex,
    disposition,
    executionAuthorized: false,
    suggestedTier: disposition === "ELIGIBLE_FOR_RUNTIME_RECHECK" ? "standard" : null,
    reasons: [reason],
  };
}
function sha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Deliberately narrower than STEP6-1's broad OCR_STANDARD_CANDIDATE:
 * - a raster image with NO native text is required;
 * - annotation-only/vector-only or ambiguous mixed evidence is not admitted;
 * - two independent opt-in flags, source hash claims and capacity snapshot
 *   must all be present;
 * - a positive outcome is only a proposal for a future runtime recheck.
 */
export function assessStandardPreAdmission(input: {
  inspection: PdfPageInspection;
  tierDecision: OcrTierDecision;
  config: Step62aConfig;
  source: OcrRasterEvidenceClaim | null;
  host: OcrHostCapacitySnapshot | null;
}): OcrStep62aAdmission {
  const { inspection: page, tierDecision: decision, config, source, host } = input;
  const pageIndex = page.physicalPageIndex;
  if (!config.standardExperimentalEnabled) return admission(pageIndex, "BLOCKED", "STANDARD_EXPERIMENTAL_DISABLED");
  if (!config.executionAdmissionEnabled) return admission(pageIndex, "BLOCKED", "EXECUTION_ADMISSION_DISABLED");
  if (decision.tier !== "OCR_STANDARD_CANDIDATE") return admission(pageIndex, "BLOCKED", "STANDARD_TIER_NOT_PROPOSED");
  if (
    !Number.isSafeInteger(pageIndex) || pageIndex < 0 ||
    decision.policyVersion !== OCR_TIER_POLICY_VERSION ||
    decision.physicalPageIndex !== pageIndex ||
    decision.preOcrPageType !== "OCR_CANDIDATE" ||
    page.route !== "OCR_REQUIRED" || page.contentEvidence !== "NON_TEXT_CONTENT" ||
    page.hasTextEvidence || page.nativeBlockCount !== 0
  ) return admission(pageIndex, "BLOCKED", "PAGE_DECISION_MISMATCH");
  if (!page.hasImageEvidence || page.hasVectorEvidence || page.hasAnnotationEvidence) {
    return admission(pageIndex, "BLOCKED", "RASTER_EVIDENCE_REQUIRED");
  }
  if (!source || !source.sourceHashVerified) {
    return admission(pageIndex, "BLOCKED", "SOURCE_ATTESTATION_REQUIRED");
  }
  if (
    source.physicalPageIndex !== pageIndex ||
    !sha256(source.sourcePdfSha256) ||
    !sha256(source.renderedPageSha256) ||
    !positiveSafeInteger(source.renderedPixels)
  ) return admission(pageIndex, "BLOCKED", "SOURCE_ATTESTATION_INVALID");
  if (source.renderedPixels > OCR_STANDARD_MAX_RENDERED_PIXELS) {
    return admission(pageIndex, "BLOCKED", "PIXEL_BUDGET_EXCEEDED");
  }
  if (
    !host || !Number.isSafeInteger(host.availableMemoryBytes) || host.availableMemoryBytes < 0 ||
    !Number.isSafeInteger(host.activeOcrClaims) || host.activeOcrClaims < 0 ||
    !positiveSafeInteger(host.maxConcurrentOcrClaims)
  ) return admission(pageIndex, "DEFERRED", "HOST_CAPACITY_UNKNOWN");
  if (host.activeOcrClaims >= host.maxConcurrentOcrClaims) return admission(pageIndex, "DEFERRED", "HOST_CLAIMS_EXHAUSTED");
  if (host.availableMemoryBytes < OCR_STANDARD_MIN_AVAILABLE_MEMORY_BYTES) return admission(pageIndex, "DEFERRED", "HOST_MEMORY_INSUFFICIENT");
  return admission(pageIndex, "ELIGIBLE_FOR_RUNTIME_RECHECK", "ELIGIBLE_FOR_RUNTIME_RECHECK");
}

export const OCR_STEP6_2A_QUALITY_REASONS = [
  "OCR_OUTPUT_EMPTY",
  "OCR_OUTPUT_INVALID",
  "OCR_OUTPUT_TOO_LARGE",
  "CHART_LEAKAGE_SUSPECTED",
  "CHART_MARKER_NEEDS_STRUCTURAL_VERIFICATION",
  "OCR_TEXT_PRESENT_UNVERIFIED",
] as const;
export type OcrStep62aQualityReason = (typeof OCR_STEP6_2A_QUALITY_REASONS)[number];
export type OcrStep62aQuality = {
  policyVersion: typeof OCR_STEP6_2A_POLICY_VERSION;
  disposition: "REJECT_CANDIDATE" | "REVIEW_REQUIRED" | "CANDIDATE_ONLY";
  /** Never grants canonical publication or official Gold approval. */
  publicationAuthorized: false;
  reasons: OcrStep62aQualityReason[];
  signals: OcrOutputSignals | null;
};

/**
 * Structured markers are *untrusted text*, not proof a real chart was parsed.
 * Any suspicious chart output is queued for structural verification. Ordinary
 * nonempty OCR stays an UNVERIFIED candidate, never an automatic publication.
 */
export function assessOcrCandidateQuality(text: string): OcrStep62aQuality {
  const result = (
    disposition: OcrStep62aQuality["disposition"],
    reason: OcrStep62aQualityReason,
    signals: OcrOutputSignals | null = null,
  ): OcrStep62aQuality => ({
    policyVersion: OCR_STEP6_2A_POLICY_VERSION,
    disposition,
    publicationAuthorized: false,
    reasons: [reason],
    signals,
  });
  if (typeof text !== "string" || text.trim().length === 0) return result("REJECT_CANDIDATE", "OCR_OUTPUT_EMPTY");
  if (text.length > OCR_QUALITY_MAX_TEXT_CHARS) return result("REJECT_CANDIDATE", "OCR_OUTPUT_TOO_LARGE");
  if (hasDisallowedControlCharacter(text)) {
    return result("REJECT_CANDIDATE", "OCR_OUTPUT_INVALID");
  }
  const classified = classifyOcrOutput({ text });
  if (classified.postOcrPageType === "CHART_LEAKAGE_SUSPECTED") {
    return result("REVIEW_REQUIRED", "CHART_LEAKAGE_SUSPECTED", classified.signals);
  }
  if (classified.postOcrPageType === "CHART_DOMINANT") {
    return result("REVIEW_REQUIRED", "CHART_MARKER_NEEDS_STRUCTURAL_VERIFICATION", classified.signals);
  }
  return result("CANDIDATE_ONLY", "OCR_TEXT_PRESENT_UNVERIFIED", classified.signals);
}

/** Accept tab, LF and CR only; avoids regexp control-character lint hazards. */
function hasDisallowedControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}
