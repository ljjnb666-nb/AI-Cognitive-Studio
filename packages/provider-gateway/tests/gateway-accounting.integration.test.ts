import { prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createProductionProviderGateway, DeterministicFakeProviderAdapter, ProviderExecutionRepository, ProviderRegistry } from "../src/index.js";

const workspaces: string[] = [];
async function workspace() { const id = randomUUID(); workspaces.push(id); return prisma.workspace.create({ data: { id, name: "accounting" } }); }
afterEach(async () => { vi.restoreAllMocks(); for (const id of workspaces.splice(0)) { await prisma.providerUsageEvent.deleteMany({ where: { workspaceId: id } }); await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId: id } }); await prisma.providerInvocation.deleteMany({ where: { workspaceId: id } }); await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId: id } }); await prisma.workspace.delete({ where: { id } }); } }); afterAll(async () => prisma.$disconnect());

describe("gateway post-remote accounting safety", () => {
  it.each(["attempt outcome", "logical invocation"])("never replays a remote success when %s persistence fails", async fault => {
    const ws = await workspace(); const registry = new ProviderRegistry(); const capability = { modelId: "fixture-1", families: ["TEXT_GENERATION"] as const, confidence: "VERIFIED" as const }; registry.register({ providerKey: "fixture", displayName: "Fixture", protocol: "TEST", adapterVersion: "test", models: [capability] }); const adapter = new DeterministicFakeProviderAdapter(); const repository = new ProviderExecutionRepository();
    vi.spyOn(repository, fault === "attempt outcome" ? "recordAttemptOutcome" : "completeInvocation").mockRejectedValueOnce(new Error(`${fault} persistence fault`));
    const gateway = createProductionProviderGateway(registry, { resolveWorkspaceRoute: async () => undefined }, { resolve: async () => ({ source: "PLATFORM" as const, providerKey: "fixture", protocol: "TEST" as const, modelId: "fixture-1", adapterVersion: "test", capability, configuration: {} }) }, () => adapter, { authorize: async () => undefined, assertRouteUsable: async () => undefined, validateEndpoint: async () => undefined, assertBudget: () => undefined, repository, circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async key => ({ key, token: "lease" }), release: async () => true } });
    const request = { workspaceId: ws.id, routeSlot: "BOOK_CHUNK_ANALYSIS" as const, correlationId: fault, idempotencyKey: fault, inputHash: "a".repeat(64), capability: { family: "TEXT_GENERATION" as const } };
    await expect(gateway.execute(request, { userId: "owner" })).rejects.toMatchObject({ code: "INTERNAL_PROVIDER_ERROR" }); await gateway.execute(request, { userId: "owner" }).catch(() => undefined); expect(adapter.calls).toBe(1);
  });
});
