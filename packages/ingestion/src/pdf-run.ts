import { prisma } from "@ai-cognitive/db";
import { sha256Utf8 } from "@ai-cognitive/domain";
import type { StorageProvider } from "@ai-cognitive/storage";
import { extractNativePdf, pdfTextToBlocks, type Parsed, type ParserLimits } from "./document-parsers.js";
import { INGESTION_EXECUTION_OWNERSHIP_LOST } from "./ingestion-run-claim.js";
import { claimOcrPageAttempt, completeOcrPageAttempt, createOcrPageIntents, failOcrPageAttempt, writeRoutingPlan, writeRoutingOutcome } from "./ocr-durability.js";
import { PDF_EXTRACTION_PARSER, PDF_ROUTING_GENERATION, assertRoutingPlanReplay, evaluatePdfExtractionQuality, parseRoutingPlan, type PdfExtractionQualityDecision, type PdfOcrExecutor, type PdfOcrPageResult, type PdfPageExtractionOutcome, type PdfRoutingOutcome, type PdfRoutingPlan } from "./pdf-routing.js";
import { SourceError } from "./source-errors.js";

/**
 * PDF run extraction pipeline (BOOK-INGESTION-04B-2).
 *
 * Orchestrates one execution claim over the durable routing primitives:
 * native inspection → write-once routing plan (or replay-validated reuse) →
 * durable OCR page intents/attempts through the PdfOcrExecutor seam → merged
 * page-level canonical result → deterministic quality decision. It NEVER
 * publishes by itself: the ingestion service owns the publication transaction.
 *
 * Production default in 04B-2 has no OCR executor: OCR-required pages then end
 * in the existing OCR_REQUIRED terminal semantics with the durable routing
 * intent persisted. The real MinerU executor (04B-3) plugs in unchanged.
 */

export type PdfRunExtractionInput = {
  runId: string;
  workspaceId: string;
  sourceDocumentId: string;
  /** Persisted IngestionRun.routingPlan (null on first execution). */
  persistedRoutingPlan: unknown;
  /** Persisted IngestionRun.routingGeneration (null on first execution). */
  persistedRoutingGeneration: number | null;
  pdfBytes: Uint8Array;
  limits: ParserLimits;
  storage: StorageProvider;
  /** Absent in 04B-2 production; tests inject fake executors. */
  executor?: PdfOcrExecutor;
  /** Observed execution-lease loss — checked before every durable write. */
  ownershipLost: () => boolean;
};

export type PdfRunExtraction =
  | { kind: "PUBLISH"; parsed: Parsed; routingPlan: PdfRoutingPlan; routingGeneration: number; decision: PdfExtractionQualityDecision }
  | { kind: "OCR_REQUIRED"; routingPlan: PdfRoutingPlan; routingGeneration: number; decision: PdfExtractionQualityDecision }
  | { kind: "REJECTED"; routingPlan: PdfRoutingPlan; routingGeneration: number; decision: PdfExtractionQualityDecision };

export async function runPdfExtraction(input: PdfRunExtractionInput): Promise<PdfRunExtraction> {
  const native = await extractNativePdf(input.pdfBytes, input.limits);
  const generation = input.persistedRoutingGeneration ?? PDF_ROUTING_GENERATION;

  // Routing plan replay fence: a persisted plan is immutable history — reuse
  // it when it matches deterministic re-inspection, fail closed otherwise.
  let plan: PdfRoutingPlan;
  if (input.persistedRoutingPlan != null) {
    plan = parseRoutingPlan(input.persistedRoutingPlan);
    assertRoutingPlanReplay(plan, native.routingPlan);
  } else {
    plan = native.routingPlan;
    if (!await writeRoutingPlan(input.runId, generation, plan)) {
      const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: input.runId }, select: { routingPlan: true } });
      if (row.routingPlan == null) throw new Error(SourceError.ROUTING_PLAN_CONFLICT);
      plan = parseRoutingPlan(row.routingPlan);
      assertRoutingPlanReplay(plan, native.routingPlan);
    }
  }

  const outcomes = new Map<number, PdfPageExtractionOutcome>();
  const ocrPageContent = new Map<number, { text: string; parserName: string; parserVersion: string }>();
  for (const page of plan.pages) {
    if (page.route === "NATIVE_TEXT") outcomes.set(page.physicalPageIndex, page.contentEvidence === "EMPTY" ? "EMPTY" : "NATIVE_TEXT");
  }

  const ocrPages = plan.pages.filter((page) => page.route === "OCR_REQUIRED");
  if (ocrPages.length > 0) {
    // Durable routing intent: the page checkpoints exist whether or not an
    // executor is available, so the OCR work is never silently lost.
    await createOcrPageIntents({ workspaceId: input.workspaceId, sourceDocumentId: input.sourceDocumentId, ingestionRunId: input.runId, routingGeneration: generation, pages: ocrPages.map((page) => ({ physicalPageIndex: page.physicalPageIndex })) });
    for (const page of ocrPages) {
      if (input.ownershipLost()) throw new Error(INGESTION_EXECUTION_OWNERSHIP_LOST);
      const resolved = input.executor ? await executeOcrPage(input, generation, page.physicalPageIndex) : null;
      if (resolved) {
        outcomes.set(page.physicalPageIndex, "OCR_FALLBACK");
        ocrPageContent.set(page.physicalPageIndex, resolved);
      } else {
        outcomes.set(page.physicalPageIndex, "UNRESOLVED_FALLBACK");
      }
    }
  }

  const decision = evaluatePdfExtractionQuality(plan, outcomes);
  if (decision.status === "REQUIRES_FALLBACK") return { kind: "OCR_REQUIRED", routingPlan: plan, routingGeneration: generation, decision };
  if (decision.status === "REJECTED") return { kind: "REJECTED", routingPlan: plan, routingGeneration: generation, decision };

  // Merged page-level canonical result: physical identity is preserved for
  // every page; native pages keep pdfjs provenance, OCR pages carry the
  // authoritative per-attempt executor provenance recorded on the checkpoint.
  const pages = plan.pages.map((page) => {
    const ocr = ocrPageContent.get(page.physicalPageIndex);
    if (ocr) return { physicalPageIndex: page.physicalPageIndex, blocks: pdfTextToBlocks(ocr.text, page.physicalPageIndex, { sourceMethod: "OCR", parserName: ocr.parserName, parserVersion: ocr.parserVersion }) };
    return { physicalPageIndex: page.physicalPageIndex, blocks: native.pages[page.physicalPageIndex]!.blocks };
  });
  const parsed: Parsed = { parser: { ...PDF_EXTRACTION_PARSER }, pages, qualityWarnings: [...decision.qualityWarnings] };
  return { kind: "PUBLISH", parsed, routingPlan: plan, routingGeneration: generation, decision };
}

