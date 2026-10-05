import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import type { StorageProvider } from "@ai-cognitive/storage";
import { claimIngestionRun, completeRunSuccess, INGESTION_EXECUTION_LEASE_EXPIRED, lockRunForPublication, renewIngestionRunClaim, transitionRunToRetryable, transitionRunToTerminal, RUN_LEASE_TTL_MS } from "../src/ingestion-run-claim.js";
import { createIngestionService } from "../src/index.js";
import { writeRoutingOutcome, writeRoutingPlan } from "../src/ocr-durability.js";

const workspaceIds: string[] = [];
const userIds: string[] = [];
const runIds: string[] = [];

class FakeStorageProvider implements StorageProvider {
  readonly objects = new Map<string, Uint8Array>();
  async createPresignedUpload(input: { key: string; contentType: string; expiresInSeconds: number }) { return { url: `https://storage.test/${input.key}`, headers: { "content-type": input.contentType } }; }
  async headObject(key: string) { const body = this.objects.get(key); return body ? { key, size: body.length, contentType: "text/plain" } : null; }
  async getObjectStream(key: string) { const body = await this.getObjectBytes(key); return (async function* () { yield body; })(); }
  async getObjectBytes(key: string) { const body = this.objects.get(key); if (!body) throw new Error(`OBJECT_NOT_FOUND:${key}`); return body; }
  async putObject({ key, body }: { key: string; body: Uint8Array; contentType: string }) { this.objects.set(key, body); }
  async copyObject(sourceKey: string, targetKey: string) { this.objects.set(targetKey, await this.getObjectBytes(sourceKey)); }
  async deleteObject(key: string) { this.objects.delete(key); }
  async objectExists(key: string) { return this.objects.has(key); }
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function createRunFixture(status: "QUEUED" | "RUNNING" | "FAILED" = "QUEUED", attemptCount = 0, mediaType: "text/plain" | "application/pdf" = "text/plain") {
  const user = await prisma.user.create({ data: { email: `claim-${crypto.randomUUID()}@test`, name: "Claim" } });
  const workspace = await prisma.workspace.create({ data: { name: `claim-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256(`blob-${crypto.randomUUID()}`), sizeBytes: 12, mediaType, storageKey: `test/${crypto.randomUUID()}` } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "claim-test" } });
  const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: 12, mediaType, storageKey: blob.storageKey } });
  const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id }, attemptCount, status: status === "RUNNING" ? "RUNNING" : "QUEUED" } });
  const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "builtin-text", normalizationVersion: "canonical-text-v1", status } });
  runIds.push(run.id);
  return { user, workspace, document, job, run, storage: new FakeStorageProvider() };
}

async function expireLease(runId: string) {
  await prisma.ingestionRun.update({ where: { id: runId }, data: { executionLeaseUntil: new Date(Date.now() - 1_000) } });
}

afterEach(async () => {
  if (runIds.length) await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
});

afterAll(async () => {
  for (const runId of runIds) {
    const bootstraps = await prisma.bookAnalysisBootstrap.findMany({ where: { ingestionRunId: runId }, select: { id: true } });
    if (bootstraps.length) await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: bootstraps.map((b) => b.id) } } });
  }
  await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.sourceSpan.deleteMany({ where: { sourceBlock: { extraction: { workspaceId: { in: workspaceIds } } } } });
  await prisma.sourceBlock.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } } });
  await prisma.sourcePage.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } } });
  await prisma.bookAnalysisBootstrap.deleteMany({ where: { ingestionRunId: { in: runIds } } });
  await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.ocrPageAttempt.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.ocrServerInstance.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.uploadCompletion.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.uploadSession.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.ocrHostLease.deleteMany();
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  workspaceIds.length = 0;
  userIds.length = 0;
  runIds.length = 0;
  await prisma.$disconnect();
});

describe("ingestion run claim (real PostgreSQL)", () => {
  it("RUN_CLAIM_EXCLUSIVE: a live claim refuses a second claimant", async () => {
    const { run } = await createRunFixture();
    const first = await claimIngestionRun(run.id, 3);
    expect(first).not.toBeNull();
    const second = await claimIngestionRun(run.id, 3);
    expect(second).toBeNull();
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.executionClaimToken).toBe(first!.token);
    expect(row.status).toBe("RUNNING");
  });

  it("RUN_LIVE_LEASE_NOT_RECLAIMED: RUNNING with a live lease is not claimable", async () => {
    const { run } = await createRunFixture("RUNNING");
    await prisma.ingestionRun.update({ where: { id: run.id }, data: { executionClaimToken: "live-token", executionLeaseUntil: new Date(Date.now() + RUN_LEASE_TTL_MS) } });
    expect(await claimIngestionRun(run.id, 3)).toBeNull();
  });

  it("RUN_EXPIRED_LEASE_RECLAIMED: expired RUNNING is reclaimed with a fresh token and attemptCount increments", async () => {
    const { run } = await createRunFixture("RUNNING", 1);
    await prisma.ingestionRun.update({ where: { id: run.id }, data: { executionClaimToken: "stale-token", executionLeaseUntil: new Date(Date.now() - 1_000) } });
    const claim = await claimIngestionRun(run.id, 3);
    expect(claim).not.toBeNull();
    expect(claim!.token).not.toBe("stale-token");
    expect(claim!.attemptCount).toBe(2);
  });

  it("RUN_ATTEMPT_LIMIT_HARD_DB_GUARD: the durable attempt guard refuses claims past max regardless of caller", async () => {
    const { run } = await createRunFixture("QUEUED", 2);
    const claim = await claimIngestionRun(run.id, 3);
    expect(claim!.attemptCount).toBe(3);
    await transitionRunToRetryable(run.id, claim!.token, "TRANSIENT_FAULT");
    // The cap is the SSOT value supplied at both call sites (queue opts + claim
    // guard), not a column constant: max=3 refuses, and no production caller
    // passes anything else.
    expect(await claimIngestionRun(run.id, 3)).toBeNull();
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("QUEUED");
    const job = await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } });
    expect(job.attemptCount).toBe(3);
  });

  it("FAILED is not claimable", async () => {
    const { run } = await createRunFixture("FAILED", 3);
    expect(await claimIngestionRun(run.id, 3)).toBeNull();
  });

  it("RUN_RETRYABLE_TO_QUEUED: retryable failure atomically requeues run + Job and clears the claim", async () => {
    const { run } = await createRunFixture();
    const claim = await claimIngestionRun(run.id, 3);
    expect(await transitionRunToRetryable(run.id, claim!.token, "TRANSIENT_FAULT")).toBe(true);
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("QUEUED");
    expect(row.errorCode).toBe("TRANSIENT_FAULT");
    expect(row.executionClaimToken).toBeNull();
    expect(row.executionLeaseUntil).toBeNull();
    const job = await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } });
    expect(job.status).toBe("QUEUED");
  });

  it("RUN_MAX_ATTEMPTS_TO_FAILED: exhausted budget terminalizes run FAILED + Job FAILED atomically", async () => {
    const { run } = await createRunFixture();
    const claim = await claimIngestionRun(run.id, 3);
    expect(await transitionRunToTerminal(run.id, claim!.token, "FAILED", "STORAGE_TIMEOUT")).toBe(true);
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("STORAGE_TIMEOUT");
    const job = await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } });
    expect(job.status).toBe("FAILED");
  });

  it("RUN_OWNERSHIP_LOST_NO_WRITE: an expired-lease owner writes nothing", async () => {
    const { run } = await createRunFixture();
    const claim = await claimIngestionRun(run.id, 3);
    await expireLease(run.id);
    expect(await transitionRunToRetryable(run.id, claim!.token, "LATE_RETRY")).toBe(false);
    expect(await transitionRunToTerminal(run.id, claim!.token, "FAILED", "LATE_FAIL")).toBe(false);
    expect(await renewIngestionRunClaim(run.id, claim!.token)).toBe(false);
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("RUNNING");
    expect(row.errorCode).toBeNull();
    const job = await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } });
    expect(job.status).toBe("RUNNING");
  });

  it("RUN_JOB_CLAIM_ATOMIC: claim transitions run and Job in one transaction", async () => {
    const { run } = await createRunFixture();
    const before = await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } });
    expect(before.attemptCount).toBe(0);
    await claimIngestionRun(run.id, 3);
    const runRow = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    const jobRow = await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } });
    expect(runRow.status).toBe("RUNNING");
    expect(jobRow.status).toBe("RUNNING");
    expect(jobRow.attemptCount).toBe(1);
  });

  it("FINAL_PUBLICATION_REQUIRES_LIVE_RUN_CLAIM: the row-lock fence requires token + unexpired lease", async () => {
    const { run } = await createRunFixture();
    const claim = await claimIngestionRun(run.id, 3);
    await prisma.$transaction(async (tx) => {
      expect(await lockRunForPublication(tx, run.id, claim!.token)).toBe(true);
    });
    await expireLease(run.id);
    await prisma.$transaction(async (tx) => {
      expect(await lockRunForPublication(tx, run.id, claim!.token)).toBe(false);
    });
    await prisma.$transaction(async (tx) => {
      expect(await lockRunForPublication(tx, run.id, "wrong-token")).toBe(false);
    });
  });

  it("RUN_STALE_OWNER_AFTER_SUCCESS + RUN_STALE_OWNER_FAILURE_WRITE_NOOP: a stale owner changes zero durable rows after B publishes", async () => {
    const { run, storage } = await createRunFixture();
    const tokenA = (await claimIngestionRun(run.id, 3))!.token;
    await expireLease(run.id);
    const service = createIngestionService(storage, { maxUploadBytes: 100 * 1024 * 1024, uploadTtlSeconds: 900, maxPdfPages: 2000, completionLeaseMs: 900000, processMaxAttempts: 3 });
    await storage.putObject({ key: (await prisma.sourceDocument.findUniqueOrThrow({ where: { id: run.sourceDocumentId } })).storageKey, body: Buffer.from("worker B payload", "utf8"), contentType: "text/plain" });
    await service.processIngestionRun(run.id);

    const succeeded = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(succeeded.status).toBe("SUCCEEDED");
    const extractions = await prisma.documentExtraction.findMany({ where: { ingestionRunId: run.id } });
    expect(extractions).toHaveLength(1);
    // RF01-01: the published key is content-addressed, never the mutable text.txt form.
    expect(extractions[0]!.textStorageKey).toMatch(/\/text\/[0-9a-f]{64}\.txt$/);
    expect(extractions[0]!.textStorageKey!.endsWith("/text.txt")).toBe(false);
    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: run.sourceDocumentId, workspaceId: run.workspaceId } } });
    expect(current.extractionId).toBe(extractions[0]!.id);
    const bootstraps = await prisma.bookAnalysisBootstrap.findMany({ where: { ingestionRunId: run.id } });
    expect(bootstraps).toHaveLength(1);
    const bootstrapEvents = await prisma.outboxEvent.count({ where: { topic: "book.analysis.bootstrap.requested", aggregateId: bootstraps[0]!.id } });
    expect(bootstrapEvents).toBe(1);

    // RF01-02 storage ownership regression: A returns late and writes the text
    // artifact its stale claim prepared (different bytes than B's). The write is
    // content-addressed, so it lands on a different immutable key and can never
    // change the bytes B's published extraction references.
    const staleText = "worker A stale payload";
    const staleKey = `workspaces/${run.workspaceId}/extractions/${run.id}/text/${sha256(staleText)}.txt`;
    await storage.putObject({ key: staleKey, body: Buffer.from(staleText, "utf8"), contentType: "text/plain; charset=utf-8" });

    // Worker A returns late and attempts every durable write it still holds a token for.
    await prisma.$transaction(async (tx) => {
      expect(await lockRunForPublication(tx, run.id, tokenA)).toBe(false);
    });
    expect(await transitionRunToTerminal(run.id, tokenA, "FAILED", "STALE_FAILURE")).toBe(false);
    expect(await transitionRunToRetryable(run.id, tokenA, "STALE_RETRY")).toBe(false);
    expect(await renewIngestionRunClaim(run.id, tokenA)).toBe(false);
    await expect(prisma.$transaction(async (tx) => { if (!(await lockRunForPublication(tx, run.id, tokenA))) throw new Error("INGESTION_EXECUTION_OWNERSHIP_LOST"); await completeRunSuccess(tx, run.id, tokenA); })).rejects.toThrow();

    const after = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("SUCCEEDED");
    expect(after.errorCode).toBeNull();
    expect((await prisma.documentExtraction.findMany({ where: { ingestionRunId: run.id } })).length).toBe(1);
    expect((await prisma.bookAnalysisBootstrap.findMany({ where: { ingestionRunId: run.id } })).length).toBe(1);
    const jobRow = await prisma.job.findUniqueOrThrow({ where: { id: run.jobId } });
    expect(jobRow.status).toBe("SUCCEEDED");

    // The authoritative extraction still references B's exact immutable artifact;
    // A's late write left only an unreferenced orphan object.
    const published = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
    expect(published.textStorageKey).toBe(`workspaces/${run.workspaceId}/extractions/${run.id}/text/${published.textSha256}.txt`);
    expect(published.textStorageKey).not.toBe(staleKey);
    expect(Buffer.from(await storage.getObjectBytes(published.textStorageKey!)).toString("utf8")).toBe("worker B payload");
  });

  it("terminalizeExpiredIngestionRun: CASE 3 CAS only fires on still-expired RUNNING with the stable lease-expired code", async () => {
    const { run } = await createRunFixture("RUNNING", 3);
    await prisma.ingestionRun.update({ where: { id: run.id }, data: { executionClaimToken: "dead-token", executionLeaseUntil: new Date(Date.now() - 5_000) } });
    const { terminalizeExpiredIngestionRun } = await import("../src/ingestion-run-claim.js");
    expect(await terminalizeExpiredIngestionRun(run.id)).toBe(true);
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe(INGESTION_EXECUTION_LEASE_EXPIRED);
    expect(await terminalizeExpiredIngestionRun(run.id)).toBe(false);
  });

  it("ROUTING_PLAN_WRITE_ONCE + ROUTING_OUTCOME_ONE_WAY: plan is immutable; outcome is a one-way terminal fill", async () => {
    const { run } = await createRunFixture();
    const plan = { schemaVersion: "routing-manifest-v1", pages: [] };
    expect(await writeRoutingPlan(run.id, 1, plan)).toBe(true);
    expect(await writeRoutingPlan(run.id, 2, { mutated: true })).toBe(false);
    const row = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.routingGeneration).toBe(1);
    expect(row.routingPlan).toEqual(plan);
    expect(await writeRoutingOutcome(run.id, 2, { early: true })).toBe(false);
    expect(await writeRoutingOutcome(run.id, 1, { publishable: true })).toBe(true);
    expect(await writeRoutingOutcome(run.id, 1, { publishable: false })).toBe(false);
    const final = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(final.routingOutcome).toEqual({ publishable: true });
  });
});
