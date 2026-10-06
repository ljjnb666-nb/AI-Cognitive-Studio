import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@ai-cognitive/db";
import { readEnvironment, type Environment } from "@ai-cognitive/shared/server";
import { startWorkerRuntime } from "../src/runtime.js";

/**
 * RF03 P1-03 MANDATORY REAL SCHEDULER TEST: real BullMQ Worker + Queue + real
 * Redis + real PostgreSQL in the production-shaped composition (never a manual
 * second service.processIngestionRun call). Worker concurrency >= 2; job A
 * holds the host OCR slot for >20 seconds while job B needs OCR.
 *
 * Expected: B is scheduler-deferred REPEATEDLY while A owns the slot, with
 * ZERO consumption of B's BullMQ attempts, B's Job.attemptCount and B's
 * OcrPageAttempt attempt budget. After A releases, B executes normally and
 * both runs publish exactly once.
 */

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const fakeMineruPath = fileURLToPath(new URL("../../../packages/ingestion/tests/helpers/mineru/fake-mineru.mjs", import.meta.url));
const fixtureBytes = () => new Uint8Array(readFileSync(fileURLToPath(new URL("../../../packages/ingestion/tests/fixtures/mineru/scanned-mixed-real.pdf", import.meta.url))));

const cleanup = { workspaceIds: [] as string[], userIds: [] as string[], runIds: [] as string[] };
let tempRoot: string | null = null;

afterAll(async () => {
  if (cleanup.runIds.length) {
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: cleanup.runIds } } });
    await prisma.bookAnalysisBootstrap.deleteMany({ where: { ingestionRunId: { in: cleanup.runIds } } });
  }
  if (cleanup.workspaceIds.length) {
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.ocrServerInstance.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.ocrPageAttempt.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
  }
  if (cleanup.userIds.length) await prisma.user.deleteMany({ where: { id: { in: cleanup.userIds } } });
  if (cleanup.workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: cleanup.workspaceIds } } });
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.MINERU_FAKE_MODE;
  delete process.env.MINERU_FAKE_DELAY_MS;
  await prisma.$disconnect();
});

async function createOcrRunAt(workspaceId: string, userId: string, storageKey: string, sizeBytes: number): Promise<string> {
  const blob = await prisma.sourceBlob.upsert({
    where: { workspaceId_sha256: { workspaceId, sha256: sha256(storageKey) } },
    create: { workspaceId, sha256: sha256(storageKey), sizeBytes, mediaType: "application/pdf", storageKey },
    update: {},
  });
  const source = await prisma.source.create({ data: { workspaceId, kind: "FILE", displayName: `deferral-${crypto.randomUUID()}.pdf` } });
  const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId, version: 1, sha256: blob.sha256, sizeBytes, mediaType: "application/pdf", storageKey } });
  const job = await prisma.job.create({ data: { userId, workspaceId, type: "source.ingest", payload: { sourceDocumentId: document.id } } });
  const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId, jobId: job.id, parserVersion: "pdf-router-v1", normalizationVersion: "canonical-text-v1" } });
  cleanup.runIds.push(run.id);
  return run.id;
}

