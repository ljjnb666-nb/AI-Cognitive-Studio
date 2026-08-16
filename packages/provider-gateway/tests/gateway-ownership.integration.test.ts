import { prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ProviderExecutionRepository, ProviderGatewayError, createExecutionSnapshot } from "../src/index.js";

const workspaces: string[] = [];
async function createSnapshot() { const workspaceId = randomUUID(); workspaces.push(workspaceId); await prisma.workspace.create({ data: { id: workspaceId, name: "ownership" } }); return createExecutionSnapshot({ workspaceId, routeSlot: "BOOK_CHUNK_ANALYSIS", correlationId: "ownership", idempotencyKey: "ownership", inputHash: "a".repeat(64), capability: { family: "TEXT_GENERATION" } }, { source: "PLATFORM", providerKey: "fixture", protocol: "TEST", modelId: "fixture-1", adapterVersion: "test", capability: { modelId: "fixture-1", families: ["TEXT_GENERATION"], confidence: "VERIFIED" }, configuration: {} }); }
afterEach(async () => { for (const id of workspaces.splice(0)) { await prisma.providerUsageEvent.deleteMany({ where: { workspaceId: id } }); await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId: id } }); await prisma.providerInvocation.deleteMany({ where: { workspaceId: id } }); await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId: id } }); await prisma.workspace.delete({ where: { id } }); } }); afterAll(async () => prisma.$disconnect());

describe("gateway ownership mutation authority (PostgreSQL)", () => {
  it("rejects every stale-owner mutation after PostgreSQL expiry", async () => {
    const snapshot = await createSnapshot(); const repository = new ProviderExecutionRepository(); const claim = await repository.claimExecution(snapshot, { idempotencyKey: "ownership", fingerprint: "a".repeat(64) }); if (claim.kind !== "OWNER") throw new Error("owner claim required");
    const attempt = await repository.startAttempt(snapshot.workspaceId, claim.invocationId, claim.claimToken);
    await prisma.$executeRaw`UPDATE "ProviderInvocation" SET "claimExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 millisecond' WHERE "id" = ${claim.invocationId}`;
    await expect(repository.renewClaim(snapshot.workspaceId, claim.invocationId, claim.claimToken)).rejects.toBeInstanceOf(ProviderGatewayError);
    await expect(repository.startAttempt(snapshot.workspaceId, claim.invocationId, claim.claimToken)).rejects.toBeInstanceOf(ProviderGatewayError);
    await expect(repository.completeAttempt(snapshot.workspaceId, claim.invocationId, claim.claimToken, attempt.id, "SUCCEEDED", { latencyMs: 1 })).rejects.toBeInstanceOf(ProviderGatewayError);
    await expect(repository.completeInvocation(snapshot.workspaceId, claim.invocationId, claim.claimToken, "SUCCEEDED")).rejects.toBeInstanceOf(ProviderGatewayError);
  });

  it("redacts an exact credential value before usage metadata is persisted", async () => {
    const snapshot = await createSnapshot(); const repository = new ProviderExecutionRepository(); const claim = await repository.claimExecution(snapshot, { idempotencyKey: "redaction", fingerprint: "b".repeat(64) }); if (claim.kind !== "OWNER") throw new Error("owner claim required");
    const attempt = await repository.startAttempt(snapshot.workspaceId, claim.invocationId, claim.claimToken); const secret = "exact-secret-credential-123456";
    await repository.recordAttemptOutcome(snapshot.workspaceId, claim.invocationId, claim.claimToken, attempt.id, "SUCCEEDED", { latencyMs: 1 }, { snapshot, attempt, status: "SUCCEEDED", usage: { extra: { nested: { echoed: `Bearer ${secret}` } } }, exactSecret: secret });
    const usage = await prisma.providerUsageEvent.findFirstOrThrow({ where: { workspaceId: snapshot.workspaceId } }); expect(JSON.stringify(usage.metadata)).not.toContain(secret);
  });
});
