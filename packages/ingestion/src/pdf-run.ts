import { verifyOcrCheckpointSource } from "./ocr-source-authority.js";
import { classifyOcrQuality } from "./ocr-quality.js";
import { createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { sha256Utf8 } from "@ai-cognitive/domain";
import { logger } from "@ai-cognitive/shared";
import { inspectPdfMixedContentShadow } from "./pdf-mixed-content-shadow.js";
import type { StorageProvider } from "@ai-cognitive/storage";
import { extractNativePdf, pdfTextToBlocks, type Parsed, type ParsedBlock, type ParserLimits } from "./document-parsers.js";
import { INGESTION_EXECUTION_OWNERSHIP_LOST } from "./ingestion-run-claim.js";
import { claimOcrPageAttempt, completeOcrPageAttempt, createOcrPageIntents, failOcrPageAttempt, writeRoutingPlan } from "./ocr-durability.js";
import { PDF_EXTRACTION_PARSER, PDF_ROUTING_GENERATION, assertRoutingPlanReplay, evaluatePdfExtractionQuality, parseRoutingPlan, type PdfExtractionQualityDecision, type PdfOcrExecutionFacts, type PdfOcrExecutor, type PdfOcrPageResult, type PdfPageExtractionOutcome, type PdfRoutingPlan, type PdfRoutingPlanPage } from "./pdf-routing.js";
import { OcrCapacityDeferralError } from "./ocr-capacity-errors.js";
import { SourceError } from "./source-errors.js";

export type PdfRunExtractionInput = {
  runId: string;
  workspaceId: string;
  sourceDocumentId: string;
  /** Persisted IngestionRun.routingPlan (null on first execution). */
  persistedRoutingPlan: unknown;
  /** Persisted IngestionRun.routingGeneration (null on first execution). */
  persistedRoutingGeneration: number | null;
  /** The caller's live IngestionRun execution claim token (P1-02 authority). */
  runExecutionToken: string;
  pdfBytes: Uint8Array;
  limits: ParserLimits;
  storage: StorageProvider;
  /** Absent in 04B-2 production; tests inject fake executors. */
  executor?: PdfOcrExecutor;
  /**
   * STEP6-2B-1: the caller asserts that guarded standard admission is fully
   * enabled (double experiment switch + verified model manifest + executor
   * factory proof). When true, image-only OCR pages carry a standard tier
   * PROPOSAL; the executor still performs its own runtime recheck and may
   * demote any page to flash. Default absent = no proposal is ever made.
   */
  ocrStandardAdmissionEnabled?: boolean;
  /** Explicit single-page review slice; every unprocessed OCR page stays
   * unresolved. This never promotes a partial book to canonical content. */
  reviewPhysicalPageIndex?: number;
  /** Observed execution-lease loss — checked before every durable write. */
  ownershipLost: () => boolean;
};

export type PdfRunExtraction =
  | { kind: "PUBLISH"; parsed: Parsed; routingPlan: PdfRoutingPlan; routingGeneration: number; decision: PdfExtractionQualityDecision; ocrExecutionFacts?: Array<{ physicalPageIndex: number; facts: PdfOcrExecutionFacts }> }
  | { kind: "OCR_REQUIRED"; routingPlan: PdfRoutingPlan; routingGeneration: number; decision: PdfExtractionQualityDecision; ocrExecutionFacts?: Array<{ physicalPageIndex: number; facts: PdfOcrExecutionFacts }> }
  | { kind: "REJECTED"; routingPlan: PdfRoutingPlan; routingGeneration: number; decision: PdfExtractionQualityDecision; ocrExecutionFacts?: Array<{ physicalPageIndex: number; facts: PdfOcrExecutionFacts }> };

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

  // Shadow-only diagnostics; do not modify the durable routing authority, OCR
  // execution or publication. Never log page indices or source text/hashes.
  const mixedShadow = inspectPdfMixedContentShadow(native.inspections);
  if (mixedShadow.mixedPageCount > 0) {
    logger.info("ingestion.pdf_mixed_content_shadow_observed", {
      schemaVersion: mixedShadow.schemaVersion,
      pageCount: mixedShadow.pageCount,
      mixedPageCount: mixedShadow.mixedPageCount,
      imagePageCount: mixedShadow.imagePageCount,
      vectorPageCount: mixedShadow.vectorPageCount,
      annotationPageCount: mixedShadow.annotationPageCount,
      figureSemantics: "UNVERIFIED",
    });
  }

  const outcomes = new Map<number, PdfPageExtractionOutcome>();
  const ocrPageContent = new Map<number, { text: string; parserName: string; parserVersion: string }>();
  for (const page of plan.pages) {
    if (page.route === "NATIVE_TEXT") outcomes.set(page.physicalPageIndex, page.contentEvidence === "EMPTY" ? "EMPTY" : "NATIVE_TEXT");
  }

  const ocrPages = plan.pages.filter((page) => page.route === "OCR_REQUIRED");
  if(input.reviewPhysicalPageIndex!==undefined &&
    (!input.ocrStandardAdmissionEnabled||!input.executor||!Number.isSafeInteger(input.reviewPhysicalPageIndex)||!ocrPages.some(p=>p.physicalPageIndex===input.reviewPhysicalPageIndex)))throw new Error("OCR_REVIEW_PAGE_NOT_ELIGIBLE");
  const ocrExecutionFacts: Array<{ physicalPageIndex: number; facts: PdfOcrExecutionFacts }> = [];
  // Source identity digest of the exact bytes flowing to the executor: hashed
  // at most once per run (the same Uint8Array is shared by every page request).
  let sourceDigest: string | null = null;
  const sourceDigestOf = (): string => {
    if (sourceDigest === null) sourceDigest = createHash("sha256").update(input.pdfBytes).digest("hex");
    return sourceDigest;
  };
  if (ocrPages.length > 0) {
    // Durable routing intent: the page checkpoints exist whether or not an
    // executor is available, so the OCR work is never silently lost.
    await createOcrPageIntents({ workspaceId: input.workspaceId, sourceDocumentId: input.sourceDocumentId, ingestionRunId: input.runId, routingGeneration: generation, pages: ocrPages.map((page) => ({ physicalPageIndex: page.physicalPageIndex })) });
    for (const page of ocrPages) {
      if(input.reviewPhysicalPageIndex!==undefined&&page.physicalPageIndex!==input.reviewPhysicalPageIndex){outcomes.set(page.physicalPageIndex,"UNRESOLVED_FALLBACK");continue;}
      if (input.ownershipLost()) throw new Error(INGESTION_EXECUTION_OWNERSHIP_LOST);
      const resolved = input.executor ? await executeOcrPage(input, generation, page, sourceDigestOf, ocrExecutionFacts) : null;
      if (resolved) {
        outcomes.set(page.physicalPageIndex, "OCR_FALLBACK");
        ocrPageContent.set(page.physicalPageIndex, resolved);
      } else {
        outcomes.set(page.physicalPageIndex, "UNRESOLVED_FALLBACK");
      }
    }
  }

  // Merged page-level canonical result: physical identity is preserved for
  // every page; native pages keep pdfjs provenance, OCR pages carry the
  // authoritative per-attempt executor provenance recorded on the checkpoint.
  const pages: Array<{ physicalPageIndex: number; blocks: ParsedBlock[] }> = plan.pages.map((page) => {
    const ocr = ocrPageContent.get(page.physicalPageIndex);
    // Persist exactly the validated usable blocks (RF01 P1-04): the gate's
    // usability counts and the stored blocks can never diverge.
    if (ocr) return { physicalPageIndex: page.physicalPageIndex, blocks: usableOcrBlocks(ocr.text, page.physicalPageIndex, ocr.parserName, ocr.parserVersion) };
    return { physicalPageIndex: page.physicalPageIndex, blocks: native.pages[page.physicalPageIndex]!.blocks };
  });
  // The gate counts usability only from the exact block arrays that would be
  // persisted — an outcome label can never manufacture usable content (RF01).
  const usableBlockCounts = new Map(pages.map((page) => [page.physicalPageIndex, page.blocks.length]));
  const decision = evaluatePdfExtractionQuality(plan, outcomes, usableBlockCounts);
  // Explicit review execution is evidence-only even if a supplied executor
  // returns usable text. It never grants partial-book publication authority.
  if(input.reviewPhysicalPageIndex!==undefined&&decision.status!=="REJECTED"){
    decision.status="REQUIRES_FALLBACK";
    decision.reasonCodes.push("OCR_MANUAL_REVIEW_REQUIRED");
    decision.reviewRequiredPhysicalPageIndexes=[input.reviewPhysicalPageIndex];
  }
  const triaged=await prisma.ocrPageAttempt.findMany({where:{ingestionRunId:input.runId,workspaceId:input.workspaceId,routingGeneration:generation,qualityStatus:{in:["REVIEW_REQUIRED","REJECTED"]}},select:{physicalPageIndex:true,qualityStatus:true}});
  if(triaged.some(page=>page.qualityStatus==="REVIEW_REQUIRED")) {
    decision.status="REQUIRES_FALLBACK";
    decision.reasonCodes.push("OCR_MANUAL_REVIEW_REQUIRED");
    decision.reviewRequiredPhysicalPageIndexes=triaged.filter(page=>page.qualityStatus==="REVIEW_REQUIRED").map(page=>page.physicalPageIndex);
  }

  const factsField = ocrExecutionFacts.length > 0 ? { ocrExecutionFacts } : {};
  if (decision.status === "REQUIRES_FALLBACK") return { kind: "OCR_REQUIRED", routingPlan: plan, routingGeneration: generation, decision, ...factsField };
  if (decision.status === "REJECTED") return { kind: "REJECTED", routingPlan: plan, routingGeneration: generation, decision, ...factsField };

  const parsed: Parsed = { parser: { ...PDF_EXTRACTION_PARSER }, pages, qualityWarnings: [...decision.qualityWarnings] };
  return { kind: "PUBLISH", parsed, routingPlan: plan, routingGeneration: generation, decision, ...factsField };
}

