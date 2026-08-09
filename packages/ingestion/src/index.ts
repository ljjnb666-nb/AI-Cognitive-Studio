import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { prisma, JobStatus } from "@ai-cognitive/db";
import { logger } from "@ai-cognitive/shared";
import type { StorageProvider } from "@ai-cognitive/storage";
import type { Queue } from "bullmq";

export type TrustedRequestContext = { userId: string; workspaceId: string };
export const INGESTION_QUEUE = "source.ingestion";
export const INGESTION_JOB = "source.ingest";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const safeFilename = (value: string) => value.replace(/[\\/]/g, "_").split("").map((character) => character.charCodeAt(0) < 32 ? "_" : character).join("").slice(0, 180) || "source";
export const validateSourceSpan = (text: string, start: number, end: number, quote: string) => start >= 0 && end <= text.length && start < end && text.slice(start, end) === quote;

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
      if (session.status === "COMPLETED") return prisma.sourceDocument.findUniqueOrThrow({ where: { id: session.sourceDocumentId! } });
      if (session.expiresAt < new Date()) { await prisma.uploadSession.update({ where: { id: session.id }, data: { status: "EXPIRED" } }); throw new Error("UPLOAD_EXPIRED"); }
      const head = await storage.headObject(session.temporaryStorageKey); if (!head || head.size !== Number(session.declaredSizeBytes) || head.size > options.maxUploadBytes) { await prisma.uploadSession.update({ where: { id: session.id }, data: { status: "REJECTED" } }); throw new Error("UPLOAD_SIZE_INVALID"); }
      const bytes = await storage.getObjectBytes(session.temporaryStorageKey); const mediaType = sniffMediaType(bytes, session.declaredMediaType, session.originalFilename); const digest = sha256(bytes); const storageKey = `workspaces/${context.workspaceId}/source-blobs/${digest}`;
      const existing = await prisma.sourceBlob.findUnique({ where: { workspaceId_sha256: { workspaceId: context.workspaceId, sha256: digest } } }); if (!existing) { if (!(await storage.objectExists(storageKey))) await storage.copyObject(session.temporaryStorageKey, storageKey); }
      const result = await prisma.$transaction(async (tx) => { const blob = existing ?? await tx.sourceBlob.create({ data: { workspaceId: context.workspaceId, sha256: digest, sizeBytes: bytes.length, mediaType, storageKey } }); const source = await tx.source.create({ data: { workspaceId: context.workspaceId, kind: "FILE", displayName: session.originalFilename } }); const document = await tx.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: digest, sizeBytes: bytes.length, mediaType, storageKey } }); const job = await tx.job.create({ data: { userId: context.userId, type: INGESTION_JOB, payload: { sourceDocumentId: document.id }, idempotencyKey: `ingest:${document.id}` } }); const run = await tx.ingestionRun.create({ data: { sourceDocumentId: document.id, jobId: job.id, parserVersion: "phase-1", normalizationVersion: "v1" } }); await tx.outboxEvent.create({ data: { topic: "source.ingestion.requested", aggregateId: run.id, payload: { ingestionRunId: run.id } } }); await tx.uploadSession.update({ where: { id: session.id }, data: { status: "COMPLETED", completedAt: new Date(), sourceDocumentId: document.id } }); return document; });
      await storage.deleteObject(session.temporaryStorageKey); return result;
    },
    async processIngestionRun(runId: string) {
      const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId }, include: { sourceDocument: { include: { source: true } }, job: true } }); if (run.status === "SUCCEEDED") return;
      await prisma.$transaction([prisma.ingestionRun.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: new Date() } }), prisma.job.update({ where: { id: run.jobId }, data: { status: JobStatus.RUNNING, startedAt: new Date(), attemptCount: { increment: 1 } } })]);
      try { const bytes = await storage.getObjectBytes(run.sourceDocument.storageKey); const parsed = await parseDocument(bytes, run.sourceDocument.mediaType, options.maxPdfPages); const text = parsed.pages.flatMap((page) => page.blocks.map((block) => block.text)).join("\n"); const textKey = `workspaces/${run.sourceDocument.source.workspaceId}/extractions/${run.id}/text.txt`; await storage.putObject({ key: textKey, body: Buffer.from(text), contentType: "text/plain; charset=utf-8" }); let offset = 0;
        await prisma.$transaction(async (tx) => { const extraction = await tx.documentExtraction.create({ data: { ingestionRunId: run.id, status: "SUCCEEDED", textStorageKey: textKey, textSha256: sha256(text), characterCount: text.length } }); for (const [pageIndex, page] of parsed.pages.entries()) { const dbPage = await tx.sourcePage.create({ data: { extractionId: extraction.id, ordinal: pageIndex, physicalPageIndex: page.physicalPageIndex, printedPageLabel: null } }); for (const [ordinal, block] of page.blocks.entries()) { const start = offset; offset += block.text.length; await tx.sourceBlock.create({ data: { extractionId: extraction.id, sourcePageId: dbPage.id, ordinal: pageIndex * 100000 + ordinal, kind: block.kind, textStart: start, textEnd: offset, contentHash: sha256(block.text) } }); offset += 1; } } await tx.ingestionRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", completedAt: new Date() } }); await tx.job.update({ where: { id: run.jobId }, data: { status: JobStatus.SUCCEEDED, progress: 100, completedAt: new Date() } }); });
      } catch (error) { const code = error instanceof Error ? error.message.split(":")[0] : "UNEXPECTED_ERROR"; await prisma.$transaction([prisma.ingestionRun.update({ where: { id: run.id }, data: { status: "FAILED", errorCode: code, completedAt: new Date() } }), prisma.job.update({ where: { id: run.jobId }, data: { status: JobStatus.FAILED, error: { code }, completedAt: new Date() } })]); logger.error("ingestion.failed", { ingestionRunId: run.id, code }); throw error; }
    },
  };
}

