import { prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DeterministicProviderHttpTransport, OpenAICompatibleAdapter, ProviderExecutionRepository, ProviderGatewayError, ProviderGatewayRepository, ProviderRegistry, WorkspaceMembershipExecutionAuthorizer, createProductionProviderGateway, testCipher } from "../src/index.js";
import type { GatewayRequest, ProviderHttpRequest } from "../src/index.js";

const workspaces: string[] = [];
const users: string[] = [];
const capability = { modelId: "phase8b-model", families: ["TEXT_GENERATION"] as const, confidence: "VERIFIED" as const, structuredOutput: "PROMPT_ONLY" as const };
const secret = "phase8b-runtime-credential-8e8c4";
const sentinels = { system: "phase8b-system-sentinel", user: "phase8b-user-sentinel", content: "phase8b-provider-content-sentinel" };

async function fixture(responder: (request: ProviderHttpRequest) => Promise<{ status: number; headers: Record<string, string>; body: string }> | { status: number; headers: Record<string, string>; body: string }, maxAttempts = 2) {
  const workspaceId = randomUUID(); const userId = randomUUID(); workspaces.push(workspaceId); users.push(userId);
  await prisma.workspace.create({ data: { id: workspaceId, name: `phase8b-${workspaceId}` } });
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.invalid` } });
  await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "OWNER" } });
  const cipher = testCipher(); const store = new ProviderGatewayRepository(prisma, cipher);
  const connection = await store.createConnection({ workspaceId, userId }, { providerKey: "deepseek", protocol: "OPENAI_COMPATIBLE", displayName: "Phase 8B transport" });
  await store.rotateCredential({ workspaceId, userId }, connection.id, secret);
  await store.setRoute({ workspaceId, userId }, { routeSlot: "BOOK_CHUNK_ANALYSIS", connectionId: connection.id, modelId: capability.modelId });
  const registry = new ProviderRegistry(); registry.register({ providerKey: "deepseek", displayName: "DeepSeek", protocol: "OPENAI_COMPATIBLE", adapterVersion: "phase8b", models: [capability] });
  const transport = new DeterministicProviderHttpTransport(responder);
  const repository = new ProviderExecutionRepository(prisma, cipher);
  const makeGateway = (adapterAvailable = true) => createProductionProviderGateway(registry, { resolveWorkspaceRoute: request => store.resolveWorkspaceRoute(request) }, { resolve: async () => undefined }, () => adapterAvailable ? new OpenAICompatibleAdapter(transport) : undefined, { authorize: (principal, request) => new WorkspaceMembershipExecutionAuthorizer(prisma).authorizeExecution(principal, request.workspaceId), assertRouteUsable: async () => undefined, validateEndpoint: async () => undefined, assertBudget: () => undefined, repository, circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async key => ({ key, token: "lease" }), release: async () => true }, maxAttempts, sleep: async () => undefined, random: () => 0 });
  const gateway = makeGateway();
  const request = (idempotencyKey: string, signal?: AbortSignal): GatewayRequest => ({ workspaceId, routeSlot: "BOOK_CHUNK_ANALYSIS", correlationId: idempotencyKey, idempotencyKey, inputHash: "a".repeat(64), capability: { family: "TEXT_GENERATION" }, signal, text: { system: sentinels.system, messages: [{ role: "user", content: sentinels.user }] } });
  return { workspaceId, userId, gateway, makeGateway, transport, request };
}

async function durableJson(workspaceId: string): Promise<string> {
  const [snapshots, invocations, attempts, usage, audit] = await Promise.all([prisma.providerExecutionSnapshot.findMany({ where: { workspaceId } }), prisma.providerInvocation.findMany({ where: { workspaceId } }), prisma.providerInvocationAttempt.findMany({ where: { workspaceId } }), prisma.providerUsageEvent.findMany({ where: { workspaceId } }), prisma.providerAuditEvent.findMany({ where: { workspaceId } })]);
  return JSON.stringify({ snapshots, invocations, attempts, usage, audit });
}

afterEach(async () => {
  for (const workspaceId of workspaces.splice(0)) {
    await prisma.providerUsageEvent.deleteMany({ where: { workspaceId } }); await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId } }); await prisma.providerInvocation.deleteMany({ where: { workspaceId } }); await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId } }); await prisma.providerRouteBinding.deleteMany({ where: { workspaceId } }); await prisma.providerCredentialVersion.deleteMany({ where: { workspaceId } }); await prisma.providerConnection.deleteMany({ where: { workspaceId } }); await prisma.providerAuditEvent.deleteMany({ where: { workspaceId } }); await prisma.workspaceMember.deleteMany({ where: { workspaceId } }); await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  for (const userId of users.splice(0)) await prisma.user.delete({ where: { id: userId } });
});
afterAll(async () => prisma.$disconnect());

describe("Phase 8B durable text adapter acceptance", () => {
  it("releases a text pre-remote claim when the pinned adapter is unavailable and reclaims it after restoration", async () => {
    const value = await fixture(() => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: "restored" } }] }) }), 1); await expect(value.makeGateway(false).execute(value.request("adapter-missing-text"), { userId: value.userId })).rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE" }); const pending = await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: value.workspaceId } });
    expect(value.transport.calls).toHaveLength(0); expect(await prisma.providerInvocationAttempt.count({ where: { workspaceId: value.workspaceId } })).toBe(0); expect(await prisma.providerEmbeddingResult.count({ where: { workspaceId: value.workspaceId } })).toBe(0); expect(pending).toMatchObject({ status: "PENDING", claimToken: null, claimOwner: null, claimExpiresAt: null });
    await expect(value.makeGateway().execute(value.request("adapter-missing-text"), { userId: value.userId })).resolves.toMatchObject({ status: "SUCCEEDED" }); expect(value.transport.calls).toHaveLength(1); expect(await prisma.providerEmbeddingResult.count({ where: { workspaceId: value.workspaceId } })).toBe(0); expect(await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: value.workspaceId } })).toMatchObject({ status: "SUCCEEDED", snapshotId: pending.snapshotId }); expect(await prisma.providerExecutionSnapshot.count({ where: { workspaceId: value.workspaceId } })).toBe(1);
  });

  it("decrypts the real credential only for adapter auth and redacts a hostile remote secret echo from all durable rows", async () => {
    const remote = async () => ({ status: 500, headers: { "x-request-id": "phase8b-remote" }, body: JSON.stringify({ error: { message: secret, metadata: { nested: secret } }, arbitrary: { providerContent: sentinels.content, credential: secret } }) });
    const value = await fixture(remote);
    const error = await value.gateway.execute(value.request("secret-echo"), { userId: value.userId }).catch(error => error);
    expect(error).toMatchObject({ code: "TRANSIENT_UPSTREAM", message: "Provider execution failed" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(value.transport.calls).toHaveLength(2);
    expect(value.transport.calls[0]?.headers.authorization).toBe(`Bearer ${secret}`);
    const persisted = await durableJson(value.workspaceId);
    for (const forbidden of [secret, sentinels.system, sentinels.user, sentinels.content]) expect(persisted).not.toContain(forbidden);
  });

  it("has no adapter retry layer and makes Gateway the only retry owner", async () => {
    const direct = new DeterministicProviderHttpTransport(() => ({ status: 429, headers: {}, body: JSON.stringify({ error: { type: "rate_limit_error" } }) }));
    const directAdapter = new OpenAICompatibleAdapter(direct);
    await expect(directAdapter.execute({ snapshot: { id: "direct", workspaceId: "direct", routeSlot: "BOOK_CHUNK_ANALYSIS", correlationId: "direct", source: "PLATFORM", providerKey: "deepseek", protocol: "OPENAI_COMPATIBLE", modelId: capability.modelId, adapterVersion: "phase8b", capability, configuration: {}, configurationHash: "direct", createdAt: new Date() }, request: { workspaceId: "direct", routeSlot: "BOOK_CHUNK_ANALYSIS", correlationId: "direct", idempotencyKey: "direct", inputHash: "a".repeat(64), capability: { family: "TEXT_GENERATION" }, requestFingerprint: "direct", text: { messages: [{ role: "user", content: "direct" }] } }, signal: new AbortController().signal, credential: secret })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(direct.calls).toHaveLength(1);
    const value = await fixture(() => ({ status: 429, headers: {}, body: JSON.stringify({ error: { type: "rate_limit_error" } }) }));
    await expect(value.gateway.execute(value.request("retryable"), { userId: value.userId })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(value.transport.calls).toHaveLength(2);
    for (const [status, code] of [[401, "AUTHENTICATION_FAILED"], [403, "AUTHORIZATION_FAILED"], [429, "QUOTA_EXCEEDED"], [200, "INVALID_PROVIDER_RESPONSE"]] as const) {
      const single = await fixture(() => status === 200 ? ({ status, headers: {}, body: JSON.stringify({ choices: [{ message: { content: 4 } }] }) }) : ({ status, headers: {}, body: JSON.stringify({ error: status === 429 ? { type: "insufficient_quota" } : {} }) }));
      await expect(single.gateway.execute(single.request(`single-${status}`), { userId: single.userId })).rejects.toMatchObject({ code });
      expect(single.transport.calls).toHaveLength(1);
    }
  });

  it("cancels an in-flight remote call without retrying and preserves durable cancellation semantics", async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const value = await fixture(request => new Promise((_, reject) => { entered(); request.signal.addEventListener("abort", () => reject(new ProviderGatewayError("CANCELLED")), { once: true }); }));
    const controller = new AbortController(); const execution = value.gateway.execute(value.request("in-flight-cancel", controller.signal), { userId: value.userId });
    await started; controller.abort();
    await expect(execution).rejects.toMatchObject({ code: "CANCELLED" });
    expect(value.transport.calls).toHaveLength(1);
    const invocation = await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: value.workspaceId } });
    const attempt = await prisma.providerInvocationAttempt.findFirstOrThrow({ where: { workspaceId: value.workspaceId } });
    expect(invocation.status).toBe("BLOCKED"); expect(attempt.status).toBe("CANCELLED_AFTER_REQUEST");
  });

  it("uses an injected platform credential for an approved regional Qwen route without creating BYOK rows", async () => {
    const workspaceId = randomUUID(); const userId = randomUUID(); const platformSecret = "phase8b-platform-secret-74af"; workspaces.push(workspaceId); users.push(userId);
    await prisma.workspace.create({ data: { id: workspaceId, name: `platform-${workspaceId}` } }); await prisma.user.create({ data: { id: userId, email: `${userId}@test.invalid` } }); await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "OWNER" } });
    const transport = new DeterministicProviderHttpTransport(() => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: "platform response" }, finish_reason: "stop" }] }) })); const registry = new ProviderRegistry(); const qwenCapability = { modelId: "qwen-plus-us", families: ["TEXT_GENERATION"] as const, confidence: "VERIFIED" as const, structuredOutput: "PROMPT_ONLY" as const }; registry.register({ providerKey: "qwen", displayName: "Qwen", protocol: "OPENAI_COMPATIBLE", adapterVersion: "phase8b", models: [qwenCapability] });
    const gateway = createProductionProviderGateway(registry, { resolveWorkspaceRoute: async () => undefined }, { resolve: async () => ({ source: "PLATFORM" as const, providerKey: "qwen", protocol: "OPENAI_COMPATIBLE" as const, modelId: qwenCapability.modelId, adapterVersion: "phase8b", capability: qwenCapability, configuration: { qwenRegion: "US_VIRGINIA" } }) }, () => new OpenAICompatibleAdapter(transport), { authorize: (principal, request) => new WorkspaceMembershipExecutionAuthorizer(prisma).authorizeExecution(principal, request.workspaceId), assertRouteUsable: async () => undefined, validateEndpoint: async () => undefined, assertBudget: () => undefined, repository: new ProviderExecutionRepository(prisma, testCipher()), platformCredentials: { resolve: async () => platformSecret }, circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async key => ({ key, token: "lease" }), release: async () => true } });
    await expect(gateway.execute({ workspaceId, routeSlot: "BOOK_CHUNK_ANALYSIS", correlationId: "platform-qwen", idempotencyKey: "platform-qwen", inputHash: "a".repeat(64), capability: { family: "TEXT_GENERATION" }, text: { messages: [{ role: "user", content: "platform" }] } }, { userId })).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(transport.calls[0]?.url).toBe("https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions"); expect(transport.calls[0]?.headers.authorization).toBe(`Bearer ${platformSecret}`); expect(await prisma.providerCredentialVersion.count({ where: { workspaceId } })).toBe(0); expect(await durableJson(workspaceId)).not.toContain(platformSecret);
  });
});
