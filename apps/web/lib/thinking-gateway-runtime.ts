import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { FetchProviderHttpTransport, ProviderExecutionRepository, ProviderGatewayRepository, ProviderRegistry, RedisCircuitBreaker, RedisConcurrencyLimiter, RedisRateLimiter, WorkspaceMembershipExecutionAuthorizer, createProductionProviderGateway, createProviderAdapterResolver, resolveCredentialKeyring, resolveProviderCatalog, validateProviderEndpoint, type ProviderGateway } from "@ai-cognitive/provider-gateway";
import { createRedisConnection } from "@ai-cognitive/shared/server";

type ThinkingGatewayRuntime = ReturnType<typeof assembleThinkingGatewayRuntime>;
let cachedRuntime: ThinkingGatewayRuntime | undefined;

/** Canonical workspace-BYOK Gateway composition for request-scoped thinking turns. */
function assembleThinkingGatewayRuntime(environment: NodeJS.ProcessEnv) {
  const cipher = resolveCredentialKeyring(environment); if (!cipher) throw new Error("PROVIDER_GATEWAY_KEYRING_MISSING");
  const manifest = resolveProviderCatalog(environment.PROVIDER_GATEWAY_MODEL_MANIFEST), registry = new ProviderRegistry(); for (const provider of manifest.providers) registry.register(provider);
  const store = new ProviderGatewayRepository(prisma, cipher), repository = new ProviderExecutionRepository(prisma, cipher), authorizer = new WorkspaceMembershipExecutionAuthorizer(prisma), redis = createRedisConnection(environment.REDIS_URL ?? "");
  const browserFixture = environment.NODE_ENV === "test" && environment.THINKING_SESSION_TEST_GATEWAY === "true";
  const adapters = browserFixture
    ? () => ({ execute: async (request: { request: { routeSlot: string } }) => ({ response: request.request.routeSlot === "TEACH_BACK_ASSESSMENT" ? { type: "STRUCTURED" as const, structured: { criteria: [{ key: "CORE_MEANING", status: "MET", rationale: "说明了核心含义", evidenceRefs: [] }, { key: "COVERAGE", status: "MET", rationale: "覆盖了关键关系", evidenceRefs: [] }, { key: "NO_OVERCLAIM", status: "MET", rationale: "没有越过可用信息", evidenceRefs: [] }], feedback: "复述准确说明了核心意思和关键关系。", nextPrompt: null } } : { type: "TEXT" as const, text: "你愿意用哪一条证据来检验这个判断？" }, usage: { inputTokens: 1, outputTokens: 1 } }) })
    : createProviderAdapterResolver(new FetchProviderHttpTransport());
  const productionGateway = createProductionProviderGateway(registry, { resolveWorkspaceRoute: request => store.resolveWorkspaceRoute(request) }, { resolve: async () => undefined }, adapters, { authorize: (principal, request) => authorizer.authorizeExecution(principal, request.workspaceId), assertRouteUsable: snapshot => store.assertResolvedRouteUsable(snapshot.workspaceId, snapshot.connectionId, snapshot.credentialVersionId), assertBudget: () => undefined, validateEndpoint: async snapshot => { if (!snapshot.endpoint) throw new Error("ROUTE_UNAVAILABLE"); await validateProviderEndpoint(snapshot.endpoint, { environment: environment.NODE_ENV ?? "production", dns: { lookup: async hostname => (await import("node:dns/promises")).resolve4(hostname) } }); }, repository, rate: new RedisRateLimiter(redis), concurrency: new RedisConcurrencyLimiter(redis), circuit: new RedisCircuitBreaker(redis) });
  let pendingTeachBack = browserFixture && environment.TEACH_BACK_TEST_GATEWAY === "PENDING_THEN_SUCCESS";
  const gateway: ProviderGateway = pendingTeachBack ? {
    resolveSnapshot: request => productionGateway.resolveSnapshot(request),
    execute: async (request, principal) => {
      if (request.routeSlot === "TEACH_BACK_ASSESSMENT" && pendingTeachBack) { pendingTeachBack = false; return { status: "IN_PROGRESS" as const, invocationId: randomUUID() }; }
      return productionGateway.execute(request, principal);
    },
  } : productionGateway;
  return { gateway, repository };
}

export function createThinkingGatewayRuntime(environment: NodeJS.ProcessEnv): ThinkingGatewayRuntime {
  if (!cachedRuntime) cachedRuntime = assembleThinkingGatewayRuntime(environment);
  return cachedRuntime;
}
