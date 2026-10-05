import { afterAll, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import { createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { createSourceIngestionQueue, INGESTION_JOB } from "../src/source-ingestion.js";
import { reconcileIngestionDeliveries, type IngestionReconciliationQueuePort } from "@ai-cognitive/ingestion";
import type { IngestionDeliveryState } from "@ai-cognitive/ingestion";

const environment = { ...readEnvironment(process.env), SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS: 3 };
const prefix = `test-04b1-reconcile-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
// Every row this suite creates is tracked here; cleanup touches ONLY these IDs.
// The suite must coexist with arbitrary valid pre-existing rows in the shared
// test database (CI runs earlier package suites that leave ChunkSet ->
// DocumentExtraction lineages behind), so there is deliberately NO global purge.
const workspaceIds: string[] = [];
const userIds: string[] = [];
const jobIds: string[] = [];
const runIds: string[] = [];
const chunkSetIds: string[] = [];

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

type FixtureOptions = { status?: "QUEUED" | "RUNNING"; attemptCount?: number; leaseExpired?: boolean; createdAt?: Date };

async function createRunFixture({ status = "QUEUED", attemptCount = 0, leaseExpired = false, createdAt }: FixtureOptions = {}) {
  const user = await prisma.user.create({ data: { email: `recon-${crypto.randomUUID()}@test`, name: "Recon" } });
  const workspace = await prisma.workspace.create({ data: { name: `recon-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256(`blob-${crypto.randomUUID()}`), sizeBytes: 12, mediaType: "text/plain", storageKey: `test/${crypto.randomUUID()}` } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "recon-test" } });
  const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: 12, mediaType: "text/plain", storageKey: blob.storageKey } });
  const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id }, attemptCount, status: status === "RUNNING" ? "RUNNING" : "QUEUED" } });
  jobIds.push(job.id);
  const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "builtin-text", normalizationVersion: "canonical-text-v1", status, ...(createdAt ? { createdAt } : {}), ...(status === "RUNNING" ? { executionClaimToken: `token-${crypto.randomUUID().slice(0, 8)}`, executionLeaseUntil: new Date(leaseExpired ? Date.now() - 5_000 : Date.now() + 120_000) } : {}) } });
  runIds.push(run.id);
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

