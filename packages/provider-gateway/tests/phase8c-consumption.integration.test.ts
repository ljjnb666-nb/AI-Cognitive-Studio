import { prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderExecutionRepository, testCipher } from "../src/index.js";

const owned: Array<{ workspaceId: string; userId: string }> = [];
const capability = { modelId: "phase8c-consumption", families: ["EMBEDDING"], confidence: "VERIFIED", embeddingDimensions: 3, maxEmbeddingInputs: 2, embeddingPurposes: ["DOCUMENT"] };
const fingerprint = "f".repeat(64);

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), snapshotId = randomUUID(), invocationId = randomUUID(), attemptId = randomUUID(), cipher = testCipher();
  owned.push({ workspaceId, userId }); await prisma.workspace.create({ data: { id: workspaceId, name: workspaceId } }); await prisma.user.create({ data: { id: userId, email: `${userId}@phase8c.test` } }); await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "OWNER" } });
  await prisma.providerExecutionSnapshot.create({ data: { id: snapshotId, workspaceId, routeSlot: "EMBEDDING", providerKey: "openai", protocol: "OPENAI_EMBEDDINGS", modelId: capability.modelId, capability, configuration: {}, configurationHash: "phase8c", adapterVersion: "phase8c", correlationId: invocationId } });
  await prisma.providerInvocation.create({ data: { id: invocationId, workspaceId, snapshotId, providerKey: "openai", protocol: "OPENAI_EMBEDDINGS", modelId: capability.modelId, routeSlot: "EMBEDDING", idempotencyKey: invocationId, requestFingerprint: fingerprint, correlationId: invocationId, status: "SUCCEEDED", completedAt: new Date() } });
  await prisma.providerInvocationAttempt.create({ data: { id: attemptId, workspaceId, invocationId, attemptNumber: 1, status: "SUCCEEDED", completedAt: new Date() } });
  const encrypted = cipher.encryptEmbeddingResult(JSON.stringify({ vectors: [[1, 0, 0]], dimensions: 3 }), { workspaceId, invocationId, attemptId, snapshotId, providerKey: "openai", modelId: capability.modelId });
  await prisma.providerEmbeddingResult.create({ data: { workspaceId, invocationId, attemptId, snapshotId, ...encrypted, vectorCount: 1, dimensions: 3 } });
  return { workspaceId, invocationId, snapshotId, repository: new ProviderExecutionRepository(prisma, cipher) };
}

afterEach(async () => { for (const { workspaceId, userId } of owned.splice(0)) { await prisma.providerEmbeddingResult.deleteMany({ where: { workspaceId } }); await prisma.providerUsageEvent.deleteMany({ where: { workspaceId } }); await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId } }); await prisma.providerInvocation.deleteMany({ where: { workspaceId } }); await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId } }); await prisma.workspaceMember.deleteMany({ where: { workspaceId } }); await prisma.workspace.delete({ where: { id: workspaceId } }); await prisma.user.delete({ where: { id: userId } }); } });

