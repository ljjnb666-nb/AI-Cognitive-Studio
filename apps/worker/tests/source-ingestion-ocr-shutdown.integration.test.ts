import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@ai-cognitive/db";
import { readEnvironment, type Environment } from "@ai-cognitive/shared/server";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { startWorkerRuntime } from "../src/runtime.js";
import { recordedProcessAlive } from "../../../packages/ingestion/src/mineru/mineru-process.js";

/**
 * RF01 P1-02 REAL composition gate: the actual startWorkerRuntime close path
 * must ABORT active MinerU work instead of waiting for the BullMQ job that is
 * stuck inside it. Testing executor.close() alone is NOT sufficient — this
 * test drives a real queue delivery through the real worker composition.
 */

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const fakeMineruPath = fileURLToPath(new URL("../../../packages/ingestion/tests/helpers/mineru/fake-mineru.mjs", import.meta.url));
const fixtureBytes = () => new Uint8Array(readFileSync(fileURLToPath(new URL("../../../packages/ingestion/tests/fixtures/mineru/scanned-mixed-real.pdf", import.meta.url))));

const cleanupIds = { workspaceIds: [] as string[], userIds: [] as string[], runIds: [] as string[] };
let tempRoot: string | null = null;

afterAll(async () => {
  if (cleanupIds.runIds.length) {
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: cleanupIds.runIds } } });
    await prisma.bookAnalysisBootstrap.deleteMany({ where: { ingestionRunId: { in: cleanupIds.runIds } } });
  }
  if (cleanupIds.workspaceIds.length) {
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: cleanupIds.workspaceIds } } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: cleanupIds.workspaceIds } } });
    await prisma.ocrServerInstance.deleteMany({ where: { workspaceId: { in: cleanupIds.workspaceIds } } });
    await prisma.ocrPageAttempt.deleteMany({ where: { workspaceId: { in: cleanupIds.workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: cleanupIds.workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: cleanupIds.workspaceIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: cleanupIds.workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: cleanupIds.workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: cleanupIds.workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: cleanupIds.workspaceIds } } });
  }
  if (cleanupIds.userIds.length) await prisma.user.deleteMany({ where: { id: { in: cleanupIds.userIds } } });
  if (cleanupIds.workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: cleanupIds.workspaceIds } } });
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.MINERU_FAKE_MODE;
  delete process.env.MINERU_FAKE_DELAY_MS;
  await prisma.$disconnect();
});

async function buildOcrFixturePdf(): Promise<Uint8Array> {
  // The committed 04B-3 acceptance fixture: native / raster-only / native.
  return fixtureBytes();
}

