import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { prisma } from "@ai-cognitive/db";
import { parseCanonicalBlockMetadata, parseExtractionQualityMetadata } from "@ai-cognitive/domain";
import type { Environment } from "@ai-cognitive/shared/server";
import type { StorageProvider } from "@ai-cognitive/storage";
import { createIngestionService, createMineruPdfOcrExecutor, PDF_ROUTING_GENERATION, resolveMineruExecutorConfig } from "../../src/index.js";
import { acquireOcrHostLease, releaseOcrHostLease } from "../../src/ocr-durability.js";
import { recordedProcessAlive } from "../../src/mineru/mineru-process.js";
import type { MineruExecutorConfig } from "../../src/mineru/mineru-config.js";

/**
 * Real-executor integration gate (BOOK-INGESTION-04B-3): the PRODUCTION
 * MineruPdfOcrExecutor — real process spawning, host leasing, durable server
 * identity, temp isolation, failure classification — driven by a TEST-ONLY
 * MinerU CLI double (helpers/mineru/fake-mineru.mjs) that emulates the
 * 04B-0-verified 4.0.3 contract. The machine-local REAL MinerU acceptance
 * lives in mineru-real.integration.test.ts and is kept separate by policy.
 */

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const fakeMineruPath = join(import.meta.dirname, "../helpers/mineru/fake-mineru.mjs");

const workspaceIds: string[] = [];
const userIds: string[] = [];
const runIds: string[] = [];
const tempRoots: string[] = [];

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

function newTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mineru-it-"));
  tempRoots.push(root);
  return root;
}

type ConfigOverrides = Partial<MineruExecutorConfig>;

/** Builds a production-shaped config (through the real resolver) pointed at the fake CLI double. */
function fakeMineruConfig(overrides: ConfigOverrides = {}): MineruExecutorConfig {
  const tempRoot = newTempRoot();
  const modelsDir = join(tempRoot, "models");
  mkdirSync(modelsDir, { recursive: true });
  const environment = {
    REDIS_URL: "redis://localhost:6379",
    OCR_PROVIDER: "mineru",
    MINERU_MODEL_SOURCE: "local",
    MINERU_MODEL_PATH: modelsDir,
    MINERU_EXECUTABLE: process.execPath,
    MINERU_EXECUTABLE_ARGS: JSON.stringify([fakeMineruPath]),
    MINERU_TIER: "flash",
    MINERU_VERSION: "4.0.3",
    MINERU_TIMEOUT_MS: 15_000,
    MINERU_SERVER_START_TIMEOUT_MS: 15_000,
    MINERU_SERVER_STOP_TIMEOUT_MS: 10_000,
    MINERU_HOME_ROOT: join(tempRoot, "homes"),
    MINERU_MAX_OUTPUT_BYTES: 1_000_000,
    MINERU_CAPACITY_RETRY_DELAY_MS: 60_000,
    OCR_HOST_ID: `mineru-it-${crypto.randomUUID()}`,
  } as unknown as Environment;
  const config = resolveMineruExecutorConfig(environment)!;
  // Test-only internal knobs: the double's runtime image (pid-reuse guard) and
  // a fast host-lease heartbeat so lease-loss tests stay deterministic.
  return { ...config, processImagePattern: /node|python/i, heartbeatIntervalMs: 200, ...overrides };
}

function serviceWith(storage: FakeStorageProvider, executor?: ReturnType<typeof createMineruPdfOcrExecutor>["executor"]) {
  return createIngestionService(storage, { maxUploadBytes: 100 * 1024 * 1024, uploadTtlSeconds: 900, maxPdfPages: 2000, completionLeaseMs: 900000, processMaxAttempts: 3, ...(executor ? { pdfOcrExecutor: executor } : {}) });
}