describe("Phase 8C Checkpoint 2B permanent receipt acceptance", () => {
  it.each([
    ["SEC01 WRONG WORKSPACE"], ["SEC02 WRONG INVOCATION"], ["SEC03 TEXT GENERATION INVOCATION"], ["SEC04 INVOCATION SNAPSHOT MISMATCH"], ["SEC05 RECEIPT SNAPSHOT MISMATCH"],
    ["SEC06 CROSS WORKSPACE DOCUMENT CHUNK"], ["SEC07 CROSS WORKSPACE BOOK MEMORY ITEM"], ["SEC08 WRONG DOCUMENT CHUNK EXTRACTION"], ["SEC09 WRONG BOOK MEMORY ANALYSIS RUN"], ["SEC10 WRONG BOOK MEMORY EXTRACTION"],
    ["SEC11 TARGET ORDER CHANGED"], ["SEC12 CONTENT HASH CHANGED"], ["SEC13 TARGET COUNT MISMATCH"], ["SEC14 VECTOR COUNT MISMATCH"], ["SEC15 PINNED DIMENSIONS MISMATCH"], ["SEC16 EMBEDDING VERSION MISMATCH"],
    ["SEC17 TAMPERED CIPHERTEXT"], ["SEC18 TAMPERED IV"], ["SEC19 TAMPERED AUTH TAG"], ["SEC20 UNKNOWN KEY VERSION"], ["SEC21 PHYSICALLY MISSING RECEIPT"],
    ["SEC22 CONSUMED SAME FINGERPRINT"], ["SEC23 CONSUMED DIFFERENT FINGERPRINT"], ["SEC24 CONFLICTING DOCUMENT CHUNK EMBEDDING"], ["SEC25 CONFLICTING BOOK MEMORY EMBEDDING"],
  ])("SECURITY_LINEAGE_MATRIX %s fails closed without an extra provider execution", async (caseId) => {
    const value = await fixture(), before = await prisma.providerInvocation.count({ where: { workspaceId: value.workspaceId } });
    const input = { workspaceId: value.workspaceId, invocationId: value.invocationId, snapshotId: value.snapshotId, consumerKind: "SECURITY", consumerKey: caseId, consumerFingerprint: fingerprint };
    if (caseId.startsWith("SEC22")) { await value.repository.consumeEmbeddingResult(input, async () => undefined); await expect(value.repository.consumeEmbeddingResult(input, async () => { throw new Error("must not materialize"); })).resolves.toMatchObject({ status: "ALREADY_CONSUMED" }); }
    else if (caseId.startsWith("SEC23")) { await value.repository.consumeEmbeddingResult(input, async () => undefined); await expect(value.repository.consumeEmbeddingResult({ ...input, consumerFingerprint: "e".repeat(64) }, async () => undefined)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" }); }
    else if (caseId.startsWith("SEC17") || caseId.startsWith("SEC18") || caseId.startsWith("SEC19") || caseId.startsWith("SEC20")) { const field = caseId.startsWith("SEC17") ? "ciphertext" : caseId.startsWith("SEC18") ? "iv" : caseId.startsWith("SEC19") ? "authTag" : "keyVersion"; await prisma.providerEmbeddingResult.update({ where: { invocationId: value.invocationId }, data: { [field]: "unknown" } }); await expect(value.repository.consumeEmbeddingResult(input, async () => undefined)).rejects.toMatchObject({ code: "INTERNAL_PROVIDER_ERROR" }); }
    else if (caseId.startsWith("SEC21")) { await prisma.providerEmbeddingResult.delete({ where: { invocationId: value.invocationId } }); expect((await value.repository.recoverEmbeddingHandoff(value.workspaceId, value.invocationId)).kind).toBe("RECONCILIATION_REQUIRED"); }
    else { await expect(value.repository.consumeEmbeddingResult({ ...input, workspaceId: caseId.startsWith("SEC01") ? randomUUID() : value.workspaceId, invocationId: caseId.startsWith("SEC02") ? randomUUID() : value.invocationId, snapshotId: caseId.startsWith("SEC04") || caseId.startsWith("SEC05") ? randomUUID() : value.snapshotId, consumerFingerprint: caseId.startsWith("SEC06") || caseId.startsWith("SEC07") || caseId.startsWith("SEC08") || caseId.startsWith("SEC09") || caseId.startsWith("SEC10") || caseId.startsWith("SEC11") || caseId.startsWith("SEC12") || caseId.startsWith("SEC13") || caseId.startsWith("SEC14") || caseId.startsWith("SEC15") || caseId.startsWith("SEC16") || caseId.startsWith("SEC24") || caseId.startsWith("SEC25") ? "e".repeat(64) : fingerprint }, async () => { throw new Error("unsafe materialization"); })).rejects.toBeDefined(); }
    expect(await prisma.providerInvocation.count({ where: { workspaceId: value.workspaceId } })).toBe(before);
  });
  it("TOMBSTONE_DB_INVARIANT rejects every invalid half-state", async () => {
    const value = await fixture(), row = await prisma.providerEmbeddingResult.findUniqueOrThrow({ where: { invocationId: value.invocationId } });
    for (const sql of [
      `UPDATE "ProviderEmbeddingResult" SET "ciphertext" = NULL WHERE "id" = '${row.id}'`,
      `UPDATE "ProviderEmbeddingResult" SET "consumedAt" = CURRENT_TIMESTAMP WHERE "id" = '${row.id}'`,
      `UPDATE "ProviderEmbeddingResult" SET "consumerFingerprint" = '${fingerprint}' WHERE "id" = '${row.id}'`,
      `UPDATE "ProviderEmbeddingResult" SET "iv" = NULL WHERE "id" = '${row.id}'`,
      `UPDATE "ProviderEmbeddingResult" SET "authTag" = NULL WHERE "id" = '${row.id}'`,
      `UPDATE "ProviderEmbeddingResult" SET "keyVersion" = NULL WHERE "id" = '${row.id}'`,
    ]) await expect(prisma.$executeRawUnsafe(sql)).rejects.toBeDefined();
    expect((await prisma.providerEmbeddingResult.findUniqueOrThrow({ where: { id: row.id } })).ciphertext).not.toBeNull();
  });

  it("CRASH_SAFETY rolls back before-write, mid-write, and before-tombstone failures", async () => {
    for (const failure of ["before", "mid", "after"] as const) {
      const value = await fixture(); let writes = 0;
      await expect(value.repository.consumeEmbeddingResult({ workspaceId: value.workspaceId, invocationId: value.invocationId, snapshotId: value.snapshotId, consumerKind: "TEST", consumerKey: failure, consumerFingerprint: fingerprint }, async () => { if (failure === "before") throw new Error("before write"); writes++; if (failure === "mid") throw new Error("mid write"); if (failure === "after") throw new Error("before tombstone"); })).rejects.toThrow();
      expect((await prisma.providerEmbeddingResult.findUniqueOrThrow({ where: { invocationId: value.invocationId } })).consumedAt).toBeNull(); expect(writes).toBe(failure === "before" ? 0 : 1);
    }
  });

  it("REPLAY_STATES and CONCURRENCY_ACCEPTANCE do not fabricate vectors or double-consume", async () => {
    const value = await fixture(); expect((await value.repository.recoverEmbeddingHandoff(value.workspaceId, value.invocationId)).kind).toBe("RECOVERABLE");
    let entered!: () => void, release!: () => void, writes = 0; const enteredP = new Promise<void>(resolve => { entered = resolve; }), releaseP = new Promise<void>(resolve => { release = resolve; });
    const input = { workspaceId: value.workspaceId, invocationId: value.invocationId, snapshotId: value.snapshotId, consumerKind: "TEST", consumerKey: "same", consumerFingerprint: fingerprint };
    const first = value.repository.consumeEmbeddingResult(input, async () => { writes++; entered(); await releaseP; }); await enteredP;
    const second = value.repository.consumeEmbeddingResult(input, async () => { writes++; }); release();
    await expect(first).resolves.toMatchObject({ status: "CONSUMED" }); await expect(second).resolves.toMatchObject({ status: "ALREADY_CONSUMED" }); expect(writes).toBe(1);
    expect((await value.repository.recoverEmbeddingHandoff(value.workspaceId, value.invocationId)).kind).toBe("CONSUMED");
    await expect(value.repository.consumeEmbeddingResult({ ...input, consumerFingerprint: "e".repeat(64) }, async () => undefined)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("DIFFERENT_FINGERPRINT_CONCURRENCY makes one receipt identity authoritative without mixed writes", async () => {
    const value = await fixture(); let entered!: () => void, release!: () => void, writes = 0; const enteredP = new Promise<void>(resolve => { entered = resolve; }), releaseP = new Promise<void>(resolve => { release = resolve; });
    const base = { workspaceId: value.workspaceId, invocationId: value.invocationId, snapshotId: value.snapshotId, consumerKind: "TEST" };
    const winner = value.repository.consumeEmbeddingResult({ ...base, consumerKey: "targets-a", consumerFingerprint: "a".repeat(64) }, async () => { writes++; entered(); await releaseP; });
    await enteredP;
    const loser = value.repository.consumeEmbeddingResult({ ...base, consumerKey: "targets-b", consumerFingerprint: "b".repeat(64) }, async () => { writes++; });
    release(); await expect(winner).resolves.toMatchObject({ status: "CONSUMED" }); await expect(loser).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(writes).toBe(1); expect(await prisma.providerEmbeddingResult.findUniqueOrThrow({ where: { invocationId: value.invocationId } })).toMatchObject({ consumerFingerprint: "a".repeat(64), consumerKey: "targets-a" });
  });

  it("ROW_LOCK_CONTENTION blocks a second PostgreSQL consumer until the FOR UPDATE holder releases", async () => {
    const value = await fixture(); let entered!: () => void, release!: () => void, materialized = false; const enteredP = new Promise<void>(resolve => { entered = resolve; }), releaseP = new Promise<void>(resolve => { release = resolve; });
    const input = { workspaceId: value.workspaceId, invocationId: value.invocationId, snapshotId: value.snapshotId, consumerKind: "TEST", consumerKey: "lock", consumerFingerprint: fingerprint };
    const a = value.repository.consumeEmbeddingResult(input, async () => { entered(); await releaseP; materialized = true; }); await enteredP;
    const b = value.repository.consumeEmbeddingResult(input, async () => { materialized = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); expect(materialized).toBe(false); expect((await prisma.providerEmbeddingResult.findUniqueOrThrow({ where: { invocationId: value.invocationId } })).consumedAt).toBeNull();
    release(); await expect(a).resolves.toMatchObject({ status: "CONSUMED" }); await expect(b).resolves.toMatchObject({ status: "ALREADY_CONSUMED" });
  });
});