/**
 * Executes one OCR page through the SAME durable attempt state machine 04B-3
 * will use: claim → execute → complete (immutable content-addressed artifact)
 * or fail (transient requeue within the durable attempt budget / terminal).
 * The durable OcrPageAttempt row — never in-memory state — decides whether a
 * page is resolved: the merged result is read back from the authoritative
 * artifact recorded there and verified against its committed hash.
 */
async function executeOcrPage(input: PdfRunExtractionInput, generation: number, physicalPageIndex: number): Promise<{ text: string; parserName: string; parserVersion: string } | null> {
  const executor = input.executor!;
  const key = { workspaceId: input.workspaceId, sourceDocumentId: input.sourceDocumentId, ingestionRunId: input.runId, physicalPageIndex, routingGeneration: generation };
  for (;;) {
    if (input.ownershipLost()) throw new Error(INGESTION_EXECUTION_OWNERSHIP_LOST);
    const claim = await claimOcrPageAttempt({ ...key, parserName: executor.descriptor.name, parserVersion: executor.descriptor.version, parserMode: executor.descriptor.parserMode ?? null, modelRevision: executor.descriptor.modelRevision ?? null });
    // null = attempt budget exhausted, terminal failure, or requeued for later:
    // the durable row owns retry authority, never a second in-memory counter.
    if (!claim) return null;
    const startedAt = Date.now();
    let result: PdfOcrPageResult;
    try {
      result = await executor.extractPage({ ...key, pdfBytes: input.pdfBytes });
    } catch {
      result = { status: "FAILED", errorCode: SourceError.PARSE, kind: "transient" };
    }
    if (result.status === "SUCCEEDED") {
      const textSha256 = sha256Utf8(result.text);
      // Immutable content-addressed page artifact: identical text maps to the
      // identical key; there is no mutable per-page object anywhere.
      const authoritativeArtifactKey = `workspaces/${input.workspaceId}/extractions/${input.runId}/ocr-pages/${physicalPageIndex}/${textSha256}.txt`;
      await input.storage.putObject({ key: authoritativeArtifactKey, body: Buffer.from(result.text, "utf8"), contentType: "text/plain; charset=utf-8" });
      if (!await completeOcrPageAttempt({ ...key, claimToken: claim.claimToken, authoritativeArtifactKey, textSha256, durationMs: Date.now() - startedAt })) return null;
      return await loadAuthoritativeOcrPage(input, physicalPageIndex, generation);
    }
    if (!await failOcrPageAttempt({ ...key, claimToken: claim.claimToken, errorCode: result.errorCode, kind: result.kind, nextAttemptAt: result.nextAttemptAt })) return null;
    if (result.kind === "terminal") return null;
  }
}

async function loadAuthoritativeOcrPage(input: PdfRunExtractionInput, physicalPageIndex: number, generation: number): Promise<{ text: string; parserName: string; parserVersion: string }> {
  const row = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: input.runId, physicalPageIndex, routingGeneration: generation } } });
  if (row.status !== "SUCCEEDED" || !row.authoritativeArtifactKey || !row.textSha256 || !row.parserName || !row.parserVersion) throw new Error(SourceError.PARSE);
  const bytes = await input.storage.getObjectBytes(row.authoritativeArtifactKey);
  const text = new TextDecoder().decode(bytes);
  if (sha256Utf8(text) !== row.textSha256) throw new Error(SourceError.STORAGE);
  return { text, parserName: row.parserName, parserVersion: row.parserVersion };
}

/**
 * One-way routing outcome write with equality-validated reuse: if the outcome
 * slot is already filled (deterministic content from an equivalent decision),
 * replaying is a no-op; any DIFFERENT persisted outcome is a contract break.
 */
export async function writeRoutingOutcomeValidated(runId: string, routingGeneration: number, outcome: PdfRoutingOutcome): Promise<void> {
  if (await writeRoutingOutcome(runId, routingGeneration, outcome)) return;
  const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId }, select: { routingOutcome: true } });
  if (JSON.stringify(sortKeys(row.routingOutcome)) !== JSON.stringify(sortKeys(outcome))) throw new Error(SourceError.ROUTING_PLAN_CONFLICT);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, sortKeys(entry)]));
  return value;
}