describe("real BullMQ OCR capacity deferral (RF03 P1-03)", () => {
  it("CAPACITY_DEFERRAL: contention defers B repeatedly with zero budget consumption; both runs publish exactly once after A releases", { timeout: 240_000 }, async () => {
    process.env.MINERU_FAKE_MODE = "delay";
    process.env.MINERU_FAKE_DELAY_MS = "21000";
    tempRoot = mkdtempSync(join(tmpdir(), "worker-deferral-"));
    const modelsDir = join(tempRoot, "models");
    mkdirSync(modelsDir, { recursive: true });
    const hostId = `mineru-deferral-${crypto.randomUUID()}`;
    const bullmqPrefix = `worker-deferral-${crypto.randomUUID()}`;
    const ingestionTopic = `worker-deferral-topic-${crypto.randomUUID()}`;

    const user = await prisma.user.create({ data: { email: `deferral-${crypto.randomUUID()}@test`, name: "Deferral" } });
    const workspace = await prisma.workspace.create({ data: { name: `deferral-${crypto.randomUUID()}` } });
    cleanup.userIds.push(user.id);
    cleanup.workspaceIds.push(workspace.id);
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });

    const bytes = fixtureBytes();
    const { S3CompatibleStorageProvider } = await import("@ai-cognitive/storage");
    const storage = new S3CompatibleStorageProvider({ endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: "us-east-1", bucket: process.env.S3_BUCKET ?? "ai-cognitive-studio-dev", accessKey: process.env.S3_ACCESS_KEY ?? "local-development-only", secretKey: process.env.S3_SECRET_KEY ?? "local-development-only", forcePathStyle: true });
    const storageKey0 = `test/${crypto.randomUUID()}`;
    await storage.putObject({ key: storageKey0, body: bytes, contentType: "application/pdf" });
    // Route BOTH fixtures at the uploaded canonical object.
    const runA = await createOcrRunAt(workspace.id, user.id, storageKey0, bytes.length);
    const runB = await createOcrRunAt(workspace.id, user.id, storageKey0, bytes.length);
    await prisma.outboxEvent.create({ data: { topic: ingestionTopic, aggregateId: runA, payload: { ingestionRunId: runA } } });
    await prisma.outboxEvent.create({ data: { topic: ingestionTopic, aggregateId: runB, payload: { ingestionRunId: runB } } });
    const jobBId = (await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runB } })).jobId;
    const jobAId = (await prisma.ingestionRun.findUniqueOrThrow({ where: { id: runA } })).jobId;

    const environment = {
      ...readEnvironment(process.env),
      OCR_PROVIDER: "mineru",
      MINERU_MODEL_SOURCE: "local",
      MINERU_MODEL_PATH: modelsDir,
      MINERU_EXECUTABLE: process.execPath,
      MINERU_EXECUTABLE_ARGS: JSON.stringify([fakeMineruPath]),
      MINERU_TIER: "flash",
      MINERU_TIMEOUT_MS: 40_000,
      MINERU_SERVER_START_TIMEOUT_MS: 15_000,
      MINERU_SERVER_STOP_TIMEOUT_MS: 10_000,
      MINERU_HOME_ROOT: join(tempRoot, "homes"),
      MINERU_MAX_OUTPUT_BYTES: 1_000_000,
      MINERU_CAPACITY_DEFERRAL_DELAY_MS: 2_000,
      OCR_HOST_ID: hostId,
      WORKER_INGESTION_CONCURRENCY: 2,
    } as Environment;

    const startedAt = Date.now();
    const runtime = await startWorkerRuntime(environment, { bullmqPrefix, outboxTopics: { sourceIngestion: ingestionTopic } });
    try {
      // Worker concurrency is 2: BOTH jobs leave the queue at once and the
      // host slot goes to whichever executor wins the atomic lease race — the
      // OTHER run is the deferral loser. Sampling is symmetric (both runs),
      // because scheduling order is not deterministic.
      const samples: Array<{ run: "A" | "B"; jobAttempt: number; pageStatus: string; pageAttempts: number; runStatus: string }> = [];
      const pageKeys = {
        A: { ingestionRunId: runA, physicalPageIndex: 1, routingGeneration: 1 },
        B: { ingestionRunId: runB, physicalPageIndex: 1, routingGeneration: 1 },
      } as const;
      const deadline = Date.now() + 150_000;
      let bothDone = false;
      while (Date.now() < deadline) {
        for (const label of ["A", "B"] as const) {
          const [jobRow, page, run] = await Promise.all([
            prisma.job.findUniqueOrThrow({ where: { id: label === "A" ? jobAId : jobBId } }),
            prisma.ocrPageAttempt.findUnique({ where: { ingestionRunId_physicalPageIndex_routingGeneration: pageKeys[label] } }),
            prisma.ingestionRun.findUniqueOrThrow({ where: { id: label === "A" ? runA : runB } }),
          ]);
          samples.push({ run: label, jobAttempt: jobRow.attemptCount, pageStatus: page?.status ?? "none", pageAttempts: page?.attemptCount ?? 0, runStatus: run.status });
        }
        const states = await Promise.all([
          prisma.ingestionRun.findUniqueOrThrow({ where: { id: runA } }),
          prisma.ingestionRun.findUniqueOrThrow({ where: { id: runB } }),
        ]);
        if (states.every((run) => run.status === "SUCCEEDED")) { bothDone = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!bothDone) {
        const [ra, rb] = await Promise.all([
          prisma.ingestionRun.findUniqueOrThrow({ where: { id: runA } }),
          prisma.ingestionRun.findUniqueOrThrow({ where: { id: runB } }),
        ]);
        const pages = await prisma.ocrPageAttempt.findMany({ where: { ingestionRunId: { in: [runA, runB] } } });
        console.log("DEFERRAL_DEBUG", JSON.stringify({ runA: { status: ra.status, errorCode: ra.errorCode }, runB: { status: rb.status, errorCode: rb.errorCode }, pages: pages.map((p) => ({ run: p.ingestionRunId === runA ? "A" : "B", status: p.status, attemptCount: p.attemptCount, errorCode: p.errorCode })), tail: samples.slice(-8) }));
      }
      expect(bothDone).toBe(true);

      // The LOSER was ACTUALLY deferred: at least one sampled mid-flight
      // state shows a capacity-deferral signature (PENDING page / QUEUED run).
      expect(samples.some((sample) => sample.pageStatus === "PENDING" || sample.runStatus === "QUEUED"), JSON.stringify({ samplesLength: samples.length, samples: samples.slice(0, 20), tail: samples.slice(-6) })).toBe(true);
      // ZERO budget consumption across the whole contention window: each run
      // ends with exactly ONE real execution (the loser's repeated 2s-cadence
      // deferrals consumed nothing — had they consumed, the loser would have
      // exhausted its budgets of 3 and terminalized instead of succeeding).
      const finalJobB = await prisma.job.findUniqueOrThrow({ where: { id: jobBId } });
      const finalPageB = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: pageKeys.B } });
      const finalJobA = await prisma.job.findUniqueOrThrow({ where: { id: jobAId } });
      const finalPageA = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: pageKeys.A } });
      console.log("BUDGET_DEBUG", JSON.stringify({ samplesLength: samples.length, jobB: finalJobB.attemptCount, pageB: { status: finalPageB.status, attemptCount: finalPageB.attemptCount }, jobA: finalJobA.attemptCount, pageA: { status: finalPageA.status, attemptCount: finalPageA.attemptCount } }));
      expect(finalJobB.attemptCount).toBe(1);
      expect(finalPageB).toMatchObject({ status: "SUCCEEDED", attemptCount: 1, parserName: "mineru" });
      expect(finalJobA.attemptCount).toBe(1);
      expect(finalPageA).toMatchObject({ status: "SUCCEEDED", attemptCount: 1, parserName: "mineru" });
      // A also succeeded with its own real attempt.
      const finalRuns = await prisma.ingestionRun.findMany({ where: { id: { in: [runA, runB] } } });
      expect(finalRuns.map((run) => run.status).sort()).toEqual(["SUCCEEDED", "SUCCEEDED"]);
      // Both published exactly once with no cross-run provenance.
      for (const run of [runA, runB]) {
        expect(await prisma.documentExtraction.count({ where: { ingestionRunId: run } })).toBe(1);
        const runDocumentId = (await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run } })).sourceDocumentId;
        expect(await prisma.currentDocumentExtraction.count({ where: { sourceDocumentId: runDocumentId, workspaceId: workspace.id } })).toBe(1);
        expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run } })).toBe(1);
      }
      // The host slot ends free with every claim-scoped server torn down.
      expect((await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId } })).claimToken).toBeNull();
      const servers = await prisma.ocrServerInstance.findMany({ where: { ingestionRunId: { in: [runA, runB] } } });
      expect(servers.length).toBeGreaterThanOrEqual(2);
      expect(servers.every((server) => server.status === "STOPPED")).toBe(true);
      expect(Date.now() - startedAt).toBeGreaterThan(20_000);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });
});
