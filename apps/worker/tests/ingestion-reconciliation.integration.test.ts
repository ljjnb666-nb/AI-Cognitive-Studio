import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import { createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { createSourceIngestionQueue, INGESTION_JOB } from "../src/source-ingestion.js";
import { reconcileIngestionDeliveries, type IngestionReconciliationQueuePort } from "@ai-cognitive/ingestion";
import type { IngestionDeliveryState } from "@ai-cognitive/ingestion";

const environment = { ...readEnvironment(process.env), SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS: 3 };
const prefix = `test-04b1-reconcile-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
const workspaceIds: string[] = [];
const userIds: string[] = [];

const connection = { host: new URL(environment.REDIS_URL).hostname, port: Number(new URL(environment.REDIS_URL).port || 6379) };
const queue = createSourceIngestionQueue(environment, { prefix });
const port: IngestionReconciliationQueuePort = {
  getJobState: async (jobId) => {
    const job = await queue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    return (["waiting", "delayed", "active", "completed", "failed"] as IngestionDeliveryState[]).includes(state as IngestionDeliveryState) ? state as IngestionDeliveryState : null;
  },
  remove: async (jobId) => { await queue.remove(jobId); },
  add: async (jobId) => { await queue.add(INGESTION_JOB, { ingestionRunId: jobId }, { jobId }); },
};

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function createRunFixture(status: "QUEUED" | "RUNNING", attemptCount: number, leaseExpired = false) {
  const user = await prisma.user.create({ data: { email: `recon-${crypto.randomUUID()}@test`, name: "Recon" } });
  const workspace = await prisma.workspace.create({ data: { name: `recon-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256(`blob-${crypto.randomUUID()}`), sizeBytes: 12, mediaType: "text/plain", storageKey: `test/${crypto.randomUUID()}` } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "recon-test" } });
  const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: 12, mediaType: "text/plain", storageKey: blob.storageKey } });
  const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id }, attemptCount, status: status === "RUNNING" ? "RUNNING" : "QUEUED" } });
  const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "builtin-text", normalizationVersion: "canonical-text-v1", status, ...(status === "RUNNING" ? { executionClaimToken: `token-${crypto.randomUUID().slice(0, 8)}`, executionLeaseUntil: new Date(leaseExpired ? Date.now() - 5_000 : Date.now() + 120_000) } : {}) } });
  return run;
}

async function pollState(jobId: string, want: IngestionDeliveryState, timeoutMs = 20_000): Promise<IngestionDeliveryState | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await port.getJobState(jobId);
    if (state === want || Date.now() > deadline) return state;
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  // Hermetic slate: earlier suite executions may have left QUEUED/expired-RUNNING
  // fixture rows that would crowd the reconciler's createdAt-ordered batch.
  await prisma.currentDocumentExtraction.deleteMany();
  await prisma.bookAnalysisBootstrap.deleteMany();
  await prisma.outboxEvent.deleteMany({ where: { topic: "book.analysis.bootstrap.requested" } });
  await prisma.documentExtraction.deleteMany();
  await prisma.ocrPageAttempt.deleteMany();
  await prisma.ingestionRun.deleteMany();
});

afterAll(async () => {
  await queue.close();
  if (workspaceIds.length) {
    // Job rows RESTRICT workspace deletion; children first, in dependency order.
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.bookAnalysisBootstrap.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("source-ingestion delivery reconciliation (real PostgreSQL + real Redis)", () => {
  it("RECONCILE_QUEUED_MISSING_JOB: a QUEUED run with no queue job gets a deterministic delivery", async () => {
    const run = await createRunFixture("QUEUED", 0);
    expect(await port.getJobState(run.id)).toBeNull();
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3 });
    expect(result.queuedRepairCount).toBeGreaterThanOrEqual(1);
    expect(await pollState(run.id, "waiting")).toBe("waiting");
    const job = await queue.getJob(run.id);
    expect(job?.data).toEqual({ ingestionRunId: run.id });
    await port.remove(run.id);
  });

  it("RECONCILE_QUEUED_FAILED_RETAINED_JOB: a retained failed job is removed safely and re-added", async () => {
    const run = await createRunFixture("QUEUED", 1);
    const failing = new Worker(queue.name, async () => { throw new Error("SETUP_DETERMINISTIC_FAILURE"); }, { connection, prefix, concurrency: 1 });
    await queue.add(INGESTION_JOB, { ingestionRunId: run.id }, { jobId: run.id, attempts: 1 });
    expect(await pollState(run.id, "failed")).toBe("failed");
    await failing.close();
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3 });
    expect(result.queuedRepairCount).toBeGreaterThanOrEqual(1);
    expect(await pollState(run.id, "waiting")).toBe("waiting");
    await port.remove(run.id);
  }, 40_000);

  it("RECONCILE_QUEUED_COMPLETED_RETAINED_JOB: a retained completed job is repaired the same way", async () => {
    const run = await createRunFixture("QUEUED", 0);
    const passing = new Worker(queue.name, async () => "completed-by-setup", { connection, prefix, concurrency: 1 });
    await queue.add(INGESTION_JOB, { ingestionRunId: run.id }, { jobId: run.id, attempts: 1 });
    expect(await pollState(run.id, "completed")).toBe("completed");
    await passing.close();
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3 });
    expect(result.queuedRepairCount).toBeGreaterThanOrEqual(1);
    expect(await pollState(run.id, "waiting")).toBe("waiting");
    await port.remove(run.id);
  }, 40_000);

  it("RECONCILE_ACTIVE_JOB_NO_REMOVAL: an active delivery is never removed", async () => {
    const run = await createRunFixture("QUEUED", 0);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    // Foreign re-added deliveries pass through; only this test's own job occupies the worker on the gate.
    const busy = new Worker(queue.name, async (job) => { if (job.id !== run.id) return "foreign"; await gate; }, { connection, prefix, concurrency: 1 });
    try {
      await queue.add(INGESTION_JOB, { ingestionRunId: run.id }, { jobId: run.id });
      const seen: string[] = [];
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const state = await port.getJobState(run.id);
        if (state && !seen.includes(state)) seen.push(state);
        if (state === "active") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(seen, `observed states: ${seen.join(",") || "none"}`).toContain("active");
      await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3 });
      expect(await port.getJobState(run.id)).toBe("active");
      expect((await queue.getJob(run.id))?.id).toBe(run.id);
    } finally {
      release();
      await busy.close();
    }
  }, 40_000);

  it("RECONCILE_EXPIRED_RUNNING_RETRYABLE: expired RUNNING with budget left gets the reclaiming delivery", async () => {
    const run = await createRunFixture("RUNNING", 1, true);
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3 });
    expect(result.expiredRetryableCount).toBeGreaterThanOrEqual(1);
    expect(await pollState(run.id, "waiting")).toBe("waiting");
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("RUNNING");
  });

  it("RECONCILE_EXPIRED_RUNNING_EXHAUSTED: expired RUNNING at the durable max terminalizes FAILED with the stable code", async () => {
    const run = await createRunFixture("RUNNING", 3, true);
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3 });
    expect(result.expiredTerminalCount).toBeGreaterThanOrEqual(1);
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("INGESTION_EXECUTION_LEASE_EXPIRED");
    const job = await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } });
    expect(job.status).toBe("FAILED");
    expect(await port.getJobState(run.id)).toBeNull();
  });

  it("a live lease is never reconciled", async () => {
    const run = await createRunFixture("RUNNING", 0, false);
    await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3 });
    expect(await port.getJobState(run.id)).toBeNull();
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("RUNNING");
  });
});