/**
 * Usable OCR output blocks: the canonical publication block path, filtered to
 * blocks with non-whitespace content. RF01 P1-04: "", whitespace-only and
 * BOM-only outputs canonicalize to zero usable blocks and are never accepted
 * as fallback content.
 */
function usableOcrBlocks(text: string, physicalPageIndex: number, parserName: string, parserVersion: string): ParsedBlock[] {
  return pdfTextToBlocks(text, physicalPageIndex, { sourceMethod: "OCR", parserName, parserVersion }).filter((block) => block.text.trim().length > 0);
}

/**
 * Executes one OCR page through the SAME durable attempt state machine 04B-3
 * will use. Order of authority (RF01 P1-01):
 *  1. A SUCCEEDED checkpoint is resolved WITHOUT any executor call — its
 *     immutable artifact is loaded and hash-verified (durable resume).
 *  2. Otherwise claim (with run-execution takeover authority, P1-02) and
 *     execute. Executor "SUCCEEDED" is accepted only when the output
 *     canonicalizes to at least one usable block (P1-04); anything else is a
 *     stable page failure retried through the durable attempt budget.
 *  3. A null claim is never "unresolved" by inference: the checkpoint is
 *     re-read first, because a superseded owner may have completed it
 *     concurrently.
 */
async function executeOcrPage(
  input: PdfRunExtractionInput,
  generation: number,
  planPage: PdfRoutingPlanPage,
  sourceDigestOf: () => string,
  factsSink: Array<{ physicalPageIndex: number; facts: PdfOcrExecutionFacts }>,
): Promise<{ text: string; parserName: string; parserVersion: string } | null> {
  const executor = input.executor!;
  const physicalPageIndex = planPage.physicalPageIndex;
  const key = { workspaceId: input.workspaceId, sourceDocumentId: input.sourceDocumentId, ingestionRunId: input.runId, physicalPageIndex, routingGeneration: generation };
  // STEP6-2B-1 standard tier PROPOSAL (Candidate layer): only for raster
  // image-only OCR pages when the caller asserted full admission enablement.
  // This proposal grants nothing — the executor's runtime recheck decides the
  // actual tier, and vector/annotation-only pages never propose standard.
  const proposeStandard = input.ocrStandardAdmissionEnabled === true
    && planPage.route === "OCR_REQUIRED"
    && planPage.contentEvidence === "NON_TEXT_CONTENT"
    && planPage.reasonCodes.includes("IMAGE_CONTENT_WITHOUT_TEXT")
    && !planPage.reasonCodes.includes("VECTOR_CONTENT_WITHOUT_TEXT")
    && !planPage.reasonCodes.includes("ANNOTATION_CONTENT_WITHOUT_TEXT");
  const resumed = await loadAuthoritativeOcrPage(input, physicalPageIndex, generation);
  if (resumed) return resumed;
  for (;;) {
    if (input.ownershipLost()) throw new Error(INGESTION_EXECUTION_OWNERSHIP_LOST);
    const claim = await claimOcrPageAttempt({ ...key, parserName: executor.descriptor.name, parserVersion: executor.descriptor.version, parserMode: executor.descriptor.parserMode ?? null, modelRevision: executor.descriptor.modelRevision ?? null, runExecutionToken: input.runExecutionToken });
    if (!claim) {
      // The claim may have lost a race against a concurrent completion under a
      // superseded execution; the durable checkpoint — not the null — decides.
      return await loadAuthoritativeOcrPage(input, physicalPageIndex, generation);
    }
    const startedAt = Date.now();
    let result: PdfOcrPageResult;
    try {
      result = await executor.extractPage({ ...key, pageClaimToken: claim.claimToken, runExecutionToken: input.runExecutionToken, pdfBytes: input.pdfBytes, ...(proposeStandard ? { standardExecutionRequest: { sourcePdfSha256: sourceDigestOf() } } : {}) });
    } catch {
      result = { status: "FAILED", errorCode: SourceError.PARSE, kind: "transient" };
    }
    if (result.execution) factsSink.push({ physicalPageIndex, facts: result.execution });
    if (result.status === "SUCCEEDED") {
      // P1-04: validate through the SAME canonical block path used for
      // publication. Zero usable blocks → stable page failure; the existing
      // durable attempt authority decides any retry (no second counter).
      if (usableOcrBlocks(result.text, physicalPageIndex, executor.descriptor.name, executor.descriptor.version).length < 1) {
        if (!await failOcrPageAttempt({ ...key, claimToken: claim.claimToken, errorCode: SourceError.OCR_NO_USABLE_TEXT, kind: "transient" })) return null;
        continue;
      }
      const textSha256 = sha256Utf8(result.text);
      // Immutable content-addressed page artifact: identical text maps to the
      // identical key; there is no mutable per-page object anywhere.
      const authoritativeArtifactKey = `workspaces/${input.workspaceId}/extractions/${input.runId}/ocr-pages/${physicalPageIndex}/${textSha256}.txt`;
      await input.storage.putObject({ key: authoritativeArtifactKey, body: Buffer.from(result.text, "utf8"), contentType: "text/plain; charset=utf-8" });
      if (!await completeOcrPageAttempt({ ...key, claimToken: claim.claimToken, sourceAuthority: result.execution?.sourceAuthority, qualityStatus: result.execution?.qualityDecision?.status, authoritativeArtifactKey, textSha256, durationMs: Date.now() - startedAt })) return null;
      return await loadAuthoritativeOcrPage(input, physicalPageIndex, generation);
    }
    // RF04 P1-02: HOST CAPACITY unavailable is a DEFERRAL, not a processing
    // failure. NO durable mutation happens here — the page claim identity is
    // carried by a TYPED error to the ingestion service boundary, where ONE
    // PostgreSQL transaction atomically releases page + run + Job budgets
    // (transitionOcrCapacityDeferred). CONTENT and PROCESS failures below
    // still consume attempts exactly as before.
    if (result.errorCode === SourceError.OCR_HOST_CAPACITY && result.kind === "transient") {
      throw new OcrCapacityDeferralError({ ...key, pageClaimToken: claim.claimToken, runExecutionToken: input.runExecutionToken });
    }
    if (!await failOcrPageAttempt({ ...key, claimToken: claim.claimToken, errorCode: result.errorCode, kind: result.kind, nextAttemptAt: result.nextAttemptAt })) return null;
    if (result.kind === "terminal") return null;
  }
}

