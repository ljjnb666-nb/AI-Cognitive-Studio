/**
 * Deterministic PDF page inspection, routing, and extraction quality
 * (BOOK-INGESTION-04B-2).
 *
 * This module is the routing authority for PDF ingestion. It is deliberately
 * pure: no process execution, no database, no storage. The isolated PDF.js
 * child emits per-page CONTENT EVIDENCE; this module turns that evidence into
 * a page-native inspection, a versioned routing plan, and — after extraction —
 * a deterministic quality decision. 04B-3 plugs the real MinerU executor into
 * the PdfOcrExecutor seam defined here; nothing in this module knows MinerU.
 *
 * Determinism contract: every persisted shape (routing plan, routing outcome,
 * quality decision) is built with fixed key order from the evidence alone —
 * no timestamps, no random ids, no ambient state.
 */

import type { ExtractionQualityWarningCode } from "@ai-cognitive/domain";

export const PDF_ROUTING_PLAN_SCHEMA_VERSION = "pdf-routing-plan-v1";
export const PDF_ROUTING_OUTCOME_SCHEMA_VERSION = "pdf-routing-outcome-v1";
export const PDF_INSPECTOR_VERSION = "pdf-inspector-v1";
/**
 * The routing generation recorded with the write-once routing plan. The plan
 * is written exactly once per run (writeRoutingPlan fails on any second
 * write), so this constant is the only generation 04B-2 ever persists.
 */
export const PDF_ROUTING_GENERATION = 1;
/**
 * Extraction-level parser identity for quality-gated PDF publications. The
 * native engine identity (pdfjs-isolated / pdf-isolation-v3) is preserved
 * separately: it stays the per-block provenance of native pages and the
 * parser identity inside the routing plan.
 */
export const PDF_EXTRACTION_PARSER = { name: "pdfjs-isolated", version: "pdf-router-v1" } as const;

/** Stable typed routing reason codes — never prose. */
export const PDF_ROUTING_REASON_CODES = [
  "NATIVE_TEXT_PRESENT",
  "IMAGE_CONTENT_WITHOUT_TEXT",
  "VECTOR_CONTENT_WITHOUT_TEXT",
  "ANNOTATION_CONTENT_WITHOUT_TEXT",
  "EMPTY_PAGE",
  "INSUFFICIENT_NATIVE_TEXT",
] as const;
export type PdfRoutingReasonCode = (typeof PDF_ROUTING_REASON_CODES)[number];

export type PdfPageRoute = "NATIVE_TEXT" | "OCR_REQUIRED";
export type PdfContentEvidence = "TEXT" | "NON_TEXT_CONTENT" | "EMPTY";

/** Raw per-page evidence emitted by the isolated PDF.js child. */
export type PdfPageEvidence = {
  /** Length of the concatenated text items, including whitespace. */
  rawTextLength: number;
  /** Length after removing all whitespace: the text-evidence signal. */
  significantTextLength: number;
  /** paintImageXObject / paintInlineImageXObject / paintImageMaskXObject count. */
  imageCount: number;
  /** constructPath occurrence count (args-shape-agnostic on purpose). */
  vectorPathCount: number;
  /**
   * Annotation dictionary count for the page. CONSERVATIVE LIMITATION (RF01
   * P2): pdfjs does not expose appearance-stream presence deterministically
   * across annotation subtypes, so every annotation dictionary counts as
   * content evidence. This can only over-require OCR, never silently drop a
   * meaningful annotation-only page — the 04B-0 invariant is preserved.
   */
  annotationCount: number;
};

export type PdfPageInspection = {
  physicalPageIndex: number;
  nativeTextCharacterCount: number;
  nativeBlockCount: number;
  hasTextEvidence: boolean;
  hasImageEvidence: boolean;
  hasVectorEvidence: boolean;
  hasAnnotationEvidence: boolean;
  contentEvidence: PdfContentEvidence;
  route: PdfPageRoute;
  reasonCodes: PdfRoutingReasonCode[];
};

export type PdfRoutingPlanPage = {
  physicalPageIndex: number;
  route: PdfPageRoute;
  contentEvidence: PdfContentEvidence;
  reasonCodes: PdfRoutingReasonCode[];
};

