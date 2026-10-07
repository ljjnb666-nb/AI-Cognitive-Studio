import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { buildEpubProductIdentityCandidate, CANONICAL_SCHEMA_VERSION, parseCanonicalBlockMetadata, parseEpubExtractionMetadata, parseExtractionQualityMetadata, parseSourceBlockBbox, sha256Utf8 } from "@ai-cognitive/domain";
import type { EpubExtractionMetadata } from "@ai-cognitive/domain";
import { logger } from "@ai-cognitive/shared";
import type { StorageProvider } from "@ai-cognitive/storage";
import { CANONICAL_BLOCK_SEPARATOR, CANONICAL_NORMALIZATION_VERSION } from "./canonical-text.js";
import { inspectObjectStream } from "./object-inspection.js";
import { parseDocument, type Parsed, type ParsedBlock, DEFAULT_PARSER_LIMITS } from "./document-parsers.js";
import { SourceError } from "./source-errors.js";
import { claimIngestionRun, completeRunSuccess, INGESTION_EXECUTION_OWNERSHIP_LOST, lockRunForPublication, renewIngestionRunClaim, RUN_RENEW_INTERVAL_MS, terminalizeRunWithRoutingOutcome, transitionOcrCapacityDeferred, transitionRunToRetryable, transitionRunToTerminal, type IngestionTerminalStatus } from "./ingestion-run-claim.js";
import { writeRoutingOutcome } from "./ocr-durability.js";
import { classifyIngestionFailure, ingestionStatusForTerminalFailure } from "./ingestion-failure.js";
import { runPdfExtraction, type PdfRunExtraction } from "./pdf-run.js";
import { OcrCapacityDeferredError, OcrCapacityDeferralError } from "./ocr-capacity-errors.js";
import { PDF_EXTRACTION_PARSER, pdfRoutingOutcome, type PdfOcrExecutor } from "./pdf-routing.js";
import { evaluateEpubExtractionQuality, type EpubExtractionQualityDecision } from "./epub-quality.js";
import { claimUploadCompletion, rejectCompletionClaim, releaseCompletionClaim, renewCompletionClaim } from "./upload-completion-claim.js";
import { dispatchPendingOutbox } from "./outbox-dispatcher.js";
export { dispatchPendingOutbox, MAX_PERSISTED_DISPATCH_GENERATION, normalizeDispatchGeneration } from "./outbox-dispatcher.js";
export { cleanupTemporaryUploads } from "./temporary-upload-cleanup.js";
export { SourceError, sourceErrorForParserResult } from "./source-errors.js";
export { parseDocument, extractNativePdf, pdfTextToBlocks, DEFAULT_PARSER_LIMITS, blockProvenance } from "./document-parsers.js";
export { PDF_EXTRACTION_PARSER, PDF_INSPECTOR_VERSION, PDF_QUALITY_REASON_CODES, PDF_ROUTING_GENERATION, PDF_ROUTING_OUTCOME_SCHEMA_VERSION, PDF_ROUTING_PLAN_SCHEMA_VERSION, PDF_ROUTING_REASON_CODES, assertRoutingPlanReplay, evaluatePdfExtractionQuality, inspectPdfPage, parseRoutingPlan, pdfRoutingOutcome, planPdfRouting, type PdfContentEvidence, type PdfExtractionQualityDecision, type PdfExtractionQualityStatus, type PdfOcrExecutor, type PdfOcrExecutorDescriptor, type PdfOcrPageRequest, type PdfOcrPageResult, type PdfPageEvidence, type PdfPageInspection, type PdfPageQualityDecision, type PdfPageRoute, type PdfPageExtractionOutcome, type PdfQualityReasonCode, type PdfRoutingOutcome, type PdfRoutingPlan, type PdfRoutingPlanPage, type PdfRoutingReasonCode } from "./pdf-routing.js";
export { EPUB_QUALITY_REASON_CODES, evaluateEpubExtractionQuality, type EpubExtractionQualityDecision, type EpubExtractionQualityStatus, type EpubQualityReasonCode } from "./epub-quality.js";
export { OcrCapacityDeferredError, OcrCapacityDeferralError } from "./ocr-capacity-errors.js";
export { runPdfExtraction, type PdfRunExtraction, type PdfRunExtractionInput } from "./pdf-run.js";
export { claimIngestionRun, completeRunSuccess, INGESTION_ATTEMPTS_EXHAUSTED, INGESTION_EXECUTION_LEASE_EXPIRED, INGESTION_EXECUTION_OWNERSHIP_LOST, lockRunForPublication, renewIngestionRunClaim, RUN_LEASE_TTL_MS, RUN_RENEW_INTERVAL_MS, terminalizeExhaustedQueuedIngestionRun, terminalizeExpiredIngestionRun, terminalizeRunWithRoutingOutcome, transitionOcrCapacityDeferred, transitionRunToRetryable, transitionRunToTerminal, type IngestionRunClaim, type IngestionTerminalStatus } from "./ingestion-run-claim.js";
export { classifyIngestionFailure, ingestionStatusForTerminalFailure, type IngestionFailureClass } from "./ingestion-failure.js";
export { acquireOcrHostLease, claimOcrPageAttempt, completeOcrPageAttempt, createOcrPageIntents, createOcrServerInstance, failOcrPageAttempt, listReconcilableOcrServerInstances, markOcrServerOrphaned, markOcrServerStartNeverStarted, markOcrServerStopped, markOcrServerStoppedProcessGone, markOcrServerStopping, OCR_HOST_LEASE_TTL_MS, OCR_PAGE_LEASE_TTL_MS, OCR_PAGE_MAX_ATTEMPTS, recordOcrServerEndpoint, releaseOcrHostLease, renewOcrHostLease, writeRoutingOutcome, writeRoutingPlan } from "./ocr-durability.js";
export { INGESTION_RECONCILIATION_BATCH_SIZE, reconcileIngestionDeliveries, type IngestionDeliveryState, type IngestionReconciliationQueuePort, type IngestionReconciliationResult } from "./ingestion-reconciliation.js";
export { MINERU_EXECUTOR_NAME, MINERU_PINNED_TIER, MINERU_PINNED_VERSION, buildMineruParseArgs, buildMineruServerArgs, judgeMineruParseExit, mineruFailureForOutcome, mineruPageSelector, parseMineruEndpoint, parseMineruParseEnvelope, type MineruEndpoint, type MineruParseOutcome } from "./mineru/mineru-commands.js";
export { resolveMineruExecutorConfig, verifyMineruRuntime, isWithinPath, type MineruExecutorConfig, type MineruRuntimeVerification } from "./mineru/mineru-config.js";
export { createMineruPdfOcrExecutor, type MineruOcrCallRecord, type MineruPdfOcrExecutorHandle } from "./mineru/mineru-executor.js";
export { reconcileOcrServerInstances, type OcrServerReconciliationResult } from "./mineru/mineru-reconciler.js";
export { createMineruServerSession, processPrecedesEndpointEvidence, readMineruEndpointFile, type MineruServerSession, type MineruServerSessionInput, type MineruServerStartFailure, type MineruServerStopDisposition } from "./mineru/mineru-server.js";

