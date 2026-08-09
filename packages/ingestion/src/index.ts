import { randomUUID } from "node:crypto";
import { prisma, JobStatus } from "@ai-cognitive/db";
import { sha256Utf8 } from "@ai-cognitive/domain";
import { logger } from "@ai-cognitive/shared";
import type { StorageProvider } from "@ai-cognitive/storage";
import { CANONICAL_BLOCK_SEPARATOR, CANONICAL_NORMALIZATION_VERSION } from "./canonical-text.js";
import { inspectObjectStream } from "./object-inspection.js";
import { parseDocument } from "./document-parsers.js";
import { SourceError } from "./source-errors.js";
import { claimUploadCompletion, rejectCompletionClaim, releaseCompletionClaim, renewCompletionClaim } from "./upload-completion-claim.js";
export { cleanupTemporaryUploads } from "./temporary-upload-cleanup.js";
export { SourceError, sourceErrorForParserResult } from "./source-errors.js";
export { parseDocument, DEFAULT_PARSER_LIMITS } from "./document-parsers.js";

export type TrustedRequestContext = { userId: string; workspaceId: string };
export const INGESTION_QUEUE = "source.ingestion";
export const INGESTION_JOB = "source.ingest";
const safeFilename = (value: string) => value.replace(/[\\/]/g, "_").split("").map((character) => character.charCodeAt(0) < 32 ? "_" : character).join("").slice(0, 180) || "source";

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
export function createIngestionService(storage: StorageProvider, options = { maxUploadBytes: 100 * 1024 * 1024, uploadTtlSeconds: 900, maxPdfPages: 2000, completionLeaseMs: 900000 }) {
  async function assertMembership(context: TrustedRequestContext) { const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: context } }); if (!member) throw new Error("WORKSPACE_ACCESS_DENIED"); }
  return {
    async createUploadIntent(context: TrustedRequestContext, input: { filename: string; mediaType: string; sizeBytes: number }) {
      await assertMembership(context); if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > options.maxUploadBytes) throw new Error("UPLOAD_SIZE_INVALID");
      const id = randomUUID(); const temporaryStorageKey = `temporary/${context.workspaceId}/${id}`; const expiresAt = new Date(Date.now() + options.uploadTtlSeconds * 1000);
      const session = await prisma.uploadSession.create({ data: { id, workspaceId: context.workspaceId, originalFilename: safeFilename(input.filename), declaredMediaType: input.mediaType, declaredSizeBytes: input.sizeBytes, temporaryStorageKey, expiresAt } });
      const upload = await storage.createPresignedUpload({ key: temporaryStorageKey, contentType: input.mediaType, expiresInSeconds: options.uploadTtlSeconds }); return { session, upload };
    },
    async completeUpload(context: TrustedRequestContext, sessionId: string) {
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
          const source = await tx.source.create({ data: { workspaceId: context.workspaceId, kind: "FILE", displayName: session.originalFilename } }); const document = await tx.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: context.workspaceId, version: 1, sha256: blob.sha256, sizeBytes: blob.sizeBytes, mediaType, storageKey: blob.storageKey } }); const job = await tx.job.create({ data: { userId: context.userId, workspaceId: context.workspaceId, type: INGESTION_JOB, payload: { sourceDocumentId: document.id }, idempotencyKey: `ingest:${document.id}` } }); const run = await tx.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: context.workspaceId, jobId: job.id, parserVersion: parser.version, normalizationVersion: CANONICAL_NORMALIZATION_VERSION } }); await tx.uploadCompletion.create({ data: { uploadSessionId: session.id, sourceDocumentId: document.id, workspaceId: context.workspaceId } }); await tx.outboxEvent.create({ data: { topic: "source.ingestion.requested", aggregateId: run.id, payload: { ingestionRunId: run.id } } });
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
      const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId }, include: { sourceDocument: { include: { source: true } }, job: true } }); if (run.status === "SUCCEEDED") return;
      await prisma.$transaction([prisma.ingestionRun.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: new Date() } }), prisma.job.update({ where: { id: run.jobId }, data: { status: JobStatus.RUNNING, startedAt: new Date(), attemptCount: { increment: 1 } } })]);
      try {
        const bytes = await storage.getObjectBytes(run.sourceDocument.storageKey);
        const parsed = await parseDocument(bytes, run.sourceDocument.mediaType, { maxPdfPages: options.maxPdfPages });
        const canonicalBlocks = parsed.pages.flatMap((page) => page.blocks);
        const text = canonicalBlocks.map((block) => block.text).join(CANONICAL_BLOCK_SEPARATOR);
        const textKey = `workspaces/${run.sourceDocument.source.workspaceId}/extractions/${run.id}/text.txt`;
        await storage.putObject({ key: textKey, body: Buffer.from(text, "utf8"), contentType: "text/plain; charset=utf-8" });

        await prisma.$transaction(async (tx) => {
          const extraction = await tx.documentExtraction.create({
            data: {
              ingestionRunId: run.id,
              sourceDocumentId: run.sourceDocumentId,
              workspaceId: run.workspaceId,
              status: "SUCCEEDED",
              parserName: parsed.parser.name,
              parserVersion: parsed.parser.version,
              normalizationVersion: CANONICAL_NORMALIZATION_VERSION,
              textStorageKey: textKey,
              textSha256: sha256Utf8(text),
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
                  metadata: block.metadata ? JSON.parse(JSON.stringify(block.metadata)) : undefined,
                },
              });
            }
          }
          await tx.currentDocumentExtraction.upsert({
            where: { sourceDocumentId_workspaceId: { sourceDocumentId: run.sourceDocumentId, workspaceId: run.workspaceId } },
            create: { sourceDocumentId: run.sourceDocumentId, workspaceId: run.workspaceId, extractionId: extraction.id },
            update: { extractionId: extraction.id },
          });
          await tx.ingestionRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", completedAt: new Date() } });
          await tx.job.update({ where: { id: run.jobId }, data: { status: JobStatus.SUCCEEDED, progress: 100, completedAt: new Date() } });
        });
      } catch (error) { const code = error instanceof Error ? error.message.split(":")[0] : "UNEXPECTED_ERROR"; const status = code === SourceError.OCR_REQUIRED ? "OCR_REQUIRED" : code === SourceError.PASSWORD_REQUIRED ? "PASSWORD_REQUIRED" : [SourceError.TYPE_MISMATCH, SourceError.UNSUPPORTED_TYPE, SourceError.TOO_LARGE, SourceError.ARCHIVE_UNSAFE, SourceError.CORRUPTED].includes(code as never) ? "REJECTED" : "FAILED"; await prisma.$transaction([prisma.ingestionRun.update({ where: { id: run.id }, data: { status, errorCode: code, completedAt: new Date() } }), prisma.job.update({ where: { id: run.jobId }, data: { status: JobStatus.FAILED, error: { code }, completedAt: new Date() } })]); logger.error("ingestion.failed", { ingestionRunId: run.id, code }); throw error; }
    },
  };
}