export type PdfRoutingPlan = {
  schemaVersion: typeof PDF_ROUTING_PLAN_SCHEMA_VERSION;
  inspector: { version: string };
  parser: { name: string; version: string };
  pageCount: number;
  pages: PdfRoutingPlanPage[];
};

/**
 * Inspects one page from its text and child evidence. A zero-text page is NOT
 * automatically empty: image/vector/annotation evidence makes it
 * NON_TEXT_CONTENT (OCR_REQUIRED), while a page with no evidence at all is an
 * explicit EMPTY page that stays on the native route.
 *
 * Native text authority (RF01 P1-05): raw child text alone never authorizes
 * the TEXT classification. A page is trustworthy native text only when the
 * canonical block path used for publication actually produced usable blocks
 * (nativeBlockCount > 0) — raw signal that canonicalizes to zero blocks is
 * recorded as INSUFFICIENT_NATIVE_TEXT and can never count as usable content.
 */
export function inspectPdfPage(input: { physicalPageIndex: number; text: string; nativeBlockCount: number; evidence: PdfPageEvidence }): PdfPageInspection {
  const hasRawTextSignal = input.evidence.significantTextLength > 0;
  const hasTextEvidence = hasRawTextSignal && input.nativeBlockCount > 0;
  const hasImageEvidence = input.evidence.imageCount > 0;
  const hasVectorEvidence = input.evidence.vectorPathCount > 0;
  const hasAnnotationEvidence = input.evidence.annotationCount > 0;
  const contentEvidence: PdfContentEvidence = hasTextEvidence ? "TEXT" : hasImageEvidence || hasVectorEvidence || hasAnnotationEvidence ? "NON_TEXT_CONTENT" : "EMPTY";
  const route: PdfPageRoute = contentEvidence === "NON_TEXT_CONTENT" ? "OCR_REQUIRED" : "NATIVE_TEXT";
  const reasonCodes: PdfRoutingReasonCode[] = [];
  if (hasTextEvidence) reasonCodes.push("NATIVE_TEXT_PRESENT");
  if (!hasTextEvidence && input.evidence.rawTextLength > 0) reasonCodes.push("INSUFFICIENT_NATIVE_TEXT");
  if (hasImageEvidence && !hasTextEvidence) reasonCodes.push("IMAGE_CONTENT_WITHOUT_TEXT");
  if (hasVectorEvidence && !hasTextEvidence) reasonCodes.push("VECTOR_CONTENT_WITHOUT_TEXT");
  if (hasAnnotationEvidence && !hasTextEvidence) reasonCodes.push("ANNOTATION_CONTENT_WITHOUT_TEXT");
  if (contentEvidence === "EMPTY") reasonCodes.push("EMPTY_PAGE");
  return {
    physicalPageIndex: input.physicalPageIndex,
    nativeTextCharacterCount: input.evidence.rawTextLength,
    nativeBlockCount: input.nativeBlockCount,
    hasTextEvidence,
    hasImageEvidence,
    hasVectorEvidence,
    hasAnnotationEvidence,
    contentEvidence,
    route,
    reasonCodes,
  };
}

/** Builds the versioned routing plan from page inspections, in physical order. */
export function planPdfRouting(input: { parser: { name: string; version: string }; inspections: PdfPageInspection[] }): PdfRoutingPlan {
  return {
    schemaVersion: PDF_ROUTING_PLAN_SCHEMA_VERSION,
    inspector: { version: PDF_INSPECTOR_VERSION },
    parser: { name: input.parser.name, version: input.parser.version },
    pageCount: input.inspections.length,
    pages: input.inspections.map((inspection) => ({ physicalPageIndex: inspection.physicalPageIndex, route: inspection.route, contentEvidence: inspection.contentEvidence, reasonCodes: [...inspection.reasonCodes] })),
  };
}

const routingPlanContractInvalid = "SOURCE_ROUTING_PLAN_CONTRACT_INVALID";
const routingPlanConflict = "SOURCE_ROUTING_PLAN_CONFLICT";

