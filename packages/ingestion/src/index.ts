import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { prisma, JobStatus } from "@ai-cognitive/db";
import { sha256Utf8 } from "@ai-cognitive/domain";
import { logger } from "@ai-cognitive/shared";
import type { StorageProvider } from "@ai-cognitive/storage";
import type { Queue } from "bullmq";
import { CANONICAL_BLOCK_SEPARATOR, CANONICAL_NORMALIZATION_VERSION, normalizeCanonicalText } from "./canonical-text.js";
import { inspectObjectStream } from "./object-inspection.js";

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
  throw new Error("MIME_SPOOF_OR_UNSUPPORTED");
}
export function createIngestionService(storage: StorageProvider, options = { maxUploadBytes: 100 * 1024 * 1024, uploadTtlSeconds: 900, maxPdfPages: 2000 }) {
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
      if (session.expiresAt < new Date()) { await prisma.uploadSession.update({ where: { id: session.id }, data: { status: "EXPIRED" } }); throw new Error("UPLOAD_EXPIRED"); }
      const head = await storage.headObject(session.temporaryStorageKey); if (!head || head.size !== Number(session.declaredSizeBytes) || head.size > options.maxUploadBytes) { await prisma.uploadSession.update({ where: { id: session.id }, data: { status: "REJECTED" } }); throw new Error("UPLOAD_SIZE_INVALID"); }
      const inspected = await inspectObjectStream(await storage.getObjectStream(session.temporaryStorageKey));
      if (inspected.sizeBytes !== head.size || inspected.sizeBytes !== Number(session.declaredSizeBytes)) { await prisma.uploadSession.update({ where: { id: session.id }, data: { status: "REJECTED" } }); throw new Error("UPLOAD_STORAGE_SIZE_MISMATCH"); }
      const mediaType = sniffMediaType(inspected.prefix, session.declaredMediaType, session.originalFilename); const digest = inspected.sha256; const storageKey = `workspaces/${context.workspaceId}/source-blobs/${digest}`;
      const existing = await prisma.sourceBlob.findUnique({ where: { workspaceId_sha256: { workspaceId: context.workspaceId, sha256: digest } } });
      let canonicalWasCreated = false;
      if (existing) {
        const existingHead = await storage.headObject(existing.storageKey);
        if (!existingHead || existingHead.size !== inspected.sizeBytes) throw new Error("CANONICAL_STORAGE_INTEGRITY_FAILURE");
      } else {
        const canonicalHead = await storage.headObject(storageKey);
        if (!canonicalHead) {
          await storage.copyObject(session.temporaryStorageKey, storageKey);
          canonicalWasCreated = true;
        }
        const canonicalInspection = await inspectObjectStream(await storage.getObjectStream(storageKey));
        if (canonicalInspection.sha256 !== digest || canonicalInspection.sizeBytes !== inspected.sizeBytes) {
          if (canonicalWasCreated) await storage.deleteObject(storageKey).catch(() => undefined);
          throw new Error("CANONICAL_STORAGE_INTEGRITY_FAILURE");
        }
      }
      const parser = parserProvenance(mediaType);
      const result = await prisma.$transaction(async (tx) => { const blob = existing ?? await tx.sourceBlob.create({ data: { workspaceId: context.workspaceId, sha256: digest, sizeBytes: inspected.sizeBytes, mediaType, storageKey } }); const source = await tx.source.create({ data: { workspaceId: context.workspaceId, kind: "FILE", displayName: session.originalFilename } }); const document = await tx.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: context.workspaceId, version: 1, sha256: blob.sha256, sizeBytes: blob.sizeBytes, mediaType, storageKey: blob.storageKey } }); const job = await tx.job.create({ data: { userId: context.userId, workspaceId: context.workspaceId, type: INGESTION_JOB, payload: { sourceDocumentId: document.id }, idempotencyKey: `ingest:${document.id}` } }); const run = await tx.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: context.workspaceId, jobId: job.id, parserVersion: parser.version, normalizationVersion: CANONICAL_NORMALIZATION_VERSION } }); await tx.uploadCompletion.create({ data: { uploadSessionId: session.id, sourceDocumentId: document.id, workspaceId: context.workspaceId } }); await tx.outboxEvent.create({ data: { topic: "source.ingestion.requested", aggregateId: run.id, payload: { ingestionRunId: run.id } } }); await tx.uploadSession.update({ where: { id: session.id }, data: { status: "COMPLETED", completedAt: new Date() } }); return document; });
      await storage.deleteObject(session.temporaryStorageKey); return result;
    },
    async processIngestionRun(runId: string) {
      const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId }, include: { sourceDocument: { include: { source: true } }, job: true } }); if (run.status === "SUCCEEDED") return;
      await prisma.$transaction([prisma.ingestionRun.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: new Date() } }), prisma.job.update({ where: { id: run.jobId }, data: { status: JobStatus.RUNNING, startedAt: new Date(), attemptCount: { increment: 1 } } })]);
      try {
        const bytes = await storage.getObjectBytes(run.sourceDocument.storageKey);
        const parsed = await parseDocument(bytes, run.sourceDocument.mediaType, options.maxPdfPages);
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
      } catch (error) { const code = error instanceof Error ? error.message.split(":")[0] : "UNEXPECTED_ERROR"; await prisma.$transaction([prisma.ingestionRun.update({ where: { id: run.id }, data: { status: "FAILED", errorCode: code, completedAt: new Date() } }), prisma.job.update({ where: { id: run.jobId }, data: { status: JobStatus.FAILED, error: { code }, completedAt: new Date() } })]); logger.error("ingestion.failed", { ingestionRunId: run.id, code }); throw error; }
    },
  };
}

