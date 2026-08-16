import { prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createProductionProviderGateway, DeterministicFakeProviderAdapter, ProviderExecutionRepository, ProviderRegistry, WorkspaceMembershipExecutionAuthorizer } from "../src/index.js";

const workspaceIds: string[] = [];
const userIds: string[] = [];
async function fixture() {
  const workspaceId = randomUUID(); workspaceIds.push(workspaceId);
  await prisma.workspace.create({ data: { id: workspaceId, name: `auth-${workspaceId}` } });
  const users = await Promise.all(["OWNER", "EDITOR", "VIEWER"].map(async role => { const id = randomUUID(); userIds.push(id); await prisma.user.create({ data: { id, email: `${id}@test.invalid` } }); await prisma.workspaceMember.create({ data: { workspaceId, userId: id, role: role as "OWNER" | "EDITOR" | "VIEWER" } }); return { id, role }; }));
  return { workspaceId, users };
}
afterEach(async () => { for (const id of workspaceIds.splice(0)) await prisma.workspace.delete({ where: { id } }); for (const id of userIds.splice(0)) await prisma.user.delete({ where: { id } }); });
afterAll(async () => prisma.$disconnect());

describe("gateway execution authorization (PostgreSQL memberships)", () => {
  it("permits OWNER and EDITOR while every denied principal creates neither attempt nor adapter call", async () => {
    const { workspaceId, users } = await fixture();
    const registry = new ProviderRegistry(); const capability = { modelId: "fixture-1", families: ["TEXT_GENERATION"] as const, confidence: "VERIFIED" as const };
    registry.register({ providerKey: "fixture", displayName: "Fixture", protocol: "TEST", adapterVersion: "test", models: [capability] });
    const adapter = new DeterministicFakeProviderAdapter(); const authorizer = new WorkspaceMembershipExecutionAuthorizer(prisma);
    const gateway = createProductionProviderGateway(registry, { resolveWorkspaceRoute: async () => undefined }, { resolve: async () => ({ source: "PLATFORM" as const, providerKey: "fixture", protocol: "TEST" as const, modelId: "fixture-1", adapterVersion: "test", capability, configuration: {} }) }, () => adapter, { authorize: (principal, request) => authorizer.authorizeExecution(principal, request.workspaceId), assertRouteUsable: async () => undefined, validateEndpoint: async () => undefined, assertBudget: () => undefined, repository: new ProviderExecutionRepository(), circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async key => ({ key, token: "lease" }), release: async () => true } });
    let hashSeed = 0; const request = (key: string) => ({ workspaceId, routeSlot: "BOOK_CHUNK_ANALYSIS" as const, correlationId: key, idempotencyKey: key, inputHash: (++hashSeed).toString(16).padStart(64, "0"), capability: { family: "TEXT_GENERATION" as const } });
    for (const user of users.filter(user => user.role !== "VIEWER")) await expect(gateway.execute(request(`allow-${user.role}`), { userId: user.id })).resolves.toMatchObject({ status: "SUCCEEDED" });
    const beforeCalls = adapter.calls; const beforeAttempts = await prisma.providerInvocationAttempt.count({ where: { workspaceId } });
    await expect(gateway.execute(request("viewer"), { userId: users.find(user => user.role === "VIEWER")!.id })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    const outsider = randomUUID(); userIds.push(outsider); await prisma.user.create({ data: { id: outsider, email: `${outsider}@test.invalid` } });
    await expect(gateway.execute(request("outsider"), { userId: outsider })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    const otherWorkspaceId = randomUUID(); workspaceIds.push(otherWorkspaceId); await prisma.workspace.create({ data: { id: otherWorkspaceId, name: `auth-${otherWorkspaceId}` } });
    await expect(gateway.execute({ ...request("cross-workspace"), workspaceId: otherWorkspaceId }, { userId: users.find(user => user.role === "OWNER")!.id })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(adapter.calls).toBe(beforeCalls); expect(await prisma.providerInvocationAttempt.count({ where: { workspaceId } })).toBe(beforeAttempts);
  });
});