/** Strict structural validation of a persisted routing plan (replay path). */
export function parseRoutingPlan(value: unknown): PdfRoutingPlan {
  const plan = value as PdfRoutingPlan | null;
  if (!plan || typeof plan !== "object") throw new Error(routingPlanContractInvalid);
  if (plan.schemaVersion !== PDF_ROUTING_PLAN_SCHEMA_VERSION) throw new Error(routingPlanContractInvalid);
  if (!plan.inspector || plan.inspector.version !== PDF_INSPECTOR_VERSION) throw new Error(routingPlanContractInvalid);
  if (!plan.parser || typeof plan.parser.name !== "string" || typeof plan.parser.version !== "string") throw new Error(routingPlanContractInvalid);
  if (!Number.isSafeInteger(plan.pageCount) || plan.pageCount < 1) throw new Error(routingPlanContractInvalid);
  if (!Array.isArray(plan.pages) || plan.pages.length !== plan.pageCount) throw new Error(routingPlanContractInvalid);
  const routes = new Set<PdfPageRoute>(["NATIVE_TEXT", "OCR_REQUIRED"]);
  const evidences = new Set<PdfContentEvidence>(["TEXT", "NON_TEXT_CONTENT", "EMPTY"]);
  plan.pages.forEach((page, index) => {
    if (page.physicalPageIndex !== index) throw new Error(routingPlanContractInvalid);
    if (!routes.has(page.route)) throw new Error(routingPlanContractInvalid);
    if (!evidences.has(page.contentEvidence)) throw new Error(routingPlanContractInvalid);
    if (!Array.isArray(page.reasonCodes) || page.reasonCodes.some((code) => !PDF_ROUTING_REASON_CODES.includes(code))) throw new Error(routingPlanContractInvalid);
  });
  return plan;
}

/**
 * Replay fence (04B-2 §14): a redelivery must reuse the persisted immutable
 * plan. Runtime inspection is deterministic from the immutable source bytes,
 * so any divergence is an internal contract break — fail closed, never patch
 * persisted history.
 */
export function assertRoutingPlanReplay(persisted: PdfRoutingPlan, runtime: PdfRoutingPlan): void {
  if (persisted.parser.name !== runtime.parser.name || persisted.parser.version !== runtime.parser.version) throw new Error(routingPlanConflict);
  if (persisted.inspector.version !== runtime.inspector.version) throw new Error(routingPlanConflict);
  if (persisted.pageCount !== runtime.pageCount) throw new Error(routingPlanConflict);
  for (const [index, page] of runtime.pages.entries()) {
    const recorded = persisted.pages[index];
    if (!recorded || recorded.physicalPageIndex !== page.physicalPageIndex || recorded.route !== page.route || recorded.contentEvidence !== page.contentEvidence || recorded.reasonCodes.join(",") !== page.reasonCodes.join(",")) throw new Error(routingPlanConflict);
  }
}

// ---------------------------------------------------------------------------
// OCR executor seam. The router owns the abstraction; MinerU is only one
// future implementation and must never be named here.
// ---------------------------------------------------------------------------

export type PdfOcrExecutorDescriptor = { name: string; version: string; parserMode?: string | null; modelRevision?: string | null };
export type PdfOcrPageRequest = { ingestionRunId: string; workspaceId: string; sourceDocumentId: string; physicalPageIndex: number; routingGeneration: number; pdfBytes: Uint8Array };
export type PdfOcrPageResult =
  | { status: "SUCCEEDED"; text: string }
  | { status: "FAILED"; errorCode: string; kind: "transient" | "terminal"; nextAttemptAt?: Date };

export interface PdfOcrExecutor {
  readonly descriptor: PdfOcrExecutorDescriptor;
  extractPage(request: PdfOcrPageRequest): Promise<PdfOcrPageResult>;
}

// ---------------------------------------------------------------------------
// Extraction quality gate.
// ---------------------------------------------------------------------------

export type PdfPageExtractionOutcome = "NATIVE_TEXT" | "OCR_FALLBACK" | "EMPTY" | "UNRESOLVED_FALLBACK";

export const PDF_QUALITY_REASON_CODES = ["OCR_FALLBACK_USED", "UNRESOLVED_FALLBACK_PAGE", "NO_USABLE_CONTENT"] as const;
export type PdfQualityReasonCode = (typeof PDF_QUALITY_REASON_CODES)[number];

export type PdfExtractionQualityStatus = "ACCEPTED" | "DEGRADED" | "REQUIRES_FALLBACK" | "REJECTED";

export type PdfPageQualityDecision = { physicalPageIndex: number; route: PdfPageRoute; outcome: PdfPageExtractionOutcome; reasonCodes: PdfRoutingReasonCode[] };