export async function dispatchPendingIngestion(queue: Queue<{ ingestionRunId: string }>): Promise<number> {
  const events = await prisma.outboxEvent.findMany({ where: { topic: "source.ingestion.requested", dispatchedAt: null }, orderBy: { createdAt: "asc" }, take: 100 });
  for (const event of events) { const ingestionRunId = (event.payload as { ingestionRunId: string }).ingestionRunId; await queue.add(INGESTION_JOB, { ingestionRunId }, { jobId: ingestionRunId }); await prisma.$transaction([prisma.outboxEvent.update({ where: { id: event.id }, data: { dispatchedAt: new Date() } }), prisma.ingestionRun.update({ where: { id: ingestionRunId }, data: { job: { update: { queueJobId: ingestionRunId } } } })]); }
  return events.length;
}
type ParserProvenance = { name: string; version: string };
type SourceBlockKind = "HEADING" | "PARAGRAPH" | "LIST_ITEM" | "QUOTE" | "TABLE" | "IMAGE" | "CAPTION" | "FOOTNOTE" | "CODE" | "EQUATION" | "UNKNOWN";
type ParsedBlock = { kind: SourceBlockKind; text: string };
type Parsed = { parser: ParserProvenance; pages: Array<{ physicalPageIndex: number | null; blocks: ParsedBlock[] }> };

function parserProvenance(mediaType: string): ParserProvenance {
  if (mediaType === "text/plain") return { name: "builtin-text", version: "text-parser-v1" };
  if (mediaType === "text/markdown") return { name: "builtin-markdown", version: "markdown-parser-v1" };
  if (mediaType === "application/pdf") return { name: "pdftotext", version: "pdftotext-adapter-v1" };
  return { name: "unsupported", version: "unsupported-v1" };
}

async function parseDocument(bytes: Uint8Array, mediaType: string, maxPdfPages: number): Promise<Parsed> {
  if (mediaType === "text/plain") return blocksFromText(Buffer.from(bytes).toString("utf8"), "PARAGRAPH", parserProvenance(mediaType));
  if (mediaType === "text/markdown") return { parser: parserProvenance(mediaType), pages: [{ physicalPageIndex: null, blocks: markdownBlocks(Buffer.from(bytes).toString("utf8")) }] };
  if (mediaType === "application/pdf") return parsePdf(bytes, maxPdfPages);
  if (mediaType === "application/epub+zip") throw new Error("EPUB_PARSER_NOT_AVAILABLE");
  throw new Error("UNSUPPORTED_MEDIA_TYPE");
}

function splitCanonicalBlocks(text: string): string[] {
  const normalized = normalizeCanonicalText(text, { stripDocumentBom: true });
  return normalized.split(/\n[ \t]*\n+/).map((block) => normalizeCanonicalText(block)).filter(Boolean);
}

function blocksFromText(text: string, kind: SourceBlockKind, parser: ParserProvenance): Parsed {
  return { parser, pages: [{ physicalPageIndex: null, blocks: splitCanonicalBlocks(text).map((value) => ({ kind, text: value })) }] };
}

function markdownBlocks(text: string): ParsedBlock[] {
  return splitCanonicalBlocks(text).map((block) => ({
    kind: /^#{1,6}\s/.test(block) ? "HEADING" : /^[-*+]\s/.test(block) ? "LIST_ITEM" : /^>\s/.test(block) ? "QUOTE" : /^```/.test(block) ? "CODE" : "PARAGRAPH",
    text: block,
  }));
}

async function parsePdf(bytes: Uint8Array, maxPages: number): Promise<Parsed> { if (!Buffer.from(bytes.slice(0, 8)).toString().startsWith("%PDF-")) throw new Error("SOURCE_CORRUPTED"); const directory = join(tmpdir(), `ai-cognitive-${randomUUID()}`); await mkdir(directory); const input = join(directory, "source.pdf"), output = join(directory, "source.txt"); try { await writeFile(input, bytes); await new Promise<void>((resolve, reject) => { const child = spawn(process.env.PDFTOTEXT_PATH ?? "pdftotext", ["-enc", "UTF-8", input, output], { windowsHide: true }); child.on("error", () => reject(new Error("PDF_PARSER_UNAVAILABLE"))); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("SOURCE_CORRUPTED"))); }); const pages = (await readFile(output, "utf8")).split("\f").map((text, index) => ({ physicalPageIndex: index, blocks: markdownBlocks(text) })).filter((page) => page.blocks.length); if (!pages.length) throw new Error("OCR_REQUIRED"); if (pages.length > maxPages) throw new Error("PDF_PAGE_LIMIT_EXCEEDED"); return { parser: parserProvenance("application/pdf"), pages }; } finally { await rm(directory, { recursive: true, force: true }); } }
