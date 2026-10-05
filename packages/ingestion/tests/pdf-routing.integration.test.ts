import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { prisma } from "@ai-cognitive/db";
import { CANONICAL_SCHEMA_VERSION, parseCanonicalBlockMetadata, parseExtractionQualityMetadata } from "@ai-cognitive/domain";
import type { StorageProvider } from "@ai-cognitive/storage";
import { createIngestionService, DEFAULT_PARSER_LIMITS, evaluatePdfExtractionQuality, extractNativePdf, PDF_ROUTING_GENERATION, PDF_ROUTING_OUTCOME_SCHEMA_VERSION, PDF_ROUTING_PLAN_SCHEMA_VERSION, pdfRoutingOutcome, planPdfRouting, terminalizeRunWithRoutingOutcome } from "../src/index.js";
import { claimIngestionRun, lockRunForPublication, renewIngestionRunClaim, transitionRunToTerminal } from "../src/ingestion-run-claim.js";
import { claimOcrPageAttempt, completeOcrPageAttempt, createOcrPageIntents, writeRoutingOutcome, writeRoutingPlan } from "../src/ocr-durability.js";
import { FakePdfOcrExecutor, fakeOcrTerminalFailure, fakeOcrText, fakeOcrTransientFailure } from "./helpers/pdf/fake-ocr-executor.js";

const workspaceIds: string[] = [];
const userIds: string[] = [];
const runIds: string[] = [];

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

class FakeStorageProvider implements StorageProvider {
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: string[] = [];

  async createPresignedUpload(input: { key: string; contentType: string; expiresInSeconds: number }) {
    return { url: `https://storage.test/${input.key}`, headers: { "content-type": input.contentType } };
  }
  async headObject(key: string) { const body = this.objects.get(key); return body ? { key, size: body.length, contentType: "application/pdf" } : null; }
  async getObjectStream(key: string) {
    const body = await this.getObjectBytes(key);
    return (async function* () { yield body; })();
  }
  async getObjectBytes(key: string) { const body = this.objects.get(key); if (!body) throw new Error(`OBJECT_NOT_FOUND:${key}`); return body; }
  async putObject(input: { key: string; body: Uint8Array; contentType: string }) { this.puts.push(input.key); this.objects.set(input.key, input.body); }
  async copyObject(sourceKey: string, targetKey: string) { this.objects.set(targetKey, await this.getObjectBytes(sourceKey)); }
  async deleteObject(key: string) { this.objects.delete(key); }
  async objectExists(key: string) { return this.objects.has(key); }
}

/** Fault seam: simulates a crash after OCR success but before canonical-text publication. */
class TextKeyFailingStorage extends FakeStorageProvider {
  failTextKeys = true;
  async putObject(input: { key: string; body: Uint8Array; contentType: string }) {
    if (this.failTextKeys && input.key.includes("/text/")) throw new Error("STORAGE_PUT_FAILED");
    await super.putObject(input);
  }
}

/** 1x1 PNG: raster content without any text (scanned-page analog). */
const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function buildPdf(pages: Array<(document: InstanceType<typeof PDFDocument>) => void>): Promise<Uint8Array> {
  const document = new PDFDocument({ autoFirstPage: false });
  const stream = new PassThrough(), chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Uint8Array>((resolve) => stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks)))));
  document.pipe(stream);
  for (const draw of pages) {
    document.addPage();
    draw(document);
  }
  document.end();
  return complete;
}

/** page 0 native text, page 1 scanned/image-only, page 2 native text. */
const mixedPdf = () => buildPdf([(document) => document.text("Hello PDF"), (document) => document.image(png1x1, 50, 50, { width: 60 }), (document) => document.text("Second Page")]);
/** page 0 native text, page 1 genuinely blank, page 2 native text. */
const blankMiddlePdf = () => buildPdf([(document) => document.text("Hello PDF"), () => undefined, (document) => document.text("Second Page")]);
const allBlankPdf = () => buildPdf([() => undefined, () => undefined]);

