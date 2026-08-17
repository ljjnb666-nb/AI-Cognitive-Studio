import { prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicProviderHttpTransport, OpenAIEmbeddingAdapter, ProviderExecutionRepository, ProviderGatewayRepository, ProviderRegistry, WorkspaceMembershipExecutionAuthorizer, createProductionProviderGateway, testCipher, type GatewayRequest } from "../src/index.js";

const created: Array<{ workspaceId: string; userId: string }> = [];
const capability = { modelId: "handoff-embedding", families: ["EMBEDDING"] as const, confidence: "VERIFIED" as const, embeddingDimensions: 3, maxEmbeddingInputs: 2, embeddingPurposes: ["DOCUMENT", "QUERY"] as const };
const vectors = [[1, 0, 0], [0, 1, 0]];
function request(workspaceId: string, idempotencyKey = "handoff") { return { workspaceId, routeSlot: "EMBEDDING" as const, correlationId: idempotencyKey, idempotencyKey, inputHash: "b".repeat(64), capability: { family: "EMBEDDING" as const }, embedding: { texts: ["HANDOFF-RUNTIME-MARKER", "two"], purpose: "DOCUMENT" as const } satisfies GatewayRequest["embedding"] }; }
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), cipher = testCipher(), store = new ProviderGatewayRepository(prisma, cipher), transport = new DeterministicProviderHttpTransport(() => ({ status: 200, headers: {}, body: JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })), usage: { prompt_tokens: 7 } }) }));
  created.push({ workspaceId, userId }); await prisma.workspace.create({ data: { id: workspaceId, name: workspaceId } }); await prisma.user.create({ data: { id: userId, email: `${userId}@test.invalid` } }); await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "OWNER" } });
  const connection = await store.createConnection({ workspaceId, userId }, { providerKey: "openai", protocol: "OPENAI_EMBEDDINGS", displayName: "handoff" }); await store.rotateCredential({ workspaceId, userId }, connection.id, "HANDOFF-CREDENTIAL-MARKER"); await store.setRoute({ workspaceId, userId }, { routeSlot: "EMBEDDING", connectionId: connection.id, modelId: capability.modelId });
  const registry = new ProviderRegistry(); registry.register({ providerKey: "openai", displayName: "openai", protocol: "OPENAI_EMBEDDINGS", adapterVersion: "phase8c", models: [capability] });
  const make = (withoutVault = false) => createProductionProviderGateway(registry, { resolveWorkspaceRoute: value => store.resolveWorkspaceRoute(value) }, { resolve: async () => undefined }, () => new OpenAIEmbeddingAdapter(transport), { authorize: (principal, value) => new WorkspaceMembershipExecutionAuthorizer(prisma).authorizeExecution(principal, value.workspaceId), assertRouteUsable: async () => undefined, validateEndpoint: async () => undefined, assertBudget: () => undefined, repository: new ProviderExecutionRepository(prisma, withoutVault ? undefined : cipher), circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async key => ({ key, token: "lease" }), release: async () => true }, maxAttempts: 1 });
  return { workspaceId, userId, transport, gateway: make, cipher };
}
afterEach(async () => { for (const { workspaceId, userId } of created.splice(0)) { await prisma.providerUsageEvent.deleteMany({ where: { workspaceId } }); await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId } }); await prisma.providerInvocation.deleteMany({ where: { workspaceId } }); await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId } }); await prisma.providerRouteBinding.deleteMany({ where: { workspaceId } }); await prisma.providerCredentialVersion.deleteMany({ where: { workspaceId } }); await prisma.providerConnection.deleteMany({ where: { workspaceId } }); await prisma.workspaceMember.deleteMany({ where: { workspaceId } }); await prisma.workspace.delete({ where: { id: workspaceId } }); await prisma.user.delete({ where: { id: userId } }); } });

describe("Phase 8C durable embedding handoff", () => {
  it("atomically persists an encrypted result and replays it after a new Gateway instance without HTTP", async () => {
    const value = await fixture(), first = await value.gateway().execute(request(value.workspaceId), { userId: value.userId });
    expect(first).toMatchObject({ status: "SUCCEEDED", response: { vectors, dimensions: 3 } }); expect(value.transport.calls).toHaveLength(1);
    const row = await prisma.providerEmbeddingResult.findFirstOrThrow({ where: { workspaceId: value.workspaceId } }); expect(row.vectorCount).toBe(2); expect(row.dimensions).toBe(3); expect(JSON.stringify(row)).not.toContain("HANDOFF-RUNTIME-MARKER"); expect(JSON.stringify(row)).not.toContain("[1,0,0]");
    const replay = await value.gateway().execute(request(value.workspaceId), { userId: value.userId }); expect(replay).toMatchObject({ status: "ALREADY_PROCESSED", response: { vectors, dimensions: 3 } }); expect(value.transport.calls).toHaveLength(1);
    expect(await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: value.workspaceId } })).toMatchObject({ status: "SUCCEEDED", claimToken: null }); expect(await prisma.providerInvocationAttempt.findFirstOrThrow({ where: { workspaceId: value.workspaceId } })).toMatchObject({ status: "SUCCEEDED" }); expect(await prisma.providerUsageEvent.count({ where: { workspaceId: value.workspaceId } })).toBe(1);
  });
  it("fails closed on tampering or a legacy successful invocation missing its receipt without recalling the provider", async () => {
    const value = await fixture(); await value.gateway().execute(request(value.workspaceId), { userId: value.userId }); const row = await prisma.providerEmbeddingResult.findFirstOrThrow({ where: { workspaceId: value.workspaceId } }); await prisma.providerEmbeddingResult.update({ where: { id: row.id }, data: { authTag: "AAAA" } });
    await expect(value.gateway().execute(request(value.workspaceId), { userId: value.userId })).resolves.toMatchObject({ status: "RECONCILIATION_REQUIRED" }); expect(value.transport.calls).toHaveLength(1);
    await prisma.providerEmbeddingResult.delete({ where: { id: row.id } }); await expect(value.gateway().execute(request(value.workspaceId), { userId: value.userId })).resolves.toMatchObject({ status: "RECONCILIATION_REQUIRED" }); expect(value.transport.calls).toHaveLength(1);
  });
  it("releases a zero-call vault-preflight claim so the same idempotency key succeeds after configuration is restored", async () => {
    const value = await fixture(); await expect(value.gateway(true).execute(request(value.workspaceId, "vault-retry"), { userId: value.userId })).rejects.toMatchObject({ code: "INTERNAL_PROVIDER_ERROR" });
    expect(value.transport.calls).toHaveLength(0); expect(await prisma.providerInvocationAttempt.count({ where: { workspaceId: value.workspaceId } })).toBe(0); expect(await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: value.workspaceId } })).toMatchObject({ status: "PENDING", claimToken: null, claimOwner: null, claimExpiresAt: null });
    await expect(value.gateway().execute(request(value.workspaceId, "vault-retry"), { userId: value.userId })).resolves.toMatchObject({ status: "SUCCEEDED" }); expect(value.transport.calls).toHaveLength(1); expect(await prisma.providerEmbeddingResult.count({ where: { workspaceId: value.workspaceId } })).toBe(1);
  });
});