export async function dispatchPendingIngestion(queue: Queue<{ ingestionRunId: string }>): Promise<number> {
  const events = await prisma.outboxEvent.findMany({ where: { topic: "source.ingestion.requested", dispatchedAt: null }, orderBy: { createdAt: "asc" }, take: 100 });
  for (const event of events) { const ingestionRunId = (event.payload as { ingestionRunId: string }).ingestionRunId; await queue.add(INGESTION_JOB, { ingestionRunId }, { jobId: ingestionRunId }); await prisma.$transaction([prisma.outboxEvent.update({ where: { id: event.id }, data: { dispatchedAt: new Date() } }), prisma.ingestionRun.update({ where: { id: ingestionRunId }, data: { job: { update: { queueJobId: ingestionRunId } } } })]); }
  return events.length;
}
type Parsed = { pages: Array<{ physicalPageIndex: number | null; blocks: Array<{ kind: string; text: string }> }> };
async function parseDocument(bytes: Uint8Array, mediaType: string, maxPdfPages: number): Promise<Parsed> { if (mediaType === "text/plain") return blocksFromText(Buffer.from(bytes).toString("utf8"), "PARAGRAPH"); if (mediaType === "text/markdown") return { pages: [{ physicalPageIndex: 1, blocks: markdownBlocks(Buffer.from(bytes).toString("utf8")) }] }; if (mediaType === "application/pdf") return parsePdf(bytes, maxPdfPages); if (mediaType === "application/epub+zip") throw new Error("EPUB_PARSER_NOT_AVAILABLE"); throw new Error("UNSUPPORTED_MEDIA_TYPE"); }
const blocksFromText = (text: string, kind: string): Parsed => ({ pages: [{ physicalPageIndex: 1, blocks: text.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean).map((text) => ({ kind, text })) }] });
const markdownBlocks = (text: string) => text.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean).map((text) => ({ kind: /^#{1,6}\s/.test(text) ? "HEADING" : /^[-*+]\s/.test(text) ? "LIST" : /^>\s/.test(text) ? "QUOTE" : /^```/.test(text) ? "CODE" : "PARAGRAPH", text }));
async function parsePdf(bytes: Uint8Array, maxPages: number): Promise<Parsed> { if (!Buffer.from(bytes.slice(0, 8)).toString().startsWith("%PDF-")) throw new Error("SOURCE_CORRUPTED"); const directory = join(tmpdir(), `ai-cognitive-${randomUUID()}`); await mkdir(directory); const input = join(directory, "source.pdf"), output = join(directory, "source.txt"); try { await writeFile(input, bytes); await new Promise<void>((resolve, reject) => { const child = spawn(process.env.PDFTOTEXT_PATH ?? "pdftotext", ["-enc", "UTF-8", input, output], { windowsHide: true }); child.on("error", () => reject(new Error("PDF_PARSER_UNAVAILABLE"))); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("SOURCE_CORRUPTED"))); }); const pages = (await readFile(output, "utf8")).split("\f").map((text, index) => ({ physicalPageIndex: index + 1, blocks: markdownBlocks(text) })).filter((page) => page.blocks.length); if (!pages.length) throw new Error("OCR_REQUIRED"); if (pages.length > maxPages) throw new Error("PDF_PAGE_LIMIT_EXCEEDED"); return { pages }; } finally { await rm(directory, { recursive: true, force: true }); } }