export type TrustedRequestContext = { userId: string; workspaceId: string };
export const INGESTION_QUEUE = "source.ingestion";
export const INGESTION_TOPIC = "source.ingestion.requested";
export const INGESTION_JOB = "source.ingest";
export const BOOK_ANALYSIS_BOOTSTRAP_TOPIC = "book.analysis.bootstrap.requested";
const safeFilename = (value: string) => value.replace(/[\\/]/g, "_").split("").map((character) => character.charCodeAt(0) < 32 ? "_" : character).join("").slice(0, 180) || "source";

/**
 * Quality recorded for formats that do not yet have a production quality gate.
 * PDF is authoritative since 04B-2 and EPUB since 04C-3; TXT/Markdown remain
 * UNKNOWN until a future format-specific gate exists.
 */
const UNASSESSED_EXTRACTION_QUALITY = parseExtractionQualityMetadata({ warnings: [] });

/** Service options; pdfOcrExecutor is a test seam until 04B-2's production cutover (none in 04B-2). */
export type IngestionServiceOptions = { maxUploadBytes: number; uploadTtlSeconds: number; maxPdfPages: number; completionLeaseMs: number; processMaxAttempts: number; /** OCR fallback executor for OCR-routed PDF pages. Production 04B-2 ships none: OCR-routed runs end OCR_REQUIRED. */ pdfOcrExecutor?: PdfOcrExecutor };

/**
 * Canonical v1 write gate for SourceBlock.metadata, keyed on the authoritative
 * SourceDocument.mediaType (never parserName): strictly validated before any
 * write. Provenance is REQUIRED for every block. A PDF block must carry a
 * kind="pdf" locator and an EPUB block a kind="epub" locator; TXT/Markdown
 * must not fabricate one (locator stays null). Every violation fails closed
 * with the stable SOURCE_CANONICAL_BLOCK_CONTRACT_INVALID code — Zod details
 * never become durable business errors. Legacy tolerance exists only on the
 * read path (tryParseCanonicalBlockMetadata): a canonical-book-v1 block that
 * fails the v1 contract is a parser bug and must abort the ingestion.
 */
export function canonicalBlockMetadata(block: ParsedBlock, mediaType: string) {
  const requiredLocatorKind = mediaType === "application/pdf" ? "pdf" : mediaType === "application/epub+zip" ? "epub" : mediaType === "text/plain" || mediaType === "text/markdown" ? null : undefined;
  if (!block.provenance || requiredLocatorKind === undefined || (block.locator?.kind ?? null) !== requiredLocatorKind) throw new Error(SourceError.CANONICAL_BLOCK_CONTRACT_INVALID);
  let canonical: ReturnType<typeof parseCanonicalBlockMetadata>;
  try {
    canonical = parseCanonicalBlockMetadata({ ...block.metadata, locator: block.locator ?? null, provenance: block.provenance });
  } catch {
    throw new Error(SourceError.CANONICAL_BLOCK_CONTRACT_INVALID);
  }
  return JSON.parse(JSON.stringify(canonical));
}