describe("worker runtime shutdown aborts active OCR (RF01 P1-02, real composition)", () => {
  it("RUNTIME_CLOSE_ABORTS_OCR: close() interrupts the in-flight MinerU parse, closes bounded, and leaves no server, lease, or publication behind", { timeout: 120_000 }, async () => {
    process.env.MINERU_FAKE_MODE = "delay";
    process.env.MINERU_FAKE_DELAY_MS = "60000";
    tempRoot = mkdtempSync(join(tmpdir(), "worker-ocr-shutdown-"));
    const modelsDir = join(tempRoot, "models");
    mkdirSync(modelsDir, { recursive: true });
    const bullmqPrefix = `worker-ocr-shutdown-${crypto.randomUUID()}`;
    const ingestionTopic = `worker-ocr-shutdown-topic-${crypto.randomUUID()}`;
    const hostId = `mineru-shutdown-${crypto.randomUUID()}`;

    const bytes = await buildOcrFixturePdf();
    const storage = new S3CompatibleStorageProvider({ endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: "us-east-1", bucket: process.env.S3_BUCKET ?? "ai-cognitive-studio-dev", accessKey: process.env.S3_ACCESS_KEY ?? "local-development-only", secretKey: process.env.S3_SECRET_KEY ?? "local-development-only", forcePathStyle: true });
    const storageKey = `test/${crypto.randomUUID()}`;
    await storage.putObject({ key: storageKey, body: bytes, contentType: "application/pdf" });

    const user = await prisma.user.create({ data: { email: `worker-shutdown-${crypto.randomUUID()}@test`, name: "Worker Shutdown" } });
    const workspace = await prisma.workspace.create({ data: { name: `worker-shutdown-${crypto.randomUUID()}` } });
    cleanupIds.userIds.push(user.id);
    cleanupIds.workspaceIds.push(workspace.id);
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256(storageKey), sizeBytes: bytes.length, mediaType: "application/pdf", storageKey } });
    const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "worker-shutdown.pdf" } });
    const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: bytes.length, mediaType: "application/pdf", storageKey } });
    const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id } } });
    const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "pdf-router-v1", normalizationVersion: "canonical-text-v1" } });
    cleanupIds.runIds.push(run.id);
    await prisma.outboxEvent.create({ data: { topic: ingestionTopic, aggregateId: run.id, payload: { ingestionRunId: run.id } } });

    // Production-shaped environment: readEnvironment applies every default
    // (SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS etc.), then OCR config overlays.
    const environment = {
      ...readEnvironment(process.env),
      OCR_PROVIDER: "mineru",
      MINERU_MODEL_SOURCE: "local",
      MINERU_MODEL_PATH: modelsDir,
      MINERU_EXECUTABLE: process.execPath,
      MINERU_EXECUTABLE_ARGS: JSON.stringify([fakeMineruPath]),
      MINERU_TIER: "flash",
      MINERU_TIMEOUT_MS: 30_000,
      MINERU_SERVER_START_TIMEOUT_MS: 15_000,
      MINERU_SERVER_STOP_TIMEOUT_MS: 10_000,
      MINERU_HOME_ROOT: join(tempRoot, "homes"),
      MINERU_MAX_OUTPUT_BYTES: 1_000_000,
      OCR_HOST_ID: hostId,
    } as Environment;

    const runtime = await startWorkerRuntime(environment, { bullmqPrefix, outboxTopics: { sourceIngestion: ingestionTopic } });
    try {
      // The runtime's own dispatch delivers the run; wait until the claim is
      // executing its MinerU parse (blocked inside the fake for 60s).
      const deadline = Date.now() + 40_000;
      let serverRow: { pid: number | null; status: string; hostId: string } | null = null;
      while (Date.now() < deadline) {
        serverRow = await prisma.ocrServerInstance.findFirst({ where: { ingestionRunId: run.id, status: "RUNNING" } });
        if (serverRow) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(serverRow).not.toBeNull();

      // THE REPAIR UNDER TEST: runtime close must abort the OCR instead of
      // waiting for the 60s parse behind the BullMQ job.
      const closeStarted = Date.now();
      await runtime.close();
      const closeMs = Date.now() - closeStarted;
      expect(closeMs).toBeLessThan(30_000);

      // No owned process survives.
      expect(await recordedProcessAlive(serverRow!.pid!, /node|python/i)).toBe(false);
      const finalRow = await prisma.ocrServerInstance.findFirstOrThrow({ where: { ingestionRunId: run.id } });
      expect(finalRow.status).toBe("STOPPED");
      // The host capacity slot is released.
      expect((await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId } })).claimToken).toBeNull();
      // No partial publication.
      expect(await prisma.documentExtraction.count({ where: { ingestionRunId: run.id } })).toBe(0);
      expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(0);
      expect(await prisma.currentDocumentExtraction.count({ where: { workspaceId: workspace.id } })).toBe(0);
      // The run never published: it ends bounded (OCR budget exhausted by the
      // abort cascade -> OCR_REQUIRED), never SUCCEEDED with aborted content.
      const finalRun = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(["OCR_REQUIRED", "QUEUED", "RUNNING"]).toContain(finalRun.status);
      expect(finalRun.status === "SUCCEEDED").toBe(false);
    } finally {
      // Idempotent: the runtime already closed above.
      await runtime.close().catch(() => undefined);
    }
  });
});