async function createPdfRunFixture(bytes: Uint8Array, storage?: FakeStorageProvider) {
  const user = await prisma.user.create({ data: { email: `pdf-route-${crypto.randomUUID()}@test`, name: "Pdf Route" } });
  const workspace = await prisma.workspace.create({ data: { name: `pdf-route-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const storageKey = `test/${crypto.randomUUID()}`;
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256(storageKey), sizeBytes: bytes.length, mediaType: "application/pdf", storageKey } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "router-test.pdf" } });
  const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: bytes.length, mediaType: "application/pdf", storageKey } });
  const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id } } });
  const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "pdf-router-v1", normalizationVersion: "canonical-text-v1" } });
  runIds.push(run.id);
  storage?.objects.set(storageKey, bytes);
  return { user, workspace, document, job, run, storageKey };
}

function serviceWith(storage: FakeStorageProvider, executor?: FakePdfOcrExecutor) {
  return createIngestionService(storage, { maxUploadBytes: 100 * 1024 * 1024, uploadTtlSeconds: 900, maxPdfPages: 2000, completionLeaseMs: 900000, processMaxAttempts: 3, ...(executor ? { pdfOcrExecutor: executor } : {}) });
}

const attemptKey = (workspaceId: string, runId: string, physicalPageIndex: number) => ({ workspaceId, ingestionRunId: runId, physicalPageIndex, routingGeneration: PDF_ROUTING_GENERATION });
const attemptRow = (workspaceId: string, runId: string, physicalPageIndex: number) => prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: runId, physicalPageIndex, routingGeneration: PDF_ROUTING_GENERATION } } });

/** Reopens a terminal run for redelivery the way the queue reconciler would. */
async function requeueRun(runId: string) {
  await prisma.ingestionRun.update({ where: { id: runId }, data: { status: "QUEUED", errorCode: null, completedAt: null } });
  await prisma.job.update({ where: { id: (await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runId }, select: { jobId: true } })).jobId }, data: { status: "QUEUED", completedAt: null } });
}

afterEach(async () => {
  if (runIds.length) {
    const bootstraps = await prisma.bookAnalysisBootstrap.findMany({ where: { ingestionRunId: { in: runIds } }, select: { id: true } });
    if (bootstraps.length) await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: bootstraps.map((bootstrap) => bootstrap.id) } } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
  }
  if (workspaceIds.length) {
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.bookAnalysisBootstrap.deleteMany({ where: { ingestionRunId: { in: runIds } } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ocrPageAttempt.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  workspaceIds.length = 0;
  userIds.length = 0;
  runIds.length = 0;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("mixed PDF routing (real PostgreSQL)", () => {
  it("MIXED_PDF_NO_OCR: routes per page, persists the durable plan, and terminalizes OCR_REQUIRED without partial publication", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);

    const service = serviceWith(storage);
    await expect(service.processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_REQUIRED");

    const failed = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed.status).toBe("OCR_REQUIRED");
    expect(failed.errorCode).toBe("SOURCE_OCR_REQUIRED");
    // Durable routing plan: versioned, complete, native parser identity preserved.
    expect(failed.routingGeneration).toBe(PDF_ROUTING_GENERATION);
    expect(failed.routingPlan).toMatchObject({ schemaVersion: PDF_ROUTING_PLAN_SCHEMA_VERSION, pageCount: 3, parser: { name: "pdfjs-isolated", version: "pdf-isolation-v3" } });
    expect(failed.routingPlan).toMatchObject({ pages: [{ physicalPageIndex: 0, route: "NATIVE_TEXT" }, { physicalPageIndex: 1, route: "OCR_REQUIRED", reasonCodes: ["IMAGE_CONTENT_WITHOUT_TEXT"] }, { physicalPageIndex: 2, route: "NATIVE_TEXT" }] });
    // One-way terminal outcome with the unresolved page recorded.
    expect(failed.routingOutcome).toEqual({ schemaVersion: PDF_ROUTING_OUTCOME_SCHEMA_VERSION, outcome: "REQUIRES_FALLBACK", qualityStatus: "REQUIRES_FALLBACK", unresolvedPhysicalPageIndexes: [1] });
    // Durable OCR intent exists; nothing was published.
    expect(await prisma.ocrPageAttempt.findMany({ where: { ingestionRunId: run.id } })).toMatchObject([{ physicalPageIndex: 1, status: "PENDING", attemptCount: 0 }]);
    expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: run.sourceDocumentId } })).toBe(0);
    expect(await prisma.currentDocumentExtraction.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(0);

    // Redelivery must reuse the immutable plan — never recalculate or overwrite it.
    const planBefore = JSON.stringify(failed.routingPlan);
    const outcomeBefore = JSON.stringify(failed.routingOutcome);
    await requeueRun(run.id);
    await expect(service.processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_REQUIRED");
    const redelivered = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(JSON.stringify(redelivered.routingPlan)).toBe(planBefore);
    expect(JSON.stringify(redelivered.routingOutcome)).toBe(outcomeBefore);
    expect(await prisma.ocrPageAttempt.count({ where: { ingestionRunId: run.id } })).toBe(1);
    expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: run.sourceDocumentId } })).toBe(0);
  });

  it("MIXED_PDF_FAKE_OCR: fake executor resolves page 1 through the durable attempt machine and the merged document publishes", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    const executor = new FakePdfOcrExecutor().script(1, [fakeOcrText("scanned page one text")]);
    const service = serviceWith(storage, executor);

    await service.processIngestionRun(run.id);

    const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(succeeded.status).toBe("SUCCEEDED");
    expect(succeeded.routingOutcome).toEqual({ schemaVersion: PDF_ROUTING_OUTCOME_SCHEMA_VERSION, outcome: "PUBLISHED", qualityStatus: "DEGRADED", unresolvedPhysicalPageIndexes: [] });

    const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
    expect(extraction.status).toBe("SUCCEEDED");
    expect(extraction.parserName).toBe("pdfjs-isolated");
    expect(extraction.parserVersion).toBe("pdf-router-v1");
    // OCR fallback content is explicit, recorded degradation — never silent UNKNOWN.
    expect(extraction.qualityStatus).toBe("DEGRADED");
    expect(parseExtractionQualityMetadata(extraction.qualityMetadata)).toEqual({ warnings: ["OCR_USED"] });

    const pages = await prisma.sourcePage.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
    expect(pages.map((page) => page.physicalPageIndex)).toEqual([0, 1, 2]);
    const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => parseCanonicalBlockMetadata(block.metadata))).toMatchObject([
      { locator: { kind: "pdf", physicalPageIndex: 0, printedPageLabel: null }, provenance: { sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" } },
      { locator: { kind: "pdf", physicalPageIndex: 1, printedPageLabel: null }, provenance: { sourceMethod: "OCR", parserName: "fake-ocr", parserVersion: "fake-ocr-v1" } },
      { locator: { kind: "pdf", physicalPageIndex: 2, printedPageLabel: null }, provenance: { sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" } },
    ]);
    expect(blocks[1]?.sourcePageId).toBe(pages[1]?.id);
    expect(blocks.map((block) => block.text)).toEqual(["Hello PDF", "scanned page one text", "Second Page"]);

    // The page result went through the SAME durable attempt machine 04B-3 will use.
    const attempt = await attemptRow(workspace.id, run.id, 1);
    expect(attempt.status).toBe("SUCCEEDED");
    expect(attempt.attemptCount).toBe(1);
    expect(attempt.parserName).toBe("fake-ocr");
    expect(attempt.parserVersion).toBe("fake-ocr-v1");
    expect(attempt.textSha256).toBe(sha256("scanned page one text"));
    expect(attempt.authoritativeArtifactKey).toBe(`workspaces/${workspace.id}/extractions/${run.id}/ocr-pages/1/${sha256("scanned page one text")}.txt`);
    expect(await storage.objectExists(attempt.authoritativeArtifactKey!)).toBe(true);

    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: run.sourceDocumentId, workspaceId: workspace.id } } });
    expect(current.extractionId).toBe(extraction.id);
    const bootstrap = await prisma.bookAnalysisBootstrap.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
    expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(1);
    expect(await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: bootstrap.id } })).toMatchObject({ topic: "book.analysis.bootstrap.requested" });
    expect(executor.calls).toEqual([expect.objectContaining({ physicalPageIndex: 1, ingestionRunId: run.id, workspaceId: workspace.id, routingGeneration: PDF_ROUTING_GENERATION, pdfByteLength: bytes.length })]);
  });

  it("TRUE_BLANK_PAGE: a genuinely blank page is represented, published, and never sent to OCR", async () => {
    const bytes = await blankMiddlePdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    const executor = new FakePdfOcrExecutor();
    const service = serviceWith(storage, executor);

    await service.processIngestionRun(run.id);

    const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(succeeded.status).toBe("SUCCEEDED");
    expect(succeeded.routingPlan).toMatchObject({ pages: expect.arrayContaining([{ physicalPageIndex: 1, route: "NATIVE_TEXT", contentEvidence: "EMPTY", reasonCodes: ["EMPTY_PAGE"] }]) });
    expect(await prisma.ocrPageAttempt.count({ where: { ingestionRunId: run.id } })).toBe(0);
    // The "all zero text = OCR" regression guard: the executor is never invoked.
    expect(executor.calls).toEqual([]);

    const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
    expect(extraction.qualityStatus).toBe("ACCEPTED");
    expect(parseExtractionQualityMetadata(extraction.qualityMetadata)).toEqual({ warnings: [] });
    const pages = await prisma.sourcePage.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
    expect(pages.map((page) => page.physicalPageIndex)).toEqual([0, 1, 2]);
    const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.sourcePageId)).toEqual([pages[0]?.id, pages[2]?.id]);
    expect(await prisma.currentDocumentExtraction.count({ where: { workspaceId: workspace.id } })).toBe(1);
  });

  it("OCR_TRANSIENT_RETRY: retryable executor failures follow the durable attempt authority, not a second counter", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    const executor = new FakePdfOcrExecutor().script(1, [fakeOcrTransientFailure(), fakeOcrText("recovered scan text")]);
    const service = serviceWith(storage, executor);

    await service.processIngestionRun(run.id);

    const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(succeeded.status).toBe("SUCCEEDED");
    const attempt = await attemptRow(workspace.id, run.id, 1);
    expect(attempt.status).toBe("SUCCEEDED");
    expect(attempt.attemptCount).toBe(2);
    expect(attempt.textSha256).toBe(sha256("recovered scan text"));
    const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
    expect(extraction.qualityStatus).toBe("DEGRADED");
    const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
    expect(blocks[1]?.text).toBe("recovered scan text");
  });

  it("OCR_TERMINAL_FAILURE: a terminally failed required page blocks publication entirely", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    const executor = new FakePdfOcrExecutor().script(1, [fakeOcrTerminalFailure()]);
    const service = serviceWith(storage, executor);

    await expect(service.processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_REQUIRED");

    const failed = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed.status).toBe("OCR_REQUIRED");
    expect(await attemptRow(workspace.id, run.id, 1)).toMatchObject({ status: "FAILED", attemptCount: 1, errorCode: "SOURCE_OCR_ENGINE_CRASH" });
    expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: run.sourceDocumentId } })).toBe(0);
    expect(await prisma.currentDocumentExtraction.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(0);
    // The routing plan is immutable; native pages were never reclassified.
    expect(failed.routingPlan).toMatchObject({ pages: [{ physicalPageIndex: 0, route: "NATIVE_TEXT" }, { physicalPageIndex: 1, route: "OCR_REQUIRED" }, { physicalPageIndex: 2, route: "NATIVE_TEXT" }] });
  });
});

describe("true blank-only document (quality REJECTED)", () => {
  it("QUALITY_REJECTS an all-blank PDF instead of publishing an empty canonical document", async () => {
    const bytes = await allBlankPdf();
    const storage = new FakeStorageProvider();
    const { run } = await createPdfRunFixture(bytes, storage);
    const service = serviceWith(storage);

    await expect(service.processIngestionRun(run.id)).rejects.toThrow("SOURCE_QUALITY_REJECTED");

    const rejected = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.errorCode).toBe("SOURCE_QUALITY_REJECTED");
    expect(rejected.routingOutcome).toEqual({ schemaVersion: PDF_ROUTING_OUTCOME_SCHEMA_VERSION, outcome: "REJECTED", qualityStatus: "REJECTED", unresolvedPhysicalPageIndexes: [] });
    expect(await prisma.ocrPageAttempt.count({ where: { ingestionRunId: run.id } })).toBe(0);
    expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: run.sourceDocumentId } })).toBe(0);
  });
});

describe("routing plan replay fence (real PostgreSQL)", () => {
  it("fails closed when a persisted immutable plan conflicts with runtime inspection", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { run } = await createPdfRunFixture(bytes, storage);
    // A structurally valid but WRONG plan is persisted first (simulated drift).
    const wrong = planPdfRouting({ parser: { name: "pdfjs-isolated", version: "pdf-isolation-v3" }, inspections: (await extractNativePdf(bytes, DEFAULT_PARSER_LIMITS)).inspections.map((inspection) => ({ ...inspection, route: "NATIVE_TEXT" as const, contentEvidence: inspection.contentEvidence === "TEXT" ? "TEXT" as const : "EMPTY" as const })) });
    expect(await writeRoutingPlan(run.id, PDF_ROUTING_GENERATION, wrong)).toBe(true);

    const service = serviceWith(storage, new FakePdfOcrExecutor());
    await expect(service.processIngestionRun(run.id)).rejects.toThrow("SOURCE_ROUTING_PLAN_CONFLICT");

    const failed = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed.status).toBe("FAILED");
    expect(failed.errorCode).toBe("SOURCE_ROUTING_PLAN_CONFLICT");
    // Persisted history was never silently fixed.
    expect(failed.routingPlan).toEqual(wrong);
    expect(failed.routingOutcome).toBeNull();
    expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: run.sourceDocumentId } })).toBe(0);
  });

  it("fails closed on a structurally invalid persisted plan", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { run } = await createPdfRunFixture(bytes, storage);
    expect(await writeRoutingPlan(run.id, PDF_ROUTING_GENERATION, { garbage: true })).toBe(true);

    await expect(serviceWith(storage).processIngestionRun(run.id)).rejects.toThrow("SOURCE_ROUTING_PLAN_CONTRACT_INVALID");

    const failed = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed.status).toBe("FAILED");
    expect(failed.errorCode).toBe("SOURCE_ROUTING_PLAN_CONTRACT_INVALID");
    expect(failed.routingPlan).toEqual({ garbage: true });
  });
});

describe("stale owner fencing across PDF routing (real PostgreSQL)", () => {
  it("STALE_OWNER_FENCED: A cannot overwrite plan/outcome, complete B's page attempt, or publish after B reclaims", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, document, run } = await createPdfRunFixture(bytes, storage);

    // A claims the run, prepares routing state, and claims the OCR page attempt.
    const claimA = (await claimIngestionRun(run.id, 3))!;
    expect(claimA).not.toBeNull();
    const native = await extractNativePdf(bytes, DEFAULT_PARSER_LIMITS);
    expect(await writeRoutingPlan(run.id, PDF_ROUTING_GENERATION, native.routingPlan)).toBe(true);
    await createOcrPageIntents({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, routingGeneration: PDF_ROUTING_GENERATION, pages: [{ physicalPageIndex: 1 }] });
    const attemptA = (await claimOcrPageAttempt({ ...attemptKey(workspace.id, run.id, 1), sourceDocumentId: document.id, parserName: "stale-executor", parserVersion: "stale-v1" }))!;

    // A's run lease and page lease expire; B reclaims through the production path.
    await prisma.$executeRaw`UPDATE "IngestionRun" SET "executionLeaseUntil" = NOW() - INTERVAL '1 second' WHERE "id" = ${run.id}`;
    await prisma.$executeRaw`UPDATE "OcrPageAttempt" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "ingestionRunId" = ${run.id}`;
    const executor = new FakePdfOcrExecutor().script(1, [fakeOcrText("B authoritative scan text")]);
    await serviceWith(storage, executor).processIngestionRun(run.id);

    const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(succeeded.status).toBe("SUCCEEDED");
    // B took over the durable page attempt: attemptCount is shared, never reset.
    const attempt = await attemptRow(workspace.id, run.id, 1);
    expect(attempt).toMatchObject({ status: "SUCCEEDED", attemptCount: 2, claimToken: expect.any(String) });
    expect(attempt.parserName).toBe("fake-ocr");
    expect(attempt.textSha256).toBe(sha256("B authoritative scan text"));

    // A returns late and cannot touch any newer durable state.
    expect(await completeOcrPageAttempt({ ...attemptKey(workspace.id, run.id, 1), claimToken: attemptA.claimToken, authoritativeArtifactKey: "stale/attempt", textSha256: "stale", durationMs: 1 })).toBe(false);
    expect(await writeRoutingPlan(run.id, PDF_ROUTING_GENERATION, { mutated: true })).toBe(false);
    expect(await writeRoutingOutcome(run.id, PDF_ROUTING_GENERATION, { mutated: true })).toBe(false);
    expect(await renewIngestionRunClaim(run.id, claimA.token)).toBe(false);
    expect(await transitionRunToTerminal(run.id, claimA.token, "FAILED", "LATE_OWNER")).toBe(false);
    expect(await prisma.$transaction((tx) => lockRunForPublication(tx, run.id, claimA.token))).toBe(false);

    // B's publication stands: one extraction, one bootstrap, current pointer intact.
    const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
    expect(extraction.parserVersion).toBe("pdf-router-v1");
    expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: document.id } })).toBe(1);
    expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(1);
    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });
    expect(current.extractionId).toBe(extraction.id);
    expect(succeeded.routingOutcome).toMatchObject({ outcome: "PUBLISHED" });
    expect(succeeded.routingPlan).toEqual(native.routingPlan);
    expect(extraction.canonicalSchemaVersion).toBe(CANONICAL_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// RF01 repairs: durable resume, live-page reclaim, fenced non-publish outcome,
// zero-usable-text OCR rejection.
// ---------------------------------------------------------------------------

describe("RF01 durable OCR resume (real PostgreSQL)", () => {
  it("OCR_SUCCESS_RESUMED: a SUCCEEDED page checkpoint is reused on retry without any executor call", async () => {
    const bytes = await mixedPdf();
    const storage = new TextKeyFailingStorage();
    const { workspace, document, run } = await createPdfRunFixture(bytes, storage);
    // Execution 1: OCR page succeeds durably, then the run crashes before the
    // canonical text artifact (and thus before any publication).
    const firstExecutor = new FakePdfOcrExecutor().script(1, [fakeOcrText("resumable scan text")]);
    await expect(serviceWith(storage, firstExecutor).processIngestionRun(run.id)).rejects.toThrow("STORAGE_PUT_FAILED");
    expect(await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "QUEUED" });
    const checkpoint = await attemptRow(workspace.id, run.id, 1);
    expect(checkpoint).toMatchObject({ status: "SUCCEEDED", attemptCount: 1 });
    expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: document.id } })).toBe(0);
    expect(await prisma.currentDocumentExtraction.count({ where: { workspaceId: workspace.id } })).toBe(0);

    // Execution 2 (retry/reclaim): the checkpoint is authoritative — no remote
    // OCR work, no attempt budget burn, publication completes from the artifact.
    storage.failTextKeys = false;
    const resumedExecutor = new FakePdfOcrExecutor();
    await serviceWith(storage, resumedExecutor).processIngestionRun(run.id);

    expect(resumedExecutor.calls).toEqual([]);
    const resumed = await attemptRow(workspace.id, run.id, 1);
    expect(resumed.status).toBe("SUCCEEDED");
    expect(resumed.attemptCount).toBe(1);
    expect(resumed.claimToken).toBe(checkpoint.claimToken);
    const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(succeeded.status).toBe("SUCCEEDED");
    expect(succeeded.routingOutcome).toMatchObject({ outcome: "PUBLISHED", qualityStatus: "DEGRADED" });
    expect(healthyArtifactReadable(storage, resumed.authoritativeArtifactKey)).toBe(true);    const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
    expect(extraction.qualityStatus).toBe("DEGRADED");
    const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
    expect(blocks[1]?.text).toBe("resumable scan text");
    expect(parseCanonicalBlockMetadata(blocks[1]?.metadata).provenance).toMatchObject({ sourceMethod: "OCR", parserName: "fake-ocr", parserVersion: "fake-ocr-v1" });
    expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(1);
    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });
    expect(current.extractionId).toBe(extraction.id);
  });
});

describe("RF01 live page attempt after run reclaim (real PostgreSQL)", () => {
  it("LIVE_PAGE_RECLAIM: B (authoritative run owner) reclaims A's still-live page claim; A's late completion fails", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, document, run } = await createPdfRunFixture(bytes, storage);
    // A claims the run, prepares routing state, and claims the page (live lease).
    const claimA = (await claimIngestionRun(run.id, 3))!;
    const native = await extractNativePdf(bytes, DEFAULT_PARSER_LIMITS);
    expect(await writeRoutingPlan(run.id, PDF_ROUTING_GENERATION, native.routingPlan)).toBe(true);
    await createOcrPageIntents({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, routingGeneration: PDF_ROUTING_GENERATION, pages: [{ physicalPageIndex: 1 }] });
    const attemptA = (await claimOcrPageAttempt({ ...attemptKey(workspace.id, run.id, 1), sourceDocumentId: document.id, parserName: "stale-executor", parserVersion: "stale-v1" }))!;
    expect((await attemptRow(workspace.id, run.id, 1)).leaseUntil?.getTime()).toBeGreaterThan(Date.now());

    // ONLY the run lease expires; the page lease is untouched and still live.
    await prisma.$executeRaw`UPDATE "IngestionRun" SET "executionLeaseUntil" = NOW() - INTERVAL '1 second' WHERE "id" = ${run.id}`;
    // Without run-execution authority the live claim is untouchable...
    expect(await claimOcrPageAttempt({ ...attemptKey(workspace.id, run.id, 1), sourceDocumentId: document.id, parserName: "unauthorized", parserVersion: "x" })).toBeNull();
    // ...but B reclaims the run through normal claim authority and takes over.
    const executor = new FakePdfOcrExecutor().script(1, [fakeOcrText("B reclaimed scan text")]);
    await serviceWith(storage, executor).processIngestionRun(run.id);

    const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(succeeded.status).toBe("SUCCEEDED");
    const attempt = await attemptRow(workspace.id, run.id, 1);
    expect(attempt).toMatchObject({ status: "SUCCEEDED", attemptCount: 2, parserName: "fake-ocr" });
    expect(attempt.textSha256).toBe(sha256("B reclaimed scan text"));
    // A's superseded page claim can never complete afterward.
    expect(await completeOcrPageAttempt({ ...attemptKey(workspace.id, run.id, 1), claimToken: attemptA.claimToken, authoritativeArtifactKey: "stale/attempt", textSha256: "stale", durationMs: 1 })).toBe(false);
    const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
    expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: document.id } })).toBe(1);
    expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(1);
    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });
    expect(current.extractionId).toBe(extraction.id);
    const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
    expect(blocks[1]?.text).toBe("B reclaimed scan text");
  });
});

describe("RF01 fenced non-publish routing outcome (real PostgreSQL)", () => {
  it("STALE_OUTCOME_FENCED: a superseded owner changes zero durable state; only B's claim writes the outcome", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, document, run } = await createPdfRunFixture(bytes, storage);
    // A claims the run and prepares routing state like the production pipeline.
    const claimA = (await claimIngestionRun(run.id, 3))!;
    const native = await extractNativePdf(bytes, DEFAULT_PARSER_LIMITS);
    expect(await writeRoutingPlan(run.id, PDF_ROUTING_GENERATION, native.routingPlan)).toBe(true);
    await createOcrPageIntents({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, routingGeneration: PDF_ROUTING_GENERATION, pages: [{ physicalPageIndex: 1 }] });
    const outcomes = new Map(native.routingPlan.pages.map((page) => [page.physicalPageIndex, page.route === "OCR_REQUIRED" ? "UNRESOLVED_FALLBACK" as const : "NATIVE_TEXT" as const]));
    const decision = evaluatePdfExtractionQuality(native.routingPlan, outcomes, new Map(native.routingPlan.pages.map((page) => [page.physicalPageIndex, page.route === "OCR_REQUIRED" ? 0 : 2])));
    const outcome = pdfRoutingOutcome(decision, false);

    // A's run lease expires before A terminalizes; A has not observed the
    // heartbeat loss and attempts the non-publish path anyway.
    await prisma.$executeRaw`UPDATE "IngestionRun" SET "executionLeaseUntil" = NOW() - INTERVAL '1 second' WHERE "id" = ${run.id}`;
    expect(await terminalizeRunWithRoutingOutcome(run.id, claimA.token, "OCR_REQUIRED", "SOURCE_OCR_REQUIRED", PDF_ROUTING_GENERATION, outcome)).toBe(false);
    const afterA = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterA.routingOutcome).toBeNull();
    expect(afterA.status).toBe("RUNNING");
    expect(afterA.errorCode).toBeNull();

    // B reclaims through the production path and owns the terminal state.
    await expect(serviceWith(storage).processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_REQUIRED");
    const afterB = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterB.status).toBe("OCR_REQUIRED");
    expect(afterB.errorCode).toBe("SOURCE_OCR_REQUIRED");
    // No conflict caused by A: the slot was still null, so B wrote it.
    expect(afterB.routingOutcome).toEqual(outcome);
    expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: document.id } })).toBe(0);
    void workspace;
  });
});

describe("RF01 zero-usable-text OCR results (real PostgreSQL)", () => {
  it.each([
    ["empty text", ""],
    ["whitespace-only text", "   \n\t"],
    ["BOM-only text", "\uFEFF"],
  ])("blocks %s OCR success from publishing and exhausts the durable attempt budget", async (_name, ocrText) => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, document, run } = await createPdfRunFixture(bytes, storage);
    const executor = new FakePdfOcrExecutor().script(1, [fakeOcrText(ocrText)]);
    await expect(serviceWith(storage, executor).processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_REQUIRED");

    const failed = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed.status).toBe("OCR_REQUIRED");
    expect(failed.errorCode).toBe("SOURCE_OCR_REQUIRED");
    // Every attempt went through the durable authority (no second counter);
    // the page is FAILED with the stable no-usable-text code, never accepted.
    expect(await attemptRow(workspace.id, run.id, 1)).toMatchObject({ status: "FAILED", attemptCount: 3, errorCode: "SOURCE_OCR_NO_USABLE_TEXT" });
    expect(executor.calls).toHaveLength(3);
    expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: document.id } })).toBe(0);
    expect(await prisma.currentDocumentExtraction.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(0);
    // Routing plan immutable; native pages never reclassified.
    expect(failed.routingPlan).toMatchObject({ pages: [{ physicalPageIndex: 0, route: "NATIVE_TEXT" }, { physicalPageIndex: 1, route: "OCR_REQUIRED" }, { physicalPageIndex: 2, route: "NATIVE_TEXT" }] });
    expect(failed.routingOutcome).toMatchObject({ outcome: "REQUIRES_FALLBACK", unresolvedPhysicalPageIndexes: [1] });
  });
});

/** Verifies an artifact reference resolves inside the given provider. */
function healthyArtifactReadable(storage: FakeStorageProvider, key: string | null): boolean {
  return key !== null && storage.objects.has(key);
}