/**
 * Canonical persistence gate for DocumentExtraction.formatMetadata, keyed on
 * the authoritative SourceDocument.mediaType (RF01-04). An EPUB extraction
 * MUST carry schema-valid EpubExtractionMetadata; PDF/TXT/Markdown MUST NOT
 * carry any. Violations are internal parser contract bugs: they fail closed
 * with the stable SOURCE_FORMAT_METADATA_CONTRACT_INVALID code (never Zod
 * details), are classified FAILED (not REJECTED), and must abort the write.
 */
export function canonicalFormatMetadata(mediaType: string, formatMetadata: unknown): EpubExtractionMetadata | undefined {
  if (mediaType === "application/epub+zip") {
    if (formatMetadata == null) throw new Error(SourceError.FORMAT_METADATA_CONTRACT_INVALID);
    try {
      return JSON.parse(JSON.stringify(parseEpubExtractionMetadata(formatMetadata)));
    } catch {
      throw new Error(SourceError.FORMAT_METADATA_CONTRACT_INVALID);
    }
  }
  if (formatMetadata != null) throw new Error(SourceError.FORMAT_METADATA_CONTRACT_INVALID);
  return undefined;
}

export function assertSafeUrl(value: string): URL {
  const url = new URL(value); const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) throw new Error("URL_NOT_ALLOWED");
  return url;
}
export function sniffMediaType(bytes: Uint8Array, declared: string, filename: string): "text/plain" | "text/markdown" | "application/pdf" | "application/epub+zip" {
  const text = Buffer.from(bytes.slice(0, 8)).toString("utf8"); const lower = filename.toLowerCase();
  if (text.startsWith("%PDF-")) return "application/pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "application/epub+zip";
  if (declared === "text/markdown" || /\.md$/.test(lower)) return "text/markdown";
  if (declared === "text/plain" || /\.(txt|text)$/.test(lower)) return "text/plain";
  throw new Error(SourceError.TYPE_MISMATCH);
}
export function createIngestionService(storage: StorageProvider, options: IngestionServiceOptions = { maxUploadBytes: 100 * 1024 * 1024, uploadTtlSeconds: 900, maxPdfPages: 2000, completionLeaseMs: 900000, processMaxAttempts: 3 }) {
  async function assertMembership(context: TrustedRequestContext) { const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: context } }); if (!member) throw new Error("WORKSPACE_ACCESS_DENIED"); }
  return {
    async createUploadIntent(context: TrustedRequestContext, input: { filename: string; mediaType: string; sizeBytes: number }) {
      await assertMembership(context); if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > options.maxUploadBytes) throw new Error("UPLOAD_SIZE_INVALID");
      const id = randomUUID(); const temporaryStorageKey = `temporary/${context.workspaceId}/${id}`; const expiresAt = new Date(Date.now() + options.uploadTtlSeconds * 1000);
      const session = await prisma.uploadSession.create({ data: { id, workspaceId: context.workspaceId, originalFilename: safeFilename(input.filename), declaredMediaType: input.mediaType, declaredSizeBytes: input.sizeBytes, temporaryStorageKey, expiresAt } });
      const upload = await storage.createPresignedUpload({ key: temporaryStorageKey, contentType: input.mediaType, expiresInSeconds: options.uploadTtlSeconds }); return { session, upload };
    },
    async completeUpload(context: TrustedRequestContext, sessionId: string, completion: { outboxTopic?: string } = {}) {
      await assertMembership(context); const session = await prisma.uploadSession.findFirstOrThrow({ where: { id: sessionId, workspaceId: context.workspaceId } });
      if (session.status === "COMPLETED") {
        const completion = await prisma.uploadCompletion.findUniqueOrThrow({
          where: { uploadSessionId_workspaceId: { uploadSessionId: session.id, workspaceId: context.workspaceId } },
          include: { sourceDocument: true },
        });
        return completion.sourceDocument;
      }
      if (session.status === "REJECTED") throw new Error("UPLOAD_REJECTED");
      if (session.status === "EXPIRED") throw new Error("UPLOAD_EXPIRED");
      const claim = await claimUploadCompletion(context.workspaceId, session.id, options.completionLeaseMs);
      if (!claim) {
        const current = await prisma.uploadSession.findFirstOrThrow({ where: { id: session.id, workspaceId: context.workspaceId } });
        if (current.status === "COMPLETED") {
          const completion = await prisma.uploadCompletion.findUniqueOrThrow({ where: { uploadSessionId_workspaceId: { uploadSessionId: session.id, workspaceId: context.workspaceId } }, include: { sourceDocument: true } });
          return completion.sourceDocument;
        }
        if (current.status === "EXPIRED") throw new Error("UPLOAD_EXPIRED");
        if (current.status === "REJECTED") throw new Error("UPLOAD_REJECTED");
        throw new Error("UPLOAD_COMPLETION_IN_PROGRESS");
      }
      try {
        if (session.expiresAt < new Date()) { await rejectCompletionClaim(context.workspaceId, session.id, claim.token, "EXPIRED"); throw new Error("UPLOAD_EXPIRED"); }
        const head = await storage.headObject(session.temporaryStorageKey); if (!head || head.size !== Number(session.declaredSizeBytes) || head.size > options.maxUploadBytes) { await rejectCompletionClaim(context.workspaceId, session.id, claim.token, "REJECTED"); throw new Error("UPLOAD_SIZE_INVALID"); }
        if (!await renewCompletionClaim(context.workspaceId, session.id, claim.token, options.completionLeaseMs)) throw new Error("UPLOAD_COMPLETION_CLAIM_LOST");
        const inspected = await inspectObjectStream(await storage.getObjectStream(session.temporaryStorageKey));
        if (inspected.sizeBytes !== head.size || inspected.sizeBytes !== Number(session.declaredSizeBytes)) { await rejectCompletionClaim(context.workspaceId, session.id, claim.token, "REJECTED"); throw new Error("UPLOAD_STORAGE_SIZE_MISMATCH"); }
        const mediaType = sniffMediaType(inspected.prefix, session.declaredMediaType, session.originalFilename); const digest = inspected.sha256; const storageKey = `workspaces/${context.workspaceId}/source-blobs/${digest}`;
        if (!await renewCompletionClaim(context.workspaceId, session.id, claim.token, options.completionLeaseMs)) throw new Error("UPLOAD_COMPLETION_CLAIM_LOST");
        const existing = await prisma.sourceBlob.findUnique({ where: { workspaceId_sha256: { workspaceId: context.workspaceId, sha256: digest } } });
        let canonicalWasCreated = false;
        if (existing) {
          const existingHead = await storage.headObject(existing.storageKey);
          if (!existingHead || existingHead.size !== inspected.sizeBytes) throw new Error("CANONICAL_STORAGE_INTEGRITY_FAILURE");
        } else {
          const canonicalHead = await storage.headObject(storageKey);
          if (!canonicalHead) { await storage.copyObject(session.temporaryStorageKey, storageKey); canonicalWasCreated = true; }
          const canonicalInspection = await inspectObjectStream(await storage.getObjectStream(storageKey));
          if (canonicalInspection.sha256 !== digest || canonicalInspection.sizeBytes !== inspected.sizeBytes) {
            if (canonicalWasCreated) await storage.deleteObject(storageKey).catch(() => undefined);
            throw new Error("CANONICAL_STORAGE_INTEGRITY_FAILURE");
          }
        }
        if (!await renewCompletionClaim(context.workspaceId, session.id, claim.token, options.completionLeaseMs)) throw new Error("UPLOAD_COMPLETION_CLAIM_LOST");
        const parser = parserProvenance(mediaType);
        const result = await prisma.$transaction(async (tx) => {
          const owned = await tx.$executeRaw`UPDATE "UploadSession" SET "updatedAt" = NOW() WHERE "id" = ${session.id} AND "workspaceId" = ${context.workspaceId} AND "status" = 'COMPLETING'::"UploadSessionStatus" AND "completionClaimToken" = ${claim.token} AND "completionLeaseUntil" >= NOW()`;
          if (owned !== 1) throw new Error("UPLOAD_COMPLETION_CLAIM_LOST");
          await tx.sourceBlob.createMany({ data: [{ workspaceId: context.workspaceId, sha256: digest, sizeBytes: inspected.sizeBytes, mediaType, storageKey }], skipDuplicates: true });
          const blob = await tx.sourceBlob.findUniqueOrThrow({ where: { workspaceId_sha256: { workspaceId: context.workspaceId, sha256: digest } } });
          const source = await tx.source.create({ data: { workspaceId: context.workspaceId, kind: "FILE", displayName: session.originalFilename } }); const document = await tx.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: context.workspaceId, version: 1, sha256: blob.sha256, sizeBytes: blob.sizeBytes, mediaType, storageKey: blob.storageKey } }); const job = await tx.job.create({ data: { userId: context.userId, workspaceId: context.workspaceId, type: INGESTION_JOB, payload: { sourceDocumentId: document.id }, idempotencyKey: `ingest:${document.id}` } }); const run = await tx.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: context.workspaceId, jobId: job.id, parserVersion: parser.version, normalizationVersion: CANONICAL_NORMALIZATION_VERSION } }); await tx.uploadCompletion.create({ data: { uploadSessionId: session.id, sourceDocumentId: document.id, workspaceId: context.workspaceId } }); await tx.outboxEvent.create({ data: { topic: completion.outboxTopic ?? INGESTION_TOPIC, aggregateId: run.id, payload: { ingestionRunId: run.id } } });
          const completed = await tx.$executeRaw`UPDATE "UploadSession" SET "status" = 'COMPLETED'::"UploadSessionStatus", "completionClaimToken" = NULL, "completionClaimedAt" = NULL, "completionLeaseUntil" = NULL, "completedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = ${session.id} AND "workspaceId" = ${context.workspaceId} AND "status" = 'COMPLETING'::"UploadSessionStatus" AND "completionClaimToken" = ${claim.token}`;
          if (completed !== 1) throw new Error("UPLOAD_COMPLETION_CLAIM_LOST"); return document;
        });
        await storage.deleteObject(session.temporaryStorageKey); return result;
      } catch (error) {
        const code = error instanceof Error ? error.message : "UNEXPECTED_ERROR";
        if (code === SourceError.TYPE_MISMATCH || code === SourceError.UNSUPPORTED_TYPE) await rejectCompletionClaim(context.workspaceId, session.id, claim.token, "REJECTED");
        else if (!["UPLOAD_SIZE_INVALID", "UPLOAD_STORAGE_SIZE_MISMATCH", "UPLOAD_EXPIRED"].includes(code)) await releaseCompletionClaim(context.workspaceId, session.id, claim.token);
        throw error;
      }
    },
    async processIngestionRun(runId: string) {
      const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId }, include: { sourceDocument: { include: { source: true } }, job: true } });
      if (["SUCCEEDED", "REJECTED", "OCR_REQUIRED", "PASSWORD_REQUIRED"].includes(run.status)) return;
      // Durable execution claim: run + Job transition atomically, attempt-guarded
      // in PostgreSQL. FAILED is terminal and never claimable; QUEUED and
      // expired-RUNNING (with budget left) are the only claimable states.
      const claim = await claimIngestionRun(runId, options.processMaxAttempts);
      if (!claim) return;
      let ownershipLost = false;
      // RF01 P1-03: set when the fenced terminalizeRunWithRoutingOutcome
      // transaction already committed the non-publish outcome + terminal state
      // under live ownership — the catch block must not re-terminalize.
      let nonPublishTerminalized = false;
      const heartbeat = setInterval(() => {
        void renewIngestionRunClaim(runId, claim.token).then((renewed) => { if (!renewed) ownershipLost = true; }).catch(() => { ownershipLost = true; });
      }, RUN_RENEW_INTERVAL_MS);
      try {
        const bytes = await storage.getObjectBytes(run.sourceDocument.storageKey);
        const limits = { ...DEFAULT_PARSER_LIMITS, maxPdfPages: options.maxPdfPages };
        // PDFs run the 04B-2 routing pipeline: inspect → write-once routing
        // plan → native extraction + OCR executor seam → merged page-level
        // result → deterministic quality decision. Other formats parse directly.
        let parsed: Parsed;
        let pdfRouting: Extract<PdfRunExtraction, { kind: "PUBLISH" }> | null = null;
        if (run.sourceDocument.mediaType === "application/pdf") {
          const extraction = await runPdfExtraction({
            runId: run.id,
            workspaceId: run.workspaceId,
            sourceDocumentId: run.sourceDocumentId,
            persistedRoutingPlan: run.routingPlan,
            persistedRoutingGeneration: run.routingGeneration,
            runExecutionToken: claim.token,
            pdfBytes: bytes,
            limits,
            storage,
            executor: options.pdfOcrExecutor,
            ownershipLost: () => ownershipLost,
          });
          if (extraction.kind !== "PUBLISH") {
            // No partial publication. RF01 P1-03: the routing outcome and the
            // run/Job terminal transition are committed by ONE transaction
            // that first verifies live claim ownership in PostgreSQL — a
            // superseded owner (stale in-memory ownershipLost or not) changes
            // ZERO durable state. Ownership loss writes nothing.
            const errorCode = extraction.kind === "OCR_REQUIRED" ? SourceError.OCR_REQUIRED : SourceError.QUALITY_REJECTED;
            const status: IngestionTerminalStatus = extraction.kind === "OCR_REQUIRED" ? "OCR_REQUIRED" : "REJECTED";
            if (!await terminalizeRunWithRoutingOutcome(run.id, claim.token, status, errorCode, extraction.routingGeneration, pdfRoutingOutcome(extraction.decision, false))) throw new Error(INGESTION_EXECUTION_OWNERSHIP_LOST);
            nonPublishTerminalized = true;
            throw new Error(errorCode);
          }
          parsed = extraction.parsed;
          pdfRouting = extraction;
        } else {
          parsed = await parseDocument(bytes, run.sourceDocument.mediaType, limits);
        }
        const canonicalBlocks = parsed.pages.flatMap((page) => page.blocks);
        let epubQuality: EpubExtractionQualityDecision | null = null;
        if (run.sourceDocument.mediaType === "application/epub+zip") {
          const usableBlockCount = canonicalBlocks.filter((block) => block.text.trim().length > 0).length;
          epubQuality = evaluateEpubExtractionQuality(usableBlockCount, parsed.qualityWarnings ?? []);
          // Parser success alone never authorizes publication. A defensive
          // quality rejection happens before text storage/current/bootstrap.
          if (epubQuality.status === "REJECTED") throw new Error(SourceError.QUALITY_REJECTED);
        }
        const text = canonicalBlocks.map((block) => block.text).join(CANONICAL_BLOCK_SEPARATOR);
        if (ownershipLost) throw new Error(INGESTION_EXECUTION_OWNERSHIP_LOST);
        // Immutable content-addressed artifact: the key is derived from the bytes
        // themselves, so two execution claims producing different text write
        // different objects and a stale owner's late PUT can only create an
        // unreferenced orphan — it can never change the bytes referenced by the
        // authoritative DocumentExtraction.textStorageKey. Identical text maps to
        // the identical key, which is safe because the bytes are identical.
        const textSha256 = sha256Utf8(text);
        const textKey = `workspaces/${run.sourceDocument.source.workspaceId}/extractions/${run.id}/text/${textSha256}.txt`;
        await storage.putObject({ key: textKey, body: Buffer.from(text, "utf8"), contentType: "text/plain; charset=utf-8" });

        await prisma.$transaction(async (tx) => {
          // Final-publication ownership fence: lock the authoritative run row and
          // assert live claim ownership BEFORE any extraction data is written.
          // The row lock holds the run against reclaim until this transaction ends.
          if (ownershipLost || !(await lockRunForPublication(tx, run.id, claim.token))) throw new Error(INGESTION_EXECUTION_OWNERSHIP_LOST);
          // Publication hard gate (04B-2): a PDF may persist an extraction only
          // with a quality decision, and only an ACCEPTED/DEGRADED decision may
          // publish. The pipeline never returns forbidden decisions — reaching
          // here with one is an internal contract bug and must abort the write.
          if (pdfRouting && (pdfRouting.decision.status === "REQUIRES_FALLBACK" || pdfRouting.decision.status === "REJECTED")) throw new Error(SourceError.QUALITY_GATE_BLOCKED);
          if (epubQuality && epubQuality.status !== "ACCEPTED" && epubQuality.status !== "DEGRADED") throw new Error(SourceError.QUALITY_GATE_BLOCKED);
          const formatMetadata = canonicalFormatMetadata(run.sourceDocument.mediaType, parsed.formatMetadata);
          const productIdentityCandidate = formatMetadata ? buildEpubProductIdentityCandidate(formatMetadata) : undefined;
          const extraction = await tx.documentExtraction.create({
            data: {
              ingestionRunId: run.id,
              sourceDocumentId: run.sourceDocumentId,
              workspaceId: run.workspaceId,
              status: "SUCCEEDED",
              // PDF extractions are router-pipeline products since 04B-2; the
              // native engine identity stays on every native block's provenance.
              parserName: pdfRouting ? PDF_EXTRACTION_PARSER.name : parsed.parser.name,
              parserVersion: pdfRouting ? PDF_EXTRACTION_PARSER.version : parsed.parser.version,
              normalizationVersion: CANONICAL_NORMALIZATION_VERSION,
              canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
              // PDF and EPUB successful publications are quality-authoritative.
              // TXT/Markdown remain unassessed (UNKNOWN).
              qualityStatus: pdfRouting ? pdfRouting.decision.status : epubQuality ? epubQuality.status : "UNKNOWN",
              qualityMetadata: epubQuality
                ? parseExtractionQualityMetadata({ warnings: epubQuality.qualityWarnings })
                : parsed.qualityWarnings?.length
                  ? parseExtractionQualityMetadata({ warnings: parsed.qualityWarnings })
                  : UNASSESSED_EXTRACTION_QUALITY,
              // Format-native metadata (EPUB package/navigation evidence),
              // gated by canonicalFormatMetadata: EPUB requires schema-valid
              // metadata, non-EPUB formats must stay NULL. A violation is an
              // internal parser contract bug and aborts the write (FAILED).
              formatMetadata,
              // 04C-4A: candidate evidence is bound to this immutable extraction.
              // It is not Work/Edition authority; 04C-4B must read it only through
              // the current-extraction fence before considering any promotion.
              productIdentityCandidate,
              textStorageKey: textKey,
              textSha256,
              characterCount: text.length,
            },
          });
          let blockOrdinal = 0;
          for (const [pageOrdinal, page] of parsed.pages.entries()) {
            const dbPage = page.physicalPageIndex === null ? null : await tx.sourcePage.create({
              data: { extractionId: extraction.id, ordinal: pageOrdinal, physicalPageIndex: page.physicalPageIndex },
            });
            for (const block of page.blocks) {
              await tx.sourceBlock.create({
                data: {
                  extractionId: extraction.id,
                  sourcePageId: dbPage?.id,
                  ordinal: blockOrdinal++,
                  kind: block.kind,
                  text: block.text,
                  contentHash: sha256Utf8(block.text),
                  metadata: canonicalBlockMetadata(block, run.sourceDocument.mediaType),
                  // A block either carries a real parser-produced bbox or none at
                  // all; a fake or unit-less guess must never be persisted.
                  bbox: block.bbox ? JSON.parse(JSON.stringify(parseSourceBlockBbox(block.bbox))) : undefined,
                },
              });
            }
          }
          await tx.currentDocumentExtraction.upsert({
            where: { sourceDocumentId_workspaceId: { sourceDocumentId: run.sourceDocumentId, workspaceId: run.workspaceId } },
            create: { sourceDocumentId: run.sourceDocumentId, workspaceId: run.workspaceId, extractionId: extraction.id },
            update: { extractionId: extraction.id },
          });
          if (!run.job.userId) throw new Error("INGESTION_INITIATOR_REQUIRED");
          const bootstrap = await tx.bookAnalysisBootstrap.upsert({
            where: { ingestionRunId: run.id },
            create: {
              workspaceId: run.workspaceId,
              sourceDocumentId: run.sourceDocumentId,
              ingestionRunId: run.id,
              extractionId: extraction.id,
              requestedByUserId: run.job.userId,
            },
            // The ingestion lineage is immutable. A replay may only observe its
            // original durable bootstrap; it must never retarget a new extraction or user.
            update: {},
          });
          await tx.outboxEvent.create({
            data: {
              topic: BOOK_ANALYSIS_BOOTSTRAP_TOPIC,
              aggregateId: bootstrap.id,
              payload: { bootstrapId: bootstrap.id, dispatchGeneration: bootstrap.dispatchGeneration },
            },
          });
          // One-way routing outcome, written inside the same fenced transaction
          // as the publication it describes. Already-written outcomes are only
          // tolerable when byte-equivalent (deterministic decision).
          if (pdfRouting && !await writeRoutingOutcome(run.id, pdfRouting.routingGeneration, pdfRoutingOutcome(pdfRouting.decision, true), tx)) throw new Error(SourceError.ROUTING_PLAN_CONFLICT);
          await completeRunSuccess(tx, run.id, claim.token);
        });
      } catch (error) {
        const code = (error instanceof Error ? error.message.split(":")[0] : undefined) ?? "UNEXPECTED_ERROR";
        // The non-publish outcome + terminal state were already committed by
        // the fenced transaction above; propagate the content error as-is.
        if (nonPublishTerminalized) throw error;
        // RF05 P1-02: the PRE-COMMIT capacity signal is handled BEFORE the
        // generic in-memory ownershipLost shortcut. The PostgreSQL deferral
        // transaction is the authority — the in-memory flag never decides.
        // Committed → the POST-COMMIT scheduler signal is thrown; rejected →
        // the ownership-loss result; DB exception → propagates as
        // infrastructure failure. Redis can never see a capacity signal
        // without the durable ack.
        if (error instanceof OcrCapacityDeferralError) {
          const committed = await transitionOcrCapacityDeferred(error.deferral);
          if (committed) {
            logger.warn("ingestion.ocr_capacity_deferred", { ingestionRunId: run.id, code: "SOURCE_OCR_HOST_CAPACITY" });
            throw new OcrCapacityDeferredError();
          }
          logger.warn("ingestion.ocr_capacity_deferral_rejected", { ingestionRunId: run.id });
          throw new Error(INGESTION_EXECUTION_OWNERSHIP_LOST);
        }
        // Ownership loss writes NOTHING: the new owner (or the reconciler) owns
        // the outcome, and a stale worker must never mutate newer durable state.
        if (code === INGESTION_EXECUTION_OWNERSHIP_LOST || ownershipLost) throw error;
        const failureClass = classifyIngestionFailure(code);
        if (failureClass === "RETRYABLE_RUN" && claim.attemptCount < options.processMaxAttempts) {
          // QUEUED is the retryable durable state; BullMQ's configured attempt
          // policy schedules the next execution, which re-claims the run.
          await transitionRunToRetryable(run.id, claim.token, code);
          logger.warn("ingestion.retry_scheduled", { ingestionRunId: run.id, code, attemptCount: claim.attemptCount });
          throw error;
        }
        const status = failureClass === "TERMINAL_RUN" ? ingestionStatusForTerminalFailure(code) : "FAILED";
        // Fenced terminal write: requires live ownership; a lost race writes nothing.
        await transitionRunToTerminal(run.id, claim.token, status, code);
        logger.error("ingestion.failed", { ingestionRunId: run.id, code, status });
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    },
    async recoverIngestionForUser(context: TrustedRequestContext, sourceDocumentId: string, completion: { outboxTopic?: string } = {}) {
      const membership = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: context.userId } }, select: { userId: true } });
      if (!membership) throw new Error("WORKSPACE_ACCESS_DENIED");
      return prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "SourceDocument" WHERE "id" = ${sourceDocumentId} AND "workspaceId" = ${context.workspaceId} FOR UPDATE`;
        if (locked.length !== 1) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
        const latest = await tx.ingestionRun.findFirst({ where: { sourceDocumentId, workspaceId: context.workspaceId }, orderBy: { createdAt: "desc" }, include: { job: true } });
        if (latest && ["QUEUED", "RUNNING", "SUCCEEDED"].includes(latest.status)) return { run: latest, created: false };
          // Recovery identity belongs to the durable source lineage, never to a
          // particular Job's delivery attempts. The source row lock makes this
          // count a serialized, monotonic generation number.
          const generation = await tx.ingestionRun.count({ where: { sourceDocumentId, workspaceId: context.workspaceId } });
          const job = await tx.job.create({ data: { userId: context.userId, workspaceId: context.workspaceId, type: INGESTION_JOB, payload: { sourceDocumentId }, idempotencyKey: `ingest:${sourceDocumentId}:retry:${generation}` } });
        const run = await tx.ingestionRun.create({ data: { sourceDocumentId, workspaceId: context.workspaceId, jobId: job.id, parserVersion: latest?.parserVersion ?? "recovery", normalizationVersion: latest?.normalizationVersion ?? CANONICAL_NORMALIZATION_VERSION } });
        await tx.outboxEvent.create({ data: { topic: completion.outboxTopic ?? INGESTION_TOPIC, aggregateId: run.id, payload: { ingestionRunId: run.id } } });
        return { run, created: true };
      });
    },
  };
}

type IngestionQueue = { add(name: string, payload: { ingestionRunId: string }, options: { jobId: string }): Promise<unknown> };
export type IngestionDispatchOptions = { batchSize?: number; leaseMs?: number; maxAttempts?: number; dispatchConcurrency?: number; aggregateIds?: string[]; topic?: string; /** Test-only fault seam; runs after queue acceptance and before the DB finalize transaction. */ beforeFinalize?: (eventId: string) => Promise<void> | void };
export async function dispatchPendingIngestion(queue: IngestionQueue, options: IngestionDispatchOptions = {}): Promise<number> {
  const { topic = INGESTION_TOPIC, ...dispatchOptions } = options;
  return dispatchPendingOutbox({ topic, queue, jobName: INGESTION_JOB, parse: (payload) => payload as { ingestionRunId: string }, jobId: (payload) => payload.ingestionRunId, afterDispatch: async (tx, payload, jobId) => { await tx.ingestionRun.update({ where: { id: payload.ingestionRunId }, data: { job: { update: { queueJobId: jobId } } } }); }, ...dispatchOptions });
  /* const batchSize = options.batchSize ?? 100, leaseMs = options.leaseMs ?? 60_000, maxAttempts = options.maxAttempts ?? 5;
  await prisma.$executeRaw`UPDATE "OutboxEvent" SET "status" = 'FAILED'::"OutboxStatus", "leaseUntil" = NULL, "claimToken" = NULL, "lastError" = COALESCE("lastError", 'OUTBOX_MAX_ATTEMPTS_EXCEEDED'), "updatedAt" = NOW() WHERE "topic" = 'source.ingestion.requested' AND "status" = 'PROCESSING'::"OutboxStatus" AND "leaseUntil" < NOW() AND "attemptCount" >= ${maxAttempts}`;
  const events = await prisma.$queryRaw<Array<{ id: string; payload: unknown; claimToken: string }>>`
    WITH candidates AS (
      SELECT "id" FROM "OutboxEvent"
      WHERE "topic" = 'source.ingestion.requested'
        AND (${options.aggregateIds ?? []}::text[] = '{}'::text[] OR "aggregateId" = ANY(${options.aggregateIds ?? []}::text[]))
        AND ("status" = 'PENDING'::"OutboxStatus" OR ("status" = 'PROCESSING'::"OutboxStatus" AND "leaseUntil" < NOW()))
        AND "attemptCount" < ${maxAttempts}
      ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT ${batchSize}
    )
    UPDATE "OutboxEvent" AS event SET "status" = 'PROCESSING'::"OutboxStatus", "claimedAt" = NOW(),
      "claimToken" = md5(random()::text || clock_timestamp()::text || event."id"), "leaseUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond'), "attemptCount" = event."attemptCount" + 1, "updatedAt" = NOW()
    FROM candidates WHERE event."id" = candidates."id" RETURNING event."id", event."payload", event."claimToken"
  `;
  for (const event of events) {
    const ingestionRunId = (event.payload as { ingestionRunId: string }).ingestionRunId;
    try {
      await queue.add(INGESTION_JOB, { ingestionRunId }, { jobId: ingestionRunId });
      await options.beforeFinalize?.(event.id);
      await prisma.$transaction(async (tx) => {
        const marked = await tx.$executeRaw`UPDATE "OutboxEvent" SET "status" = 'DISPATCHED'::"OutboxStatus", "dispatchedAt" = NOW(), "leaseUntil" = NULL, "claimToken" = NULL, "updatedAt" = NOW() WHERE "id" = ${event.id} AND "status" = 'PROCESSING'::"OutboxStatus" AND "claimToken" = ${event.claimToken}`;
        if (marked !== 1) throw new Error("OUTBOX_CLAIM_LOST");
        await tx.ingestionRun.update({ where: { id: ingestionRunId }, data: { job: { update: { queueJobId: ingestionRunId } } } });
      });
    } catch (error) {
      const lastError = error instanceof Error ? error.message.slice(0, 2000) : "UNEXPECTED_ERROR";
      await prisma.$executeRaw`UPDATE "OutboxEvent" SET "status" = CASE WHEN "attemptCount" >= ${maxAttempts} THEN 'FAILED'::"OutboxStatus" ELSE 'PENDING'::"OutboxStatus" END, "leaseUntil" = NULL, "claimToken" = NULL, "lastError" = ${lastError}, "updatedAt" = NOW() WHERE "id" = ${event.id} AND "status" = 'PROCESSING'::"OutboxStatus" AND "claimToken" = ${event.claimToken}`;
    }
  }
  return events.length; */
}
/**
 * Planned parser provenance, recorded when the upload completes — BEFORE any
 * parser has run. This is also why recovery runs inherit the previous value.
 * It is NOT the parser authority for what actually executed: the durable
 * authority is DocumentExtraction (parserName/parserVersion plus
 * canonicalSchemaVersion) and the per-block SourceBlock provenance metadata.
 * New code must never branch on IngestionRun.parserVersion to decide which
 * parser produced an extraction.
 */
function parserProvenance(mediaType: string): { name: string; version: string } {
  if (mediaType === "text/plain") return { name: "builtin-text", version: "text-parser-v1" };
  if (mediaType === "text/markdown") return { name: "builtin-markdown", version: "markdown-parser-v1" };
  // PDF runs are routed/quality-gated since 04B-2: the planned pipeline
  // identity is the router version; the native engine (pdfjs-isolated) remains
  // the per-block provenance authority inside routing plan and extraction.
  if (mediaType === "application/pdf") return { name: "pdfjs-isolated", version: "pdf-router-v1" };
  if (mediaType === "application/epub+zip") return { name: "builtin-epub", version: "epub-parser-v2" };
  return { name: "unsupported", version: "unsupported-v1" };
}