afterAll(async () => {
  await queue.close();
  // Owned cleanup ONLY: every delete is scoped to IDs this suite created, in
  // dependency order. No naked deleteMany on shared domain tables.
  if (runIds.length) {
    for (const runId of runIds) await queue.getJob(runId)?.then(job => job?.remove().catch(() => undefined));
    const bootstraps = await prisma.bookAnalysisBootstrap.findMany({ where: { ingestionRunId: { in: runIds } }, select: { id: true } });
    if (bootstraps.length) await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: bootstraps.map((b) => b.id) } } });
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.chunkSet.deleteMany({ where: { id: { in: chunkSetIds } } });
    await prisma.bookAnalysisBootstrap.deleteMany({ where: { ingestionRunId: { in: runIds } } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ocrPageAttempt.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe("source-ingestion delivery reconciliation (real PostgreSQL + real Redis, owned fixtures only)", () => {
  it("RECONCILE_QUEUED_MISSING_JOB: a QUEUED run with no queue job gets a deterministic delivery", async () => {
    const run = await createRunFixture();
    expect(await port.getJobState(run.id)).toBeNull();
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3, candidateRunIds: [run.id] });
    expect(result.queuedRepairCount).toBe(1);
    expect(await pollState(run.id, "waiting")).toBe("waiting");
    const job = await queue.getJob(run.id);
    expect(job?.data).toEqual({ ingestionRunId: run.id });
    await port.remove(run.id);
  });

  it("RECONCILE_QUEUED_FAILED_RETAINED_JOB: a retained failed job is removed safely and re-added", async () => {
    const run = await createRunFixture({ attemptCount: 1 });
    const failing = new Worker(queue.name, async () => { throw new Error("SETUP_DETERMINISTIC_FAILURE"); }, { connection, prefix, concurrency: 1 });
    await queue.add(INGESTION_JOB, { ingestionRunId: run.id }, { jobId: run.id, attempts: 1 });
    expect(await pollState(run.id, "failed")).toBe("failed");
    await failing.close();
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3, candidateRunIds: [run.id] });
    expect(result.queuedRepairCount).toBe(1);
    expect(await pollState(run.id, "waiting")).toBe("waiting");
    await port.remove(run.id);
  }, 40_000);

  it("RECONCILE_QUEUED_COMPLETED_RETAINED_JOB: a retained completed job is repaired the same way", async () => {
    const run = await createRunFixture();
    const passing = new Worker(queue.name, async () => "completed-by-setup", { connection, prefix, concurrency: 1 });
    await queue.add(INGESTION_JOB, { ingestionRunId: run.id }, { jobId: run.id, attempts: 1 });
    expect(await pollState(run.id, "completed")).toBe("completed");
    await passing.close();
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3, candidateRunIds: [run.id] });
    expect(result.queuedRepairCount).toBe(1);
    expect(await pollState(run.id, "waiting")).toBe("waiting");
    await port.remove(run.id);
  }, 40_000);

  it("RECONCILE_ACTIVE_JOB_NO_REMOVAL: an active delivery is never removed", async () => {
    const run = await createRunFixture();
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
      await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3, candidateRunIds: [run.id] });
      expect(await port.getJobState(run.id)).toBe("active");
      expect((await queue.getJob(run.id))?.id).toBe(run.id);
    } finally {
      release();
      await busy.close();
    }
  }, 40_000);

  it("RECONCILE_EXPIRED_RUNNING_RETRYABLE: expired RUNNING with budget left gets the reclaiming delivery", async () => {
    const run = await createRunFixture({ status: "RUNNING", attemptCount: 1, leaseExpired: true });
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3, candidateRunIds: [run.id] });
    expect(result.expiredRetryableCount).toBe(1);
    expect(await pollState(run.id, "waiting")).toBe("waiting");
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("RUNNING");
    await port.remove(run.id);
  });

  it("RECONCILE_EXPIRED_RUNNING_EXHAUSTED: expired RUNNING at the durable max terminalizes FAILED with the stable code", async () => {
    const run = await createRunFixture({ status: "RUNNING", attemptCount: 3, leaseExpired: true });
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3, candidateRunIds: [run.id] });
    expect(result.expiredTerminalCount).toBe(1);
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("INGESTION_EXECUTION_LEASE_EXPIRED");
    const job = await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } });
    expect(job.status).toBe("FAILED");
    expect(await port.getJobState(run.id)).toBeNull();
  });

  it("RF01-04 CASE A: a QUEUED run at the durable max terminalizes FAILED with INGESTION_ATTEMPTS_EXHAUSTED", async () => {
    const run = await createRunFixture({ attemptCount: 3 });
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3, candidateRunIds: [run.id] });
    expect(result.expiredTerminalCount).toBe(1);
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("INGESTION_ATTEMPTS_EXHAUSTED");
    expect(row.completedAt).not.toBeNull();
    const job = await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } });
    expect(job.status).toBe("FAILED");
    expect((job.error as { code?: string } | null)?.code).toBe("INGESTION_ATTEMPTS_EXHAUSTED");
    expect(await port.getJobState(run.id)).toBeNull();
  });

  it("RF01-04 CASE B: exhausted rows do not starve the oldest reconciliation window (batchSize=1)", async () => {
    // Deterministic ordering via explicit createdAt values; only these two
    // targeted fixtures participate, so no foreign rows are mutated or needed.
    const exhausted = await createRunFixture({ attemptCount: 3, createdAt: new Date("2000-01-01T00:00:00.000Z") });
    const repairable = await createRunFixture({ attemptCount: 1, createdAt: new Date("2000-01-01T00:00:01.000Z") });
    // Sweep 1: the oldest targeted row is the exhausted one; batchSize=1 terminalizes it.
    const sweep1 = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3, batchSize: 1, candidateRunIds: [exhausted.id, repairable.id] });
    expect(sweep1.expiredTerminalCount).toBe(1);
    expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: exhausted.id } })).status).toBe("FAILED");
    // Sweep 2: with the exhausted row terminal, the next-oldest repairable row gets its delivery.
    const sweep2 = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3, batchSize: 1, candidateRunIds: [exhausted.id, repairable.id] });
    expect(sweep2.queuedRepairCount).toBe(1);
    expect(await port.getJobState(repairable.id)).toBe("waiting");
    await port.remove(repairable.id);
  });

  it("a live lease is never reconciled", async () => {
    const run = await createRunFixture({ status: "RUNNING", attemptCount: 0, leaseExpired: false });
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3, candidateRunIds: [run.id] });
    expect(result).toEqual({ queuedRepairCount: 0, expiredRetryableCount: 0, expiredTerminalCount: 0 });
    expect(await port.getJobState(run.id)).toBeNull();
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("RUNNING");
    expect(row.executionClaimToken).not.toBeNull();
  });

  it("CI-RF01 SENTINEL: targeted reconciliation leaves foreign lineages durably untouched", async () => {
    // A foreign lineage that simulates rows other packages/suites legitimately
    // keep in the shared test DB — including the ChunkSet -> DocumentExtraction
    // shape whose presence caused the original CI P2003. It is NOT in
    // candidateRunIds below.
    const foreign = await createRunFixture({ status: "QUEUED", attemptCount: 0 });
    const foreignRun = await prisma.ingestionRun.update({ where: { id: foreign.id }, data: { status: "SUCCEEDED" } });
    const foreignExtraction = await prisma.documentExtraction.create({ data: { ingestionRunId: foreign.id, sourceDocumentId: foreign.sourceDocumentId, workspaceId: foreign.workspaceId, status: "SUCCEEDED", parserName: "builtin-text", parserVersion: "text-parser-v1", normalizationVersion: "canonical-text-v1", textStorageKey: `foreign/${foreign.id}.txt`, textSha256: sha256("foreign"), characterCount: 7 } });
    const foreignChunkSet = await prisma.chunkSet.create({ data: { workspaceId: foreign.workspaceId, sourceDocumentId: foreign.sourceDocumentId, extractionId: foreignExtraction.id, chunkingVersion: "foreign-v1", configuration: {}, configurationHash: sha256("foreign"), status: "SUCCEEDED" } });
    chunkSetIds.push(foreignChunkSet.id);
    const foreignBefore = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: foreign.id } });
    const foreignJobBefore = await prisma.job.findUniqueOrThrow({ where: { id: foreign.jobId } });
    const owned = await createRunFixture({ attemptCount: 2 });
    const result = await reconcileIngestionDeliveries({ queue: port, maxAttempts: 3, candidateRunIds: [owned.id] });
    expect(result.queuedRepairCount).toBe(1);
    expect(await pollState(owned.id, "waiting")).toBe("waiting");
    await port.remove(owned.id);
    // The foreign sentinel is byte-for-byte unchanged and has no delivery.
    const foreignAfter = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: foreign.id } });
    const foreignJobAfter = await prisma.job.findUniqueOrThrow({ where: { id: foreign.jobId } });
    expect(foreignAfter).toEqual(foreignBefore);
    expect(foreignJobAfter).toEqual(foreignJobBefore);
    expect(await port.getJobState(foreign.id)).toBeNull();
    // Foreign extraction + ChunkSet lineage untouched (the exact CI-failure class).
    expect(await prisma.chunkSet.findUnique({ where: { id: foreignChunkSet.id } })).not.toBeNull();
    expect(await prisma.documentExtraction.findUnique({ where: { id: foreignExtraction.id } })).not.toBeNull();
    void foreignRun;
  });
});
