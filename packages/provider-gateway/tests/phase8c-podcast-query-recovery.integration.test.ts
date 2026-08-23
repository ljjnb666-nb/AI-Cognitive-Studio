import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { canonicalEmbeddingInputHash, canonicalGatewayRequestFingerprint, ProviderExecutionRepository, testCipher, type GatewayRequest } from "../src/index.js";

const owned: Array<{ workspaceId: string; userId: string }> = [];
const capability = { modelId: "podcast-query-a", families: ["EMBEDDING"] as const, confidence: "VERIFIED" as const, embeddingDimensions: 3, embeddingPurposes: ["QUERY"] as const };
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), snapshotId = randomUUID(), invocationId = randomUUID(), attemptId = randomUUID(), cipher = testCipher();
  owned.push({ workspaceId, userId }); await prisma.workspace.create({ data: { id: workspaceId, name: workspaceId } }); await prisma.user.create({ data: { id: userId, email: `${userId}@test.invalid` } }); await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "OWNER" } });
  const request = { workspaceId, routeSlot: "EMBEDDING" as const, correlationId: "podcast-run", idempotencyKey: "podcast-retrieval-query:podcast-run:PLANNING", inputHash: canonicalEmbeddingInputHash({ texts: ["Q1"], purpose: "QUERY" }), capability: { family: "EMBEDDING" as const }, embedding: { texts: ["Q1"], purpose: "QUERY" as const }, pipelineVersion: "pipeline:podcast-retrieval-v1:identity-a" } satisfies GatewayRequest;
  const snapshot = { id: snapshotId, workspaceId, routeSlot: "EMBEDDING" as const, providerKey: "fixture-a", protocol: "TEST" as const, modelId: capability.modelId, adapterVersion: "test", capability, configuration: {}, configurationHash: "test", correlationId: request.correlationId };
  await prisma.providerExecutionSnapshot.create({ data: snapshot }); const fingerprint = canonicalGatewayRequestFingerprint({ ...snapshot, source: "WORKSPACE", createdAt: new Date() }, request);
  await prisma.providerInvocation.create({ data: { id: invocationId, workspaceId, snapshotId, providerKey: snapshot.providerKey, protocol: snapshot.protocol, modelId: snapshot.modelId, routeSlot: snapshot.routeSlot, idempotencyKey: request.idempotencyKey, requestFingerprint: fingerprint, correlationId: request.correlationId, status: "SUCCEEDED", completedAt: new Date() } }); await prisma.providerInvocationAttempt.create({ data: { id: attemptId, workspaceId, invocationId, attemptNumber: 1, status: "SUCCEEDED", completedAt: new Date() } });
  const encrypted = cipher.encryptEmbeddingResult(JSON.stringify({ vectors: [[1, 0, 0]], dimensions: 3 }), { workspaceId, invocationId, attemptId, snapshotId, providerKey: snapshot.providerKey, modelId: snapshot.modelId }); await prisma.providerEmbeddingResult.create({ data: { workspaceId, invocationId, attemptId, snapshotId, ...encrypted, vectorCount: 1, dimensions: 3 } });
  return { workspaceId, invocationId, snapshotId, request, repository: new ProviderExecutionRepository(prisma, cipher) };
}
afterEach(async () => { for (const item of owned.splice(0)) { await prisma.providerEmbeddingResult.deleteMany({ where: { workspaceId: item.workspaceId } }); await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId: item.workspaceId } }); await prisma.providerInvocation.deleteMany({ where: { workspaceId: item.workspaceId } }); await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId: item.workspaceId } }); await prisma.workspaceMember.deleteMany({ where: { workspaceId: item.workspaceId } }); await prisma.workspace.delete({ where: { id: item.workspaceId } }); await prisma.user.delete({ where: { id: item.userId } }); } });

describe("Phase 8C Checkpoint 4B Podcast query receipt lookup", () => {
  it("uses the original snapshot for exact lookup and rejects changed query semantics", async () => {
    const value = await fixture();
    await expect(value.repository.findExistingEmbeddingInvocationForRequest(value.request)).resolves.toMatchObject({ invocationId: value.invocationId, snapshotId: value.snapshotId, providerKey: "fixture-a", modelId: capability.modelId });
    await expect(value.repository.findExistingEmbeddingInvocationForRequest({ ...value.request, inputHash: canonicalEmbeddingInputHash({ texts: ["Q2"], purpose: "QUERY" }), embedding: { texts: ["Q2"], purpose: "QUERY" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await prisma.providerInvocation.count({ where: { workspaceId: value.workspaceId } })).toBe(1);
  });
});