async function createPdfRunFixture(bytes: Uint8Array, storage: FakeStorageProvider) {
  const user = await prisma.user.create({ data: { email: `mineru-it-${crypto.randomUUID()}@test`, name: "MinerU IT" } });
  const workspace = await prisma.workspace.create({ data: { name: `mineru-it-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const storageKey = `test/${crypto.randomUUID()}`;
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256(storageKey), sizeBytes: bytes.length, mediaType: "application/pdf", storageKey } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "mineru-it.pdf" } });
  const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: bytes.length, mediaType: "application/pdf", storageKey } });
  const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id } } });
  const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "pdf-router-v1", normalizationVersion: "canonical-text-v1" } });
  runIds.push(run.id);
  storage.objects.set(storageKey, bytes);
  return { user, workspace, document, job, run, storageKey };
}

const attemptRow = (workspaceId: string, runId: string, physicalPageIndex: number) => prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: runId, physicalPageIndex, routingGeneration: PDF_ROUTING_GENERATION } } });

async function waitForServerInstance(runId: string, status: "STARTING" | "RUNNING" | "STOPPED" | "ORPHANED") {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const row = await prisma.ocrServerInstance.findFirst({ where: { ingestionRunId: runId, status }, orderBy: { createdAt: "asc" } });
    if (row) return row;
    if (Date.now() >= deadline) throw new Error(`server instance never reached ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterEach(async () => {
  // Env knobs FIRST: a later cleanup failure must never leak fake modes into
  // the next test (they would silently change its teardown behavior).
  delete process.env.MINERU_FAKE_MODE;
  delete process.env.MINERU_FAKE_TEXT;
  delete process.env.MINERU_FAKE_DELAY_MS;
  delete process.env.MINERU_FAKE_OVERSIZE_BYTES;
  delete process.env.MINERU_FAKE_STOP_MODE;
  delete process.env.MINERU_FAKE_STOP_LOG;
  delete process.env.MINERU_FAKE_SERVER_START_MODE;
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
  // Bounded retry: a just-killed dummy can hold its home CWD for a moment.
  for (const root of tempRoots) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  tempRoots.length = 0;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("MinerU executor production cutover (real executor, CLI double)", () => {
  it("OCR_CUTOVER_SUCCESS: mixed PDF publishes through the real executor with full provenance, durable server identity, and clean claim teardown", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    process.env.MINERU_FAKE_TEXT = "recovered scanned page one body";
    const config = fakeMineruConfig();
    const handle = createMineruPdfOcrExecutor(config);
    try {
      await serviceWith(storage, handle.executor).processIngestionRun(run.id);

      const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(succeeded.status).toBe("SUCCEEDED");
      expect(succeeded.routingOutcome).toMatchObject({ outcome: "PUBLISHED", qualityStatus: "DEGRADED" });

      const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
      expect(extraction).toMatchObject({ status: "SUCCEEDED", parserName: "pdfjs-isolated", parserVersion: "pdf-router-v1", qualityStatus: "DEGRADED" });
      expect(parseExtractionQualityMetadata(extraction.qualityMetadata)).toEqual({ warnings: ["OCR_USED"] });

      const pages = await prisma.sourcePage.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
      expect(pages.map((page) => page.physicalPageIndex)).toEqual([0, 1, 2]);
      const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
      expect(blocks.map((block) => parseCanonicalBlockMetadata(block.metadata)).map((metadata) => metadata.provenance)).toMatchObject([
        { sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" },
        { sourceMethod: "OCR", parserName: "mineru", parserVersion: "4.0.3" },
        { sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" },
      ]);
      expect(blocks[1]?.text).toBe("recovered scanned page one body");

      const attempt = await attemptRow(workspace.id, run.id, 1);
      expect(attempt).toMatchObject({ status: "SUCCEEDED", attemptCount: 1, parserName: "mineru", parserVersion: "4.0.3", parserMode: "flash", modelRevision: null, durationMs: expect.any(Number) });
      expect(attempt.textSha256).toBe(sha256("recovered scanned page one body"));
      expect(await storage.objectExists(attempt.authoritativeArtifactKey!)).toBe(true);

      // Exactly one durable server instance, fully lifecycle'd, per-claim home isolated.
      const serverRows = await prisma.ocrServerInstance.findMany({ where: { ingestionRunId: run.id } });
      expect(serverRows).toHaveLength(1);
      const server = serverRows[0]!;
      expect(server.status).toBe("STOPPED");
      expect(server.hostId).toBe(config.hostId);
      expect(server.pid).toBeGreaterThan(0);
      expect(server.serverId).toBe("fake-server-identity");
      expect(server.transports).toMatchObject([{ type: "tcp" }]);
      expect(server.mineruHome).toContain(join(config.homeRoot, run.id, "generation-1", "page-1"));
      // The owning run-execution lineage was recorded on the server row
      // (the run row's own claim token is cleared on success, so only the
      // recorded lineage remains as ownership evidence).
      expect(server.runExecutionToken).toMatch(/^[0-9a-f-]{36}$/);

      // Host capacity slot released; per-claim temp tree fully removed.
      const lease = await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId: config.hostId } });
      expect(lease.claimToken).toBeNull();
      const claimRoot = join(server.mineruHome, "..");
      expect(existsSync(claimRoot) ? readdirSync(claimRoot).length : 0).toBe(0);

      expect(handle.executor.calls).toEqual([expect.objectContaining({ physicalPageIndex: 1, routingGeneration: PDF_ROUTING_GENERATION, outcome: "SUCCEEDED", durationMs: expect.any(Number) })]);
    } finally {
      await handle.close();
    }
  });

  it("HOST_CAPACITY_RETRY_RECOVERS: a busy slot leaves the run retryable (never OCR_REQUIRED), and the normal scheduler redelivery completes it once the slot frees", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    const config = fakeMineruConfig();
    const handle = createMineruPdfOcrExecutor(config);
    try {
      const squatter = (await acquireOcrHostLease(config.hostId))!;
      // First execution: the capacity failure must NOT terminalize the run.
      await expect(serviceWith(storage, handle.executor).processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_HOST_CAPACITY");

      const retryable = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(retryable.status).toBe("QUEUED");
      expect(retryable.errorCode).toBe("SOURCE_OCR_HOST_CAPACITY");
      const attempt = await attemptRow(workspace.id, run.id, 1);
      // RF03 P1-03: capacity DEFERRAL consumes ZERO page attempts — the
      // claim's +1 was transactionally given back (net zero).
      expect(attempt).toMatchObject({ status: "PENDING", attemptCount: 0, errorCode: "SOURCE_OCR_HOST_CAPACITY" });
      // RF01 P1-01: NO future page retry time is stored — the scheduler's
      // deferral cadence is the single retry clock and the page is claimable NOW.
      expect(attempt.nextAttemptAt).toBeNull();
      // The run/Job attempt budget was restored too.
      expect((await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } })).attemptCount).toBe(0);
      // The squatter's lease was never touched (token-fenced release); no
      // capacity was consumed beyond the bounded attempt record.
      expect((await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId: config.hostId } })).claimToken).toBe(squatter.claimToken);
      expect(handle.executor.calls).toEqual([expect.objectContaining({ physicalPageIndex: 1, outcome: "FAILED", errorCode: "SOURCE_OCR_HOST_CAPACITY" })]);
      expect(await prisma.ocrServerInstance.count({ where: { ingestionRunId: run.id } })).toBe(0);
      await releaseOcrHostLease(config.hostId, squatter.claimToken);

      // Capacity is available again: the SAME run is redelivered by the normal
      // scheduler (the run is already QUEUED — no manual requeue) and succeeds.
      process.env.MINERU_FAKE_TEXT = "capacity recovery scan text";
      await serviceWith(storage, handle.executor).processIngestionRun(run.id);

      const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(succeeded.status).toBe("SUCCEEDED");
      const recovered = await attemptRow(workspace.id, run.id, 1);
      // The successful execution is the FIRST consumed attempt (the deferral
      // was net-zero): one deferral + one real claim = attemptCount 1.
      expect(recovered).toMatchObject({ status: "SUCCEEDED", attemptCount: 1 });
      expect(recovered.attemptCount).toBeGreaterThan(attempt.attemptCount);
      expect(recovered.textSha256).toBe(sha256("capacity recovery scan text"));
      // Exactly one extraction, one bootstrap, one current pointer.
      expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: run.sourceDocumentId } })).toBe(1);
      expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(1);
      expect(await prisma.currentDocumentExtraction.count({ where: { workspaceId: workspace.id } })).toBe(1);
      expect((await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId: config.hostId } })).claimToken).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it("HOST_LEASE_LOST_MID_EXECUTION: renewal loss aborts the invocation, retries through the durable budget, and the next claim owns the slot", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    process.env.MINERU_FAKE_MODE = "delay";
    process.env.MINERU_FAKE_DELAY_MS = "4000";
    const config = fakeMineruConfig();
    const handle = createMineruPdfOcrExecutor(config);
    try {
      const execution = serviceWith(storage, handle.executor).processIngestionRun(run.id);
      // Once the first claim is executing, expire its host lease underneath it.
      await waitForServerInstance(run.id, "RUNNING");
      await prisma.$executeRaw`UPDATE "OcrHostLease" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "hostId" = ${config.hostId}`;
      await execution;

      const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(succeeded.status).toBe("SUCCEEDED");
      const attempt = await attemptRow(workspace.id, run.id, 1);
      expect(attempt).toMatchObject({ status: "SUCCEEDED", attemptCount: 2 });
      // Every started server was torn down by its own claim (per-claim identity).
      const servers = await prisma.ocrServerInstance.findMany({ where: { ingestionRunId: run.id } });
      expect(servers).toHaveLength(2);
      expect(servers.map((server) => server.status)).toEqual(["STOPPED", "STOPPED"]);
      expect((await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId: config.hostId } })).claimToken).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it("SHUTDOWN_DURING_OCR: close() aborts in-flight work, cleanup stays bounded, and the durable budget records the stable transient", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { run } = await createPdfRunFixture(bytes, storage);
    process.env.MINERU_FAKE_MODE = "delay";
    process.env.MINERU_FAKE_DELAY_MS = "60000";
    const config = fakeMineruConfig({ timeoutMs: 120_000 });
    const handle = createMineruPdfOcrExecutor(config);
    try {
      const execution = serviceWith(storage, handle.executor).processIngestionRun(run.id);
      // Attach the rejection expectation IMMEDIATELY: the durable-budget retry
      // cascade can settle (and reject) the run while close() is still polling,
      // and a late handler would surface as an unhandled rejection.
      const rejectionExpected = expect(execution).rejects.toThrow();
      await waitForServerInstance(run.id, "RUNNING");
      const closeStarted = Date.now();
      await handle.close();
      expect(Date.now() - closeStarted).toBeLessThan(25_000);
      await rejectionExpected;

      const failed = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(failed.status).toBe("OCR_REQUIRED");
      expect(await attemptRow((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } })).workspaceId, run.id, 1)).toMatchObject({ status: "FAILED", errorCode: "SOURCE_OCR_PROCESS_FAILED" });
      expect((await prisma.ocrServerInstance.findMany({ where: { ingestionRunId: run.id } })).map((row) => row.status)).toEqual(["STOPPED"]);
      expect((await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId: config.hostId } })).claimToken).toBeNull();
      expect(await prisma.documentExtraction.count({ where: { ingestionRunId: run.id } })).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it.each([
    ["missing local model is terminal", "model_not_ready", "SOURCE_OCR_MODEL_NOT_FOUND", 1],
    ["server loss is retried then failed", "server_not_running", "SOURCE_OCR_PROCESS_FAILED", 3],
    ["process crash is retried then failed", "crash", "SOURCE_OCR_PROCESS_FAILED", 3],
    ["unwritten output is terminal", "no_output", "SOURCE_OCR_OUTPUT_INVALID", 1],
    ["wrong output path is terminal", "wrong_path", "SOURCE_OCR_OUTPUT_INVALID", 1],
    ["whitespace-only output retries then fails", "empty", "SOURCE_OCR_NO_USABLE_TEXT", 3],
  ])("FAILURE_CLASSIFICATION: %s", async (_name, mode, errorCode, expectedAttempts) => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    process.env.MINERU_FAKE_MODE = mode;
    const handle = createMineruPdfOcrExecutor(fakeMineruConfig());
    try {
      await expect(serviceWith(storage, handle.executor).processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_REQUIRED");
      const failed = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(failed.status).toBe("OCR_REQUIRED");
      expect(failed.errorCode).toBe("SOURCE_OCR_REQUIRED");
      expect(await attemptRow(workspace.id, run.id, 1)).toMatchObject({ status: "FAILED", attemptCount: expectedAttempts, errorCode });
      expect(await prisma.documentExtraction.count({ where: { ingestionRunId: run.id } })).toBe(0);
      expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(0);
      // Durable server identity always torn down, lease always released.
      const servers = await prisma.ocrServerInstance.findMany({ where: { ingestionRunId: run.id } });
      expect(servers.length).toBeGreaterThanOrEqual(1);
      expect(servers.every((server) => server.status === "STOPPED")).toBe(true);
      expect((await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId: servers[0]!.hostId } })).claimToken).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it("ORPHAN_SUSPECT_PRESERVES_EVIDENCE: when teardown cannot prove identity, the claim home survives for the reconciler and only bulky IO is removed (RF02 P1-04)", { timeout: 60_000 }, async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    process.env.MINERU_FAKE_MODE = "delay";
    process.env.MINERU_FAKE_DELAY_MS = "500";
    // The graceful stop is neutered so teardown falls through to the guarded
    // kill, where the TAMPERED endpoint file forces an identity mismatch.
    process.env.MINERU_FAKE_STOP_MODE = "noop";
    const config = fakeMineruConfig();
    const handle = createMineruPdfOcrExecutor(config);
    // A live same-image substitute the tampered endpoint will lure with.
    const { spawn } = await import("node:child_process");
    const substitute = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore", windowsHide: true });
    substitute.unref();
    let originalPid: number | undefined;
    try {
      const execution = serviceWith(storage, handle.executor).processIngestionRun(run.id);
      const serverRow = await waitForServerInstance(run.id, "RUNNING");
      // Capture the ORIGINAL dummy's identity, then TAMPER the claim's
      // endpoint file: untrusted output now disagrees with the identity the
      // session recorded at start.
      const endpointPath = join(serverRow.mineruHome, "doclib.endpoint.json");
      originalPid = (JSON.parse(readFileSync(endpointPath, "utf8")) as { pid: number }).pid;
      writeFileSync(endpointPath, JSON.stringify({ version: 2, pid: substitute.pid, server_id: "tampered-identity", transports: [{ type: "tcp", base_url: "http://127.0.0.1:1" }] }));
      await execution;

      const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: serverRow.hostClaimToken } });
      expect(row.status).toBe("ORPHANED");
      // The claim HOME (identity evidence) is preserved and readable...
      const preserved = JSON.parse(readFileSync(endpointPath, "utf8"));
      expect(preserved.server_id).toBe("tampered-identity");
      expect(row.mineruHome).toBe(serverRow.mineruHome);
      // ...while the bulky input/output data is gone.
      expect(existsSync(join(serverRow.mineruHome, "..", "input"))).toBe(false);
      expect(existsSync(join(serverRow.mineruHome, "..", "output"))).toBe(false);
      // The substitute was never killed by the mismatched cleanup.
      expect(await recordedProcessAlive(substitute.pid!, /node|python/i)).toBe(true);
    } finally {
      try { spawn("taskkill", ["/PID", String(substitute.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ }
      try { spawn("taskkill", ["/PID", String(originalPid!), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ }
      // Wait until the original dummy released its home CWD so the suite's
      // temp-root cleanup cannot hit EPERM.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await recordedProcessAlive(originalPid!, /node|python/i))) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await handle.close();
    }
  });

  it("START_FAILURE_WITHOUT_ENDPOINT: an unproven start failure resolves ORPHANED (never STOPPED) and preserves the recovery home (RF02 P1-05)", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    // The start wrapper exits 0 WITHOUT ever writing an endpoint: identity
    // availability is unproven, not "already exited".
    process.env.MINERU_FAKE_SERVER_START_MODE = "no_endpoint";
    const handle = createMineruPdfOcrExecutor(fakeMineruConfig({ serverStartTimeoutMs: 1_500 }));
    try {
      // One execution: attempt 1 starts, fails unproven (ORPHANED row, one
      // consumed page attempt); attempt 2 then hits the host POISON left by
      // that very orphan and the whole run defers safely.
      await expect(serviceWith(storage, handle.executor).processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_HOST_CAPACITY");
      const row = await prisma.ocrServerInstance.findFirstOrThrow({ where: { ingestionRunId: run.id } });
      expect(row.status).toBe("ORPHANED");
      expect(row.terminationReason).toBe("START_IDENTITY_UNAVAILABLE");
      const deferredRun = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(deferredRun).toMatchObject({ status: "QUEUED", errorCode: "SOURCE_OCR_HOST_CAPACITY" });
      // Exactly ONE real processing attempt was consumed (the start failure);
      // the capacity deferral itself was net-zero.
      expect(await attemptRow(workspace.id, run.id, 1)).toMatchObject({ status: "PENDING", attemptCount: 1, errorCode: "SOURCE_OCR_HOST_CAPACITY" });
      expect((await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } })).attemptCount).toBe(0);
      expect(await prisma.documentExtraction.count({ where: { ingestionRunId: run.id } })).toBe(0);
      // And a further delivery keeps deferring (never OCR_REQUIRED/FAILED).
      await expect(serviceWith(storage, handle.executor).processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_HOST_CAPACITY");
      // Operator resolution (manual removal of the orphan condition — never
      // automatic) unblocks the host slot for the deferred work.
      await prisma.ocrServerInstance.delete({ where: { id: row.id } });
      delete process.env.MINERU_FAKE_SERVER_START_MODE;
      process.env.MINERU_FAKE_TEXT = "recovered after operator resolution";
      await serviceWith(storage, handle.executor).processIngestionRun(run.id);
      expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("SUCCEEDED");
      expect(await prisma.documentExtraction.count({ where: { ingestionRunId: run.id } })).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("START_NEVER_STARTED_PROOF: a spawn that never happened converges STARTING -> STOPPED through the explicit proof API (RF02 P1-05)", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    // The EXECUTABLE itself is missing: the spawn fails with ENOENT —
    // NOTHING was ever spawned, the strongest possible never-started proof.
    const config = fakeMineruConfig();
    config.executable = join(config.homeRoot, "definitely-missing-mineru.exe");
    const handle = createMineruPdfOcrExecutor(config);
    try {
      await expect(serviceWith(storage, handle.executor).processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_REQUIRED");
      const row = await prisma.ocrServerInstance.findFirstOrThrow({ where: { ingestionRunId: run.id } });
      expect(row.status).toBe("STOPPED");
      expect(row.terminationReason).toBe("NEVER_STARTED_NO_ENDPOINT_IDENTITY");
      expect(await attemptRow(workspace.id, run.id, 1)).toMatchObject({ status: "FAILED", attemptCount: 1, errorCode: "SOURCE_OCR_MINERU_NOT_FOUND" });
    } finally {
      await handle.close();
    }
  });

  it("OUTPUT_CAP: a degenerate oversized OCR output is a stable terminal failure, never unbounded memory", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    process.env.MINERU_FAKE_MODE = "oversize";
    process.env.MINERU_FAKE_OVERSIZE_BYTES = String(2_000_000);
    const handle = createMineruPdfOcrExecutor(fakeMineruConfig({ maxOutputBytes: 1_000_000 }));
    try {
      await expect(serviceWith(storage, handle.executor).processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_REQUIRED");
      expect(await attemptRow(workspace.id, run.id, 1)).toMatchObject({ status: "FAILED", attemptCount: 1, errorCode: "SOURCE_OCR_OUTPUT_INVALID" });
      expect(await prisma.documentExtraction.count({ where: { ingestionRunId: run.id } })).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("PROCESS_TIMEOUT: a hung MinerU invocation is terminated by the hard timeout and classified transient", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    process.env.MINERU_FAKE_MODE = "delay";
    process.env.MINERU_FAKE_DELAY_MS = "60000";
    const handle = createMineruPdfOcrExecutor(fakeMineruConfig({ timeoutMs: 1_500 }));
    try {
      await expect(serviceWith(storage, handle.executor).processIngestionRun(run.id)).rejects.toThrow("SOURCE_OCR_REQUIRED");
      expect(await attemptRow(workspace.id, run.id, 1)).toMatchObject({ status: "FAILED", attemptCount: 3, errorCode: "SOURCE_OCR_TIMEOUT" });
      const servers = await prisma.ocrServerInstance.findMany({ where: { ingestionRunId: run.id } });
      expect(servers.length).toBeGreaterThanOrEqual(1);
      expect(servers.every((server) => server.status === "STOPPED")).toBe(true);
      expect((await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId: servers[0]!.hostId } })).claimToken).toBeNull();
      expect(await prisma.documentExtraction.count({ where: { ingestionRunId: run.id } })).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("STALE_OWNER_FENCED_WITH_REAL_EXECUTOR: superseded owner A cannot commit; B owns the page checkpoint and publication", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const { workspace, run } = await createPdfRunFixture(bytes, storage);
    // A: slow parse, slow heartbeat (does not notice its lease was stolen in time).
    process.env.MINERU_FAKE_MODE = "delay";
    process.env.MINERU_FAKE_DELAY_MS = "8000";
    const handleA = createMineruPdfOcrExecutor(fakeMineruConfig({ heartbeatIntervalMs: 60_000, timeoutMs: 30_000 }));
    const executionA = serviceWith(storage, handleA.executor).processIngestionRun(run.id);
    // Handler attached immediately — A rejects long after B finished, but the
    // rejection must never sit unhandled.
    const rejectionAExpected = expect(executionA).rejects.toThrow();
    await waitForServerInstance(run.id, "RUNNING");
    // A goes stale: only the run lease expires so B may reclaim while A's MinerU work is in flight.
    await prisma.$executeRaw`UPDATE "IngestionRun" SET "executionLeaseUntil" = NOW() - INTERVAL '1 second' WHERE "id" = ${run.id}`;

    // B: immediate success-mode double with its own host slot.
    delete process.env.MINERU_FAKE_MODE;
    delete process.env.MINERU_FAKE_DELAY_MS;
    process.env.MINERU_FAKE_TEXT = "B authoritative scan text";
    const configB = fakeMineruConfig();
    const handleB = createMineruPdfOcrExecutor(configB);
    try {
      await serviceWith(storage, handleB.executor).processIngestionRun(run.id);
      await rejectionAExpected;

      const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(succeeded.status).toBe("SUCCEEDED");
      const attempt = await attemptRow(workspace.id, run.id, 1);
      expect(attempt).toMatchObject({ status: "SUCCEEDED", attemptCount: 2 });
      expect(attempt.textSha256).toBe(sha256("B authoritative scan text"));
      const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
      const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
      expect(blocks[1]?.text).toBe("B authoritative scan text");
      expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: run.sourceDocumentId } })).toBe(1);
      expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(1);
      // B released its own slot; A never touched B's token-fenced lease.
      expect((await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId: configB.hostId } })).claimToken).toBeNull();
      // Exactly two server rows (A's and B's claims), both torn down by their owners.
      const allServers = await prisma.ocrServerInstance.findMany({ where: { ingestionRunId: run.id } });
      expect(allServers).toHaveLength(2);
      expect(allServers.map((server) => server.status)).toEqual(["STOPPED", "STOPPED"]);
    } finally {
      await handleA.close();
      await handleB.close();
    }
  });

  it("CONCURRENT_JOBS: two OCR-required runs contend for one host slot with zero cross-run mutation or collision", async () => {
    const bytes = await mixedPdf();
    const storage = new FakeStorageProvider();
    const fixtureA = await createPdfRunFixture(bytes, storage);
    const fixtureB = await createPdfRunFixture(bytes, storage);
    process.env.MINERU_FAKE_DELAY_MS = "500";
    // ONE shared hostId across both executors: the configured host slot capacity authority.
    const sharedConfig = fakeMineruConfig();
    const handleA = createMineruPdfOcrExecutor(sharedConfig);
    const handleB = createMineruPdfOcrExecutor(sharedConfig);
    try {
      await Promise.allSettled([serviceWith(storage, handleA.executor).processIngestionRun(fixtureA.run.id), serviceWith(storage, handleB.executor).processIngestionRun(fixtureB.run.id)]);
      const states = await prisma.ingestionRun.findMany({ where: { id: { in: [fixtureA.run.id, fixtureB.run.id] } } });
      // The winner succeeds; the capacity loser is durably RETRYABLE (QUEUED) — never terminal.
      expect(states.filter((run) => run.status === "SUCCEEDED").length + states.filter((run) => run.status === "QUEUED" && run.errorCode === "SOURCE_OCR_HOST_CAPACITY").length).toBe(2);
      // The winner's page attempt is complete; the loser's is a clean PENDING
      // capacity failure with no future retry time — never a mutation of the
      // winner's attempt.
      for (const fixture of [fixtureA, fixtureB]) {
        const attempt = await attemptRow(fixture.workspace.id, fixture.run.id, 1);
        expect(["PENDING", "SUCCEEDED"]).toContain(attempt.status);
        if (attempt.status === "PENDING") {
          expect(attempt.errorCode).toBe("SOURCE_OCR_HOST_CAPACITY");
          expect(attempt.nextAttemptAt).toBeNull();
        }
      }
      // Claim homes stayed disjoint per (run, generation, page); no collision.
      const homes = await prisma.ocrServerInstance.findMany({ where: { ingestionRunId: { in: [fixtureA.run.id, fixtureB.run.id] } } });
      expect(new Set(homes.map((home) => home.mineruHome)).size).toBe(homes.length);
      for (const home of homes) expect(home.mineruHome).toContain(home.ingestionRunId);
      // The slot ends free (single-owner-at-a-time held it throughout).
      expect((await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId: sharedConfig.hostId } })).claimToken).toBeNull();
    } finally {
      await handleA.close();
      await handleB.close();
    }
  });
});