/**
 * Loads a page's authoritative result from the durable checkpoint: only a
 * SUCCEEDED row with parser identity, a hash-verified immutable artifact, and
 * usable canonical text (P1-04, re-validated on resume) resolves a page. Any
 * other durable state returns null — the page stays unresolved.
 */
async function loadAuthoritativeOcrPage(input: PdfRunExtractionInput, physicalPageIndex: number, generation: number): Promise<{ text: string; parserName: string; parserVersion: string } | null> {
  const row = await prisma.ocrPageAttempt.findUnique({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: input.runId, physicalPageIndex, routingGeneration: generation } } });
  if (row?.qualityStatus === "REVIEW_REQUIRED" || row?.qualityStatus === "REJECTED") return null;
  if (!row || row.status !== "SUCCEEDED" || !row.authoritativeArtifactKey || !row.textSha256 || !row.parserName || !row.parserVersion) return null;
  if (input.ocrStandardAdmissionEnabled && !row.sourceIdentity) return null;
  if(row.sourceIdentity) {
    const source=row.sourceIdentity as {sourceBlobId:string;sourceDocumentId:string;sourceSha256:string;sourceSizeBytes:number;storageKey:string;planSha256:string};
    const key={workspaceId:input.workspaceId,sourceDocumentId:input.sourceDocumentId,ingestionRunId:input.runId,physicalPageIndex,routingGeneration:generation,runExecutionToken:input.runExecutionToken,pageClaimToken:row.claimToken??"",sourceSha256:createHash("sha256").update(input.pdfBytes).digest("hex"),sourceSizeBytes:input.pdfBytes.byteLength};
    if(!await verifyOcrCheckpointSource(key,{...key,...source})) return null;
    const receipt=await prisma.ocrPageExecution.findUnique({where:{pageClaimToken:row.claimToken??""}});
    if(!receipt || receipt.executionStatus!=="SUCCEEDED" || receipt.resultTextSha256!==row.textSha256) return null;
  }
  const bytes = await input.storage.getObjectBytes(row.authoritativeArtifactKey);
  const text = new TextDecoder().decode(bytes);
  if (sha256Utf8(text) !== row.textSha256) throw new Error(SourceError.STORAGE);
  if (classifyOcrQuality(text,physicalPageIndex,row.proposedTier==="standard").status!=="ACCEPTED") return null;
  if (usableOcrBlocks(text, physicalPageIndex, row.parserName, row.parserVersion).length < 1) return null;
  return { text, parserName: row.parserName, parserVersion: row.parserVersion };
}