type IngestionQueue = { add(name: string, payload: { ingestionRunId: string }, options: { jobId: string }): Promise<unknown> };
export type IngestionDispatchOptions = { batchSize?: number; leaseMs?: number; maxAttempts?: number; aggregateIds?: string[]; /** Test-only fault seam; runs after queue acceptance and before the DB finalize transaction. */ beforeFinalize?: (eventId: string) => Promise<void> | void };
export async function dispatchPendingIngestion(queue: IngestionQueue, options: IngestionDispatchOptions = {}): Promise<number> {
  const batchSize = options.batchSize ?? 100, leaseMs = options.leaseMs ?? 60_000, maxAttempts = options.maxAttempts ?? 5;
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
  return events.length;
}
function parserProvenance(mediaType: string): { name: string; version: string } {
  if (mediaType === "text/plain") return { name: "builtin-text", version: "text-parser-v1" };
  if (mediaType === "text/markdown") return { name: "builtin-markdown", version: "markdown-parser-v1" };
  if (mediaType === "application/pdf") return { name: "pdfjs-isolated", version: "pdf-isolation-v3" };
  if (mediaType === "application/epub+zip") return { name: "builtin-epub", version: "epub-parser-v1" };
  return { name: "unsupported", version: "unsupported-v1" };
}
