import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { prisma } from "@ai-cognitive/db";
import { parseCanonicalBlockMetadata } from "@ai-cognitive/domain";
import type { Environment } from "@ai-cognitive/shared/server";
import type { StorageProvider } from "@ai-cognitive/storage";
import { createIngestionService, createMineruPdfOcrExecutor, PDF_ROUTING_GENERATION, resolveMineruExecutorConfig, verifyMineruRuntime } from "../../src/index.js";
import type { MineruExecutorConfig } from "../../src/mineru/mineru-config.js";

/**
 * MACHINE-LOCAL REAL MinerU acceptance gate (BOOK-INGESTION-04B-3).
 *
 * Policy: CI runs the deterministic gates (fake CLI double + unit); THIS gate
 * runs ONLY where a pinned local MinerU 4.0.3 runtime is provisioned, activated
 * by environment:
 *   MINERU_REAL_EXECUTABLE=<absolute mineru executable>
 *   MINERU_REAL_MODEL_PATH=<shared local model root>
 * It is skipped silently otherwise — a missing local runtime never fakes a
 * "real OCR PASS".
 *
 * The production executor path is exercised UNCHANGED: MINERU_MODEL_SOURCE=local
 * plus the executor's process-scoped egress denial are the offline proof — the
 * real OCR must PASS using only the pre-existing local model, and pointing the
 * same code at an intentionally missing model root must yield a bounded
 * SOURCE_OCR_MODEL_NOT_FOUND with ZERO downloaded bytes.
 */

const realExecutable = process.env.MINERU_REAL_EXECUTABLE;
const realModelPath = process.env.MINERU_REAL_MODEL_PATH;
const realGateActive = Boolean(realExecutable && realModelPath);

const fixturePath = join(import.meta.dirname, "../fixtures/mineru/scanned-mixed-real.pdf");

const workspaceIds: string[] = [];
const userIds: string[] = [];
const runIds: string[] = [];
const tempRoots: string[] = [];

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

class FakeStorageProvider implements StorageProvider {
  readonly objects = new Map<string, Uint8Array>();
  async createPresignedUpload(input: { key: string; contentType: string; expiresInSeconds: number }) { return { url: `https://storage.test/${input.key}`, headers: { "content-type": input.contentType } }; }
  async headObject(key: string) { const body = this.objects.get(key); return body ? { key, size: body.length, contentType: "application/pdf" } : null; }
  async getObjectStream(key: string) { const body = await this.getObjectBytes(key); return (async function* () { yield body; })(); }
  async getObjectBytes(key: string) { const body = this.objects.get(key); if (!body) throw new Error(`OBJECT_NOT_FOUND:${key}`); return body; }
  async putObject(input: { key: string; body: Uint8Array; contentType: string }) { this.objects.set(input.key, input.body); }
  async copyObject(sourceKey: string, targetKey: string) { this.objects.set(targetKey, await this.getObjectBytes(sourceKey)); }
  async deleteObject(key: string) { this.objects.delete(key); }
  async objectExists(key: string) { return this.objects.has(key); }
}

async function realConfig(modelPath: string, hostId: string): Promise<MineruExecutorConfig> {
  const tempRoot = mkdtempSync(join(tmpdir(), "mineru-real-"));
  tempRoots.push(tempRoot);
  const environment = {
    REDIS_URL: "redis://localhost:6379",
    OCR_PROVIDER: "mineru",
    MINERU_MODEL_SOURCE: "local",
    MINERU_MODEL_PATH: modelPath,
    MINERU_EXECUTABLE: realExecutable,
    MINERU_TIER: "flash",
    MINERU_TIMEOUT_MS: 300_000,
    MINERU_SERVER_START_TIMEOUT_MS: 180_000,
    MINERU_SERVER_STOP_TIMEOUT_MS: 60_000,
    MINERU_HOME_ROOT: join(tempRoot, "homes"),
    MINERU_MAX_OUTPUT_BYTES: 8_000_000,
    MINERU_CAPACITY_RETRY_DELAY_MS: 30_000,
    OCR_HOST_ID: hostId,
  } as unknown as Environment;
  const config = resolveMineruExecutorConfig(environment)!;
  // RF01 P1-08: the REAL acceptance proves the actual local runtime reports
  // the pinned version through the same argv probe production uses.
  const verification = await verifyMineruRuntime(config);
  expect(verification.version).toBe("4.0.3");
  return config;
}