export type PdfExtractionQualityDecision = {
  status: PdfExtractionQualityStatus;
  reasonCodes: PdfQualityReasonCode[];
  pageDecisions: PdfPageQualityDecision[];
  /** Typed, evidence-backed warnings for DocumentExtraction.qualityMetadata. */
  qualityWarnings: ExtractionQualityWarningCode[];
};

/**
 * Deterministic PDF publication quality decision:
 *  - REJECTED: no usable content at all (every page empty, or no pages).
 *  - REQUIRES_FALLBACK: a non-empty page still lacks an authoritative result.
 *  - DEGRADED: complete and publishable, but OCR fallback content was used.
 *  - ACCEPTED: every non-empty page carries authoritative native content.
 *
 * RF01 hardening: an outcome label alone never manufactures usability. The
 * caller must pass the authoritative usable canonical block count per page
 * (derived from the exact block arrays that would be persisted); a page
 * labeled NATIVE_TEXT/OCR_FALLBACK with zero such blocks fails closed to
 * UNRESOLVED_FALLBACK. No successful PDF publication may contain a required
 * non-empty page with zero authoritative usable content.
 */
export function evaluatePdfExtractionQuality(plan: PdfRoutingPlan, outcomes: Map<number, PdfPageExtractionOutcome>, usableBlockCounts: Map<number, number>): PdfExtractionQualityDecision {
  const pageDecisions: PdfPageQualityDecision[] = plan.pages.map((page) => {
    const labeled = outcomes.get(page.physicalPageIndex) ?? "UNRESOLVED_FALLBACK";
    const usableBlocks = usableBlockCounts.get(page.physicalPageIndex) ?? 0;
    const outcome: PdfPageExtractionOutcome = (labeled === "NATIVE_TEXT" || labeled === "OCR_FALLBACK") && usableBlocks < 1 ? "UNRESOLVED_FALLBACK" : labeled;
    return { physicalPageIndex: page.physicalPageIndex, route: page.route, outcome, reasonCodes: [...page.reasonCodes] };
  });
  const unresolved = pageDecisions.filter((page) => page.outcome === "UNRESOLVED_FALLBACK");
  const ocrUsed = pageDecisions.some((page) => page.outcome === "OCR_FALLBACK");
  const hasUsableContent = pageDecisions.some((page) => page.outcome === "NATIVE_TEXT" || page.outcome === "OCR_FALLBACK");
  if (!hasUsableContent) return { status: "REJECTED", reasonCodes: ["NO_USABLE_CONTENT"], pageDecisions, qualityWarnings: [] };
  if (unresolved.length > 0) return { status: "REQUIRES_FALLBACK", reasonCodes: ["UNRESOLVED_FALLBACK_PAGE"], pageDecisions, qualityWarnings: [] };
  if (ocrUsed) return { status: "DEGRADED", reasonCodes: ["OCR_FALLBACK_USED"], pageDecisions, qualityWarnings: ["OCR_USED"] };
  return { status: "ACCEPTED", reasonCodes: [], pageDecisions, qualityWarnings: [] };
}

// ---------------------------------------------------------------------------
// Routing outcome (one-way terminal record for the run's routing decision).
// ---------------------------------------------------------------------------

export type PdfRoutingOutcome = {
  schemaVersion: typeof PDF_ROUTING_OUTCOME_SCHEMA_VERSION;
  outcome: "PUBLISHED" | "REQUIRES_FALLBACK" | "REJECTED";
  qualityStatus: PdfExtractionQualityStatus;
  unresolvedPhysicalPageIndexes: number[];
};

export function pdfRoutingOutcome(decision: PdfExtractionQualityDecision, published: boolean): PdfRoutingOutcome {
  const outcome: PdfRoutingOutcome = {
    schemaVersion: PDF_ROUTING_OUTCOME_SCHEMA_VERSION,
    outcome: published ? "PUBLISHED" : decision.status === "REJECTED" ? "REJECTED" : "REQUIRES_FALLBACK",
    qualityStatus: decision.status,
    unresolvedPhysicalPageIndexes: decision.pageDecisions.filter((page) => page.outcome === "UNRESOLVED_FALLBACK").map((page) => page.physicalPageIndex),
  };
  return outcome;
}
