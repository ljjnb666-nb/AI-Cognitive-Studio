import crypto from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { materializeChunkSet, reconcileStaleBookAnalysisJob, reconcileStaleBookAnalysisJobs, recoverBookAnalysisForUser, requestBookAnalysis, requestBookAnalysisForUser, sha256 } from "../src/index.js";

const workspaces: string[] = [], users: string[] = [];

async function fixture() {
  const suffix = crypto.randomUUID();
  const owner = await prisma.user.create({ data: { email: `owner-${suffix}@test` } });
  const member = await prisma.user.create({ data: { email: `member-${suffix}@test` } });
  const outsider = await prisma.user.create({ data: { email: `outsider-${suffix}@test` } });
  users.push(owner.id, member.id, outsider.id);
  const workspace = await prisma.workspace.create({ data: { name: suffix } });
  workspaces.push(workspace.id);
  await prisma.workspaceMember.createMany({ data: [{ workspaceId: workspace.id, userId: owner.id, role: "OWNER" }, { workspaceId: workspace.id, userId: member.id, role: "EDITOR" }] });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "book.md" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: suffix, sizeBytes: BigInt(1), mediaType: "text/markdown", storageKey: `test/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: BigInt(1), mediaType: "text/markdown", storageKey: blob.storageKey } });
  const ingest = await prisma.job.create({ data: { workspaceId: workspace.id, userId: owner.id, type: "source.ingest", payload: {}, idempotencyKey: `ingest:${suffix}` } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: ingest.id, parserVersion: "test", normalizationVersion: "test" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } });
  await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal: 0, kind: "PARAGRAPH", text: "durable provenance", contentHash: suffix } });
  await prisma.currentDocumentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id } });
  const chunkSet = await materializeChunkSet({ workspaceId: workspace.id, sourceDocumentId: document.id, configuration: { targetSize: 80, hardMax: 100 } });
  const input = { sourceDocumentId: document.id, chunkSetId: chunkSet.id, pipelineVersion: `provenance-${suffix}`, promptVersion: "p", provider: "test", model: "test" };
  return { owner, member, outsider, workspace, document, input };
}

afterEach(async () => {
  for (const workspaceId of workspaces.splice(0)) {
    await prisma.currentBookIntelligence.deleteMany({ where: { workspaceId } });
    await prisma.bookAnalysisRun.deleteMany({ where: { workspaceId } });
    await prisma.chunkSet.deleteMany({ where: { workspaceId } });
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId } });
    await prisma.job.deleteMany({ where: { workspaceId } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId } });
    await prisma.source.deleteMany({ where: { workspaceId } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(() => prisma.$disconnect());

describe("BookAnalysis durable initiating principal", () => {
  it("persists the authorized initiating user without changing idempotency or existing provenance", async () => {
    const value = await fixture();
    const first = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    expect(first.job).toMatchObject({ userId: value.owner.id, workspaceId: value.workspace.id });
    expect(first.run.jobId).toBe(first.job.id);
    const duplicate = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.member.id }, value.input);
    expect(duplicate.run.id).toBe(first.run.id);
    expect(duplicate.job.userId).toBe(value.owner.id);
  });

  it("rejects a non-member before creating durable rows", async () => {
    const value = await fixture();
    await expect(requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.outsider.id }, value.input)).rejects.toThrow("WORKSPACE_ACCESS_DENIED");
    expect(await prisma.bookAnalysisRun.count({ where: { workspaceId: value.workspace.id } })).toBe(0);
    expect(await prisma.job.count({ where: { workspaceId: value.workspace.id, type: "book.analysis" } })).toBe(0);
  });

  it("does not backfill actor-null durable state", async () => {
    const value = await fixture();
    const system = await requestBookAnalysis({ workspaceId: value.workspace.id, ...value.input });
    expect(system.job.userId).toBeNull();
    const duplicate = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    expect(duplicate.run.id).toBe(system.run.id);
    expect(duplicate.job.userId).toBeNull();
  });

  it("rejects a status-only success without its durable finalization proof", async () => {
    const value = await fixture();
    const requested = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "SUCCEEDED", analysisStage: "COMPLETED", completedAt: new Date() } });
    const ingestionBefore = await prisma.ingestionRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id } });
    await expect(recoverBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.document.id)).rejects.toThrow("BOOK_ANALYSIS_FINALIZATION_INCOMPLETE");
    expect(await prisma.currentBookIntelligence.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: value.document.id, workspaceId: value.workspace.id } } })).toBeNull();
    expect(await prisma.ingestionRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id } })).toBe(ingestionBefore);
    expect(await prisma.bookAnalysisRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id } })).toBe(1);
  });

  it("requeues failed analysis without replaying ingestion and keeps foreign recovery private", async () => {
    const value = await fixture();
    const requested = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "FAILED", errorCode: "SAFE_FAILURE" } });
    const ingestionBefore = await prisma.ingestionRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id } });
    await expect(recoverBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.outsider.id }, value.document.id)).rejects.toThrow("WORKSPACE_ACCESS_DENIED");
    const recoveries = await Promise.all(Array.from({ length: 5 }, () => recoverBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.document.id)));
    expect(recoveries.filter(recovery => recovery.created)).toHaveLength(1);
    expect(await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: requested.run.id } })).toMatchObject({ status: "QUEUED" });
    expect(await prisma.ingestionRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id } })).toBe(ingestionBefore);
  });

  it("preserves a non-unique admission failure instead of replacing it with a missing-run lookup", async () => {
    const value = await fixture();
    await prisma.job.createMany({ data: [0, 1].map(ordinal => ({ workspaceId: value.workspace.id, userId: value.owner.id, type: "book.analysis", status: "QUEUED", payload: {}, idempotencyKey: `occupied:${ordinal}:${crypto.randomUUID()}` })) });
    await expect(requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input)).rejects.toThrow("WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED");
    expect(await prisma.bookAnalysisRun.count({ where: { workspaceId: value.workspace.id } })).toBe(0);
  });

  it("does not treat a Job idempotency collision as a BookAnalysisRun identity race", async () => {
    const value = await fixture();
    const analysisIdentityHash = sha256(JSON.stringify([value.input.chunkSetId, value.input.pipelineVersion, value.input.promptVersion, value.input.provider, value.input.model, ""]));
    await prisma.job.create({ data: { workspaceId: value.workspace.id, userId: value.owner.id, type: "book.analysis", status: "SUCCEEDED", payload: {}, idempotencyKey: `book:${analysisIdentityHash}` } });
    await expect(requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input)).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.bookAnalysisRun.count({ where: { workspaceId: value.workspace.id } })).toBe(0);
  });

  it("reconciles only an expired Book analysis lease and releases its admission job", async () => {
    const value = await fixture();
    const requested = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    const expiredAt = new Date(Date.now() - 1_000);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "RUNNING", executionClaimToken: crypto.randomUUID(), executionClaimedAt: expiredAt, executionLeaseUntil: expiredAt } });
    await prisma.job.update({ where: { id: requested.job.id }, data: { status: "RUNNING" } });
    await expect(reconcileStaleBookAnalysisJob(requested.job.id)).resolves.toBe("STALE_RUN_FAILED");
    await expect(prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: requested.run.id } })).resolves.toMatchObject({ status: "FAILED", errorCode: "BOOK_ANALYSIS_EXECUTION_LEASE_EXPIRED", executionClaimToken: null });
    await expect(prisma.job.findUniqueOrThrow({ where: { id: requested.job.id } })).resolves.toMatchObject({ status: "FAILED", error: { code: "BOOK_ANALYSIS_EXECUTION_LEASE_EXPIRED" } });
  });

  it("allows exactly one concurrent batch reconciler to terminalize an expired run", async () => {
    const value = await fixture();
    const requested = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    const expiredAt = new Date(Date.now() - 1_000);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "RUNNING", executionClaimToken: crypto.randomUUID(), executionClaimedAt: expiredAt, executionLeaseUntil: expiredAt } });
    await prisma.job.update({ where: { id: requested.job.id }, data: { status: "RUNNING" } });
    const [left, right] = await Promise.all([reconcileStaleBookAnalysisJobs(), reconcileStaleBookAnalysisJobs()]);
    expect(left.reconciled + right.reconciled).toBe(1);
    expect(left.errors + right.errors).toBe(0);
    expect(left.provider_calls + right.provider_calls).toBe(0);
    await expect(prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: requested.run.id } })).resolves.toMatchObject({ status: "FAILED", errorCode: "BOOK_ANALYSIS_EXECUTION_LEASE_EXPIRED", executionClaimToken: null });
    await expect(prisma.job.findUniqueOrThrow({ where: { id: requested.job.id } })).resolves.toMatchObject({ status: "FAILED", error: { code: "BOOK_ANALYSIS_EXECUTION_LEASE_EXPIRED" } });
  });

  it("leaves a valid active lease unchanged and classifies the sweep result", async () => {
    const value = await fixture();
    const requested = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    const validUntil = new Date(Date.now() + 60_000);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "RUNNING", executionClaimToken: crypto.randomUUID(), executionClaimedAt: new Date(), executionLeaseUntil: validUntil } });
    await prisma.job.update({ where: { id: requested.job.id }, data: { status: "RUNNING" } });
    const [runBefore, jobBefore] = await Promise.all([
      prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: requested.run.id } }),
      prisma.job.findUniqueOrThrow({ where: { id: requested.job.id } }),
    ]);
    await expect(reconcileStaleBookAnalysisJob(requested.job.id)).resolves.toBe("SKIPPED_VALID_LEASE");
    await expect(reconcileStaleBookAnalysisJobs()).resolves.toMatchObject({ discovered: 0, reconciled: 0, skipped_valid_lease: 0, errors: 0, provider_calls: 0 });
    await expect(prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: requested.run.id } })).resolves.toEqual(runBefore);
    await expect(prisma.job.findUniqueOrThrow({ where: { id: requested.job.id } })).resolves.toEqual(jobBefore);
  });

  it("skips an active orphan Book Job as ambiguous without mutating it", async () => {
    const value = await fixture();
    const orphan = await prisma.job.create({ data: { workspaceId: value.workspace.id, userId: value.owner.id, type: "book.analysis", status: "QUEUED", payload: { sourceDocumentId: value.document.id }, idempotencyKey: `orphan:${crypto.randomUUID()}` } });
    const before = await prisma.job.findUniqueOrThrow({ where: { id: orphan.id } });
    const [invocationsBefore, outboxBefore] = await Promise.all([
      prisma.providerInvocation.count({ where: { workspaceId: value.workspace.id } }),
      prisma.outboxEvent.count({ where: { aggregateId: orphan.id } }),
    ]);
    await expect(reconcileStaleBookAnalysisJob(orphan.id)).resolves.toBe("AMBIGUOUS_SKIPPED");
    await expect(prisma.job.findUniqueOrThrow({ where: { id: orphan.id } })).resolves.toEqual(before);
    expect(await prisma.providerInvocation.count({ where: { workspaceId: value.workspace.id } })).toBe(invocationsBefore);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: orphan.id } })).toBe(outboxBefore);
  });

  it("reports bounded stale sweep outcomes and is idempotent after reconciliation", async () => {
    const value = await fixture();
    const requested = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    const expiredAt = new Date(Date.now() - 1_000);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "RUNNING", executionClaimToken: crypto.randomUUID(), executionClaimedAt: expiredAt, executionLeaseUntil: expiredAt } });
    await prisma.job.update({ where: { id: requested.job.id }, data: { status: "RUNNING" } });
    const first = await reconcileStaleBookAnalysisJobs(1);
    const second = await reconcileStaleBookAnalysisJobs(1);
    expect(first).toMatchObject({ discovered: 1, reconciled: 1, errors: 0, provider_calls: 0 });
    expect(second).toMatchObject({ discovered: 0, reconciled: 0, errors: 0, provider_calls: 0 });
    await expect(prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: requested.run.id } })).resolves.toMatchObject({ status: "FAILED", errorCode: "BOOK_ANALYSIS_EXECUTION_LEASE_EXPIRED" });
  });

  it("lets an authoritative success win while the stale reconciler waits for the run lock", async () => {
    const value = await fixture();
    const requested = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    const expiredAt = new Date(Date.now() - 1_000);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "RUNNING", executionClaimToken: crypto.randomUUID(), executionClaimedAt: expiredAt, executionLeaseUntil: expiredAt } });
    await prisma.job.update({ where: { id: requested.job.id }, data: { status: "RUNNING" } });
    let release!: () => void;
    let signalLock!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { signalLock = resolve; });
    const ownerTransaction = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "BookAnalysisRun" WHERE "id" = ${requested.run.id} FOR UPDATE`;
      signalLock();
      await hold;
      await tx.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "SUCCEEDED", completedAt: new Date(), executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null } });
      await tx.job.update({ where: { id: requested.job.id }, data: { status: "SUCCEEDED", completedAt: new Date() } });
    });
    await locked;
    const staleReconciliation = reconcileStaleBookAnalysisJob(requested.job.id);
    try {
      await expect.poll(async () => {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS "count" FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM "BookAnalysisRun" WHERE "jobId"%'`;
        return rows[0]?.count ?? 0;
      }, { timeout: 5_000, interval: 25 }).toBeGreaterThan(0);
    } finally {
      release();
      await ownerTransaction;
    }
    await expect(staleReconciliation).resolves.toBe("ALREADY_TERMINAL");
    await expect(prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: requested.run.id } })).resolves.toMatchObject({ status: "SUCCEEDED", errorCode: null });
    await expect(prisma.job.findUniqueOrThrow({ where: { id: requested.job.id } })).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("serializes concurrent request-boundary retries and advances a run-scoped durable recovery ordinal", async () => {
    const value = await fixture();
    const requested = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "FAILED", errorCode: "FIRST_FAILURE" } });
    await prisma.job.update({ where: { id: requested.job.id }, data: { status: "FAILED", error: { code: "FIRST_FAILURE" }, completedAt: new Date() } });

    const concurrent = await Promise.all(Array.from({ length: 5 }, () => requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input)));
    expect(new Set(concurrent.map(result => result.run.id))).toEqual(new Set([requested.run.id]));
    expect(new Set(concurrent.map(result => result.job.id)).size).toBe(1);
    expect(concurrent[0]!.job.idempotencyKey).toBe(`book:${requested.run.analysisIdentityHash}:recovery:1`);

    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "FAILED", errorCode: "SECOND_FAILURE" } });
    await prisma.job.update({ where: { id: concurrent[0]!.job.id }, data: { status: "FAILED", error: { code: "SECOND_FAILURE" }, completedAt: new Date() } });
    const second = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    expect(second.run.id).toBe(requested.run.id);
    expect(second.job.id).not.toBe(concurrent[0]!.job.id);
    expect(second.job.idempotencyKey).toBe(`book:${requested.run.analysisIdentityHash}:recovery:2`);
    expect(await prisma.job.findMany({
      where: { workspaceId: value.workspace.id, idempotencyKey: { startsWith: `book:${requested.run.analysisIdentityHash}:recovery:` } },
      select: { idempotencyKey: true },
      orderBy: { idempotencyKey: "asc" },
    })).toEqual([
      { idempotencyKey: `book:${requested.run.analysisIdentityHash}:recovery:1` },
      { idempotencyKey: `book:${requested.run.analysisIdentityHash}:recovery:2` },
    ]);
  });

  it("allocates a new durable recovery key when a later failed retry has no BullMQ attempt increment", async () => {
    const value = await fixture();
    const requested = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "FAILED", errorCode: "FIRST_FAILURE" } });
    const first = await recoverBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.document.id);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "FAILED", errorCode: "SECOND_FAILURE" } });
    const second = await recoverBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.document.id);
    expect([first, second].map(recovery => recovery.created)).toEqual([true, true]);
    expect(await prisma.job.findMany({ where: { workspaceId: value.workspace.id, idempotencyKey: { startsWith: `book:${requested.run.analysisIdentityHash}:recovery:` } }, select: { idempotencyKey: true }, orderBy: { idempotencyKey: "asc" } })).toEqual([{ idempotencyKey: `book:${requested.run.analysisIdentityHash}:recovery:1` }, { idempotencyKey: `book:${requested.run.analysisIdentityHash}:recovery:2` }]);
  });
});