async function createPdfRunFixture(bytes: Uint8Array, storage: FakeStorageProvider) {
  const user = await prisma.user.create({ data: { email: `mineru-real-${crypto.randomUUID()}@test`, name: "MinerU Real" } });
  const workspace = await prisma.workspace.create({ data: { name: `mineru-real-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const storageKey = `test/${crypto.randomUUID()}`;
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256(storageKey), sizeBytes: bytes.length, mediaType: "application/pdf", storageKey } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "scanned-mixed-real.pdf" } });
  const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: bytes.length, mediaType: "application/pdf", storageKey } });
  const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id } } });
  const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "pdf-router-v1", normalizationVersion: "canonical-text-v1" } });
  runIds.push(run.id);
  storage.objects.set(storageKey, bytes);
  return { user, workspace, document, job, run, storageKey };
}

const attemptRow = (workspaceId: string, runId: string, physicalPageIndex: number) => prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: runId, physicalPageIndex, routingGeneration: PDF_ROUTING_GENERATION } } });

/** Deterministic byte-level snapshot of the model root (recursive sizes only — content is never modified by a local-only run). */
function modelRootFingerprint(root: string): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        entries += 1;
        bytes += statSync(path).size;
      }
    }
  };
  walk(root);
  return { entries, bytes };
}

const normalizeOcr = (text: string) => text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

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
    await prisma.ocrServerInstance.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
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
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

afterAll(async () => { await prisma.$disconnect(); });

describe.skipIf(!realGateActive)("REAL MinerU production cutover acceptance (machine-local, pinned 4.0.3)", () => {
  it("REAL_MIXED_PDF_OFFLINE_CUTOVER: routed mixed PDF publishes with exact provenance using ONLY the local model (network denied at the process boundary)", { timeout: 900_000 }, async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    const config = await realConfig(realModelPath!, `mineru-real-${crypto.randomUUID()}`);
    const fingerprintBefore = modelRootFingerprint(realModelPath!);
    const handle = createMineruPdfOcrExecutor(config);
    try {
      await createIngestionService(storage, { maxUploadBytes: 100 * 1024 * 1024, uploadTtlSeconds: 900, maxPdfPages: 2000, completionLeaseMs: 900000, processMaxAttempts: 3, pdfOcrExecutor: handle.executor }).processIngestionRun(run.id);

      const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(succeeded.status).toBe("SUCCEEDED");
      expect(succeeded.routingPlan).toMatchObject({ pageCount: 3, pages: [
        { physicalPageIndex: 0, route: "NATIVE_TEXT" },
        { physicalPageIndex: 1, route: "OCR_REQUIRED" },
        { physicalPageIndex: 2, route: "NATIVE_TEXT" },
      ] });
      expect(succeeded.routingOutcome).toMatchObject({ outcome: "PUBLISHED", qualityStatus: "DEGRADED" });

      const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
      expect(extraction).toMatchObject({ status: "SUCCEEDED", parserName: "pdfjs-isolated", parserVersion: "pdf-router-v1", qualityStatus: "DEGRADED" });

      const pages = await prisma.sourcePage.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
      expect(pages.map((page) => page.physicalPageIndex)).toEqual([0, 1, 2]);
      const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
      const provenance = blocks.map((block) => parseCanonicalBlockMetadata(block.metadata).provenance);
      const ocrBlocks = blocks.filter((block) => parseCanonicalBlockMetadata(block.metadata).provenance.sourceMethod === "OCR");
      expect(ocrBlocks.length).toBeGreaterThanOrEqual(1);
      for (const metadata of provenance.filter((entry) => entry.sourceMethod === "OCR")) {
        expect(metadata).toMatchObject({ sourceMethod: "OCR", parserName: "mineru", parserVersion: "4.0.3" });
      }
      for (const metadata of provenance.filter((entry) => entry.sourceMethod === "NATIVE_TEXT")) {
        expect(metadata).toMatchObject({ parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" });
      }
      // The OCR block carries the EXACT requested physical page (invocation binding authority).
      const ocrBlock = ocrBlocks[0]!;
      expect(parseCanonicalBlockMetadata(ocrBlock.metadata).locator).toMatchObject({ kind: "pdf", physicalPageIndex: 1 });
      // Real OCR recovered the raster marker text (MinerU splits the page into
      // several blocks; the page's recovered content is judged as a whole).
      const ocrText = normalizeOcr(ocrBlocks.map((block) => block.text).join("\n"));
      expect(ocrText.length).toBeGreaterThan(100);
      expect(ocrText).toContain("mineru");
      expect(ocrText).toContain("orbit");

      const attempt = await attemptRow(workspace.id, run.id, 1);
      expect(attempt).toMatchObject({ status: "SUCCEEDED", parserName: "mineru", parserVersion: "4.0.3", parserMode: "flash", modelRevision: null });
      expect(await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: run.sourceDocumentId, workspaceId: workspace.id } } })).toMatchObject({ extractionId: extraction.id });
      expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(1);

      // Exactly one real MinerU invocation, one claim-scoped server, fully stopped.
      expect(handle.executor.calls).toEqual([expect.objectContaining({ physicalPageIndex: 1, outcome: "SUCCEEDED" })]);
      const servers = await prisma.ocrServerInstance.findMany({ where: { ingestionRunId: run.id } });
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({ status: "STOPPED", hostId: config.hostId });

      // LOCAL-OFFLINE PROOF: the shared model root is byte-identical after the run.
      const fingerprintAfter = modelRootFingerprint(realModelPath!);
      expect(fingerprintAfter).toEqual(fingerprintBefore);
    } finally {
      await handle.close();
    }
  });

  it("REAL_MISSING_MODEL_FAILS_CLOSED: an empty local model root yields a bounded SOURCE_OCR_MODEL_NOT_FOUND with zero downloads", { timeout: 300_000 }, async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath));
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    const emptyModelRoot = join(mkdtempSync(join(tmpdir(), "mineru-real-nomodel-")), "models");
    mkdirSync(emptyModelRoot, { recursive: true });
    tempRoots.push(emptyModelRoot);
    const config = await realConfig(emptyModelRoot, `mineru-real-nomodel-${crypto.randomUUID()}`);
    const handle = createMineruPdfOcrExecutor(config);
    try {
      await expect(createIngestionService(storage, { maxUploadBytes: 100 * 1024 * 1024, uploadTtlSeconds: 900, maxPdfPages: 2000, completionLeaseMs: 900000, processMaxAttempts: 3, pdfOcrExecutor: handle.executor }).processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_REQUIRED");

      const failed = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(failed.status).toBe("OCR_REQUIRED");
      expect(await attemptRow(workspace.id, run.id, 1)).toMatchObject({ status: "FAILED", attemptCount: 1, errorCode: "SOURCE_OCR_MODEL_NOT_FOUND" });
      expect(await prisma.documentExtraction.count({ where: { ingestionRunId: run.id } })).toBe(0);
      // ZERO attempted model download: no model repo or model file appeared in
      // the root (MinerU may leave only local lock scaffolding like .locks).
      const entries = readdirSync(emptyModelRoot);
      expect(entries.filter((entry) => !entry.startsWith(".")).length).toBe(0);
      const servers = await prisma.ocrServerInstance.findMany({ where: { ingestionRunId: run.id } });
      expect(servers.length).toBeGreaterThanOrEqual(1);
      expect(servers.every((server) => server.status === "STOPPED")).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
