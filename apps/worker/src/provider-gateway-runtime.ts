import { prisma } from "@ai-cognitive/db";
import { type AnalysisProvider, type AnalysisRequest, type AnalysisReceiptConsumer, type AnalysisTransaction, validateAnalysisResponse } from "@ai-cognitive/book-intelligence";
import { FetchProviderHttpTransport, ProviderExecutionRepository, ProviderGatewayRepository, ProviderRegistry, RedisCircuitBreaker, RedisConcurrencyLimiter, RedisRateLimiter, WorkspaceMembershipExecutionAuthorizer, createProductionProviderGateway, createProviderAdapterResolver, parseKeyring, validateProviderEndpoint, type GatewayExecutionDependencies, type GatewayRequest, type ModelCapability, type ProviderAdapterResolver, type ProviderDefinition, type ProviderGateway } from "@ai-cognitive/provider-gateway";
import { createRedisConnection } from "@ai-cognitive/shared/server";
import { sha256 } from "@ai-cognitive/book-intelligence";

type Manifest = { providers: ProviderDefinition[] };
type BookGatewayRuntime = { gateway: ProviderGateway; repository: ProviderExecutionRepository; createAnalysisProvider(input: { workspaceId: string; userId: string; analysisRunId: string; provider: string; model: string }): Promise<AnalysisProvider>; };
/** Test-only seams keep production composition real while preventing external provider traffic. */
export type BookProductionGatewayRuntimeOverrides = Pick<GatewayExecutionDependencies, "circuit" | "rate" | "concurrency" | "validateEndpoint"> & { adapterResolver?: ProviderAdapterResolver };

function parseManifest(source: string | undefined): Manifest {
  if (!source) throw new Error("PROVIDER_GATEWAY_MODEL_MANIFEST_MISSING");
  let raw: unknown; try { raw = JSON.parse(source); } catch { throw new Error("PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID"); }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Manifest).providers)) throw new Error("PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID");
  const providers = (raw as Manifest).providers;
  for (const p of providers) if (!p || !p.providerKey || !p.protocol || !p.adapterVersion || !Array.isArray(p.models) || !p.models.every((m: ModelCapability) => m && m.modelId && Array.isArray(m.families) && m.families.length)) throw new Error("PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID");
  return { providers };
}
const schema = { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" }, memory: { type: "array", items: { type: "object" } }, relations: { type: "array", items: { type: "object" } } } };
function slot(stage: AnalysisRequest["stage"]): GatewayRequest["routeSlot"] { return stage === "CHUNK" ? "BOOK_CHUNK_ANALYSIS" : stage === "BOOK" ? "BOOK_SYNTHESIS" : "BOOK_REDUCTION_ANALYSIS"; }

class GatewayAnalysisProvider implements AnalysisProvider {
  private readonly receipts = new WeakMap<object, { invocationId: string; snapshotId: string }>();
  constructor(private readonly runtime: BookGatewayRuntime, private readonly input: { workspaceId: string; userId: string; analysisRunId: string; provider: string; model: string }) {}
  async generateStructured(request: AnalysisRequest) {
    const routeSlot = slot(request.stage), operation = (request as AnalysisRequest & { operationKey?: string }).operationKey ?? sha256(JSON.stringify([request.stage, request.content, request.sourceBlockIds]));
    const text = { system: request.systemInstructions, messages: [{ role: "user" as const, content: request.content }], structuredOutput: { mode: "STRICT_JSON_SCHEMA" as const, schemaName: "book_analysis_response", schema } };
    const inputHash = sha256(JSON.stringify([this.input.workspaceId, routeSlot, this.input.analysisRunId, request.stage, operation, sha256(request.content), request.pipelineVersion, request.promptVersion, schema]));
    const outcome = await this.runtime.gateway.execute({ workspaceId: this.input.workspaceId, routeSlot, correlationId: request.correlationId, idempotencyKey: `book-analysis-text:${this.input.analysisRunId}:${request.stage}:${operation}`, inputHash, capability: { family: "TEXT_GENERATION", structuredOutput: "STRICT_JSON_SCHEMA" }, text, pipelineVersion: request.pipelineVersion, promptVersion: request.promptVersion, schemaVersion: "book-analysis-v1" }, { userId: this.input.userId });
    if (outcome.status !== "SUCCEEDED" && outcome.status !== "ALREADY_PROCESSED") throw new Error(`BOOK_ANALYSIS_TEXT_GATEWAY_${outcome.status}`);
    const response = outcome.response as { type?: string; structured?: unknown } | undefined;
    if (!response || response.type !== "STRUCTURED" || !outcome.invocationId || !(outcome.status === "SUCCEEDED" ? outcome.snapshot : outcome.snapshot)) throw new Error("BOOK_ANALYSIS_TEXT_RECONCILIATION_REQUIRED");
    const analysis = validateAnalysisResponse(response.structured), snapshotId = outcome.snapshot!.id;
    this.receipts.set(analysis, { invocationId: outcome.invocationId, snapshotId });
    return analysis;
  }
  async consumeGenerated(response: Awaited<ReturnType<AnalysisProvider["generateStructured"]>>, consumer: AnalysisReceiptConsumer): Promise<"CONSUMED" | "ALREADY_CONSUMED"> {
    const receipt = this.receipts.get(response as object); if (!receipt) throw new Error("BOOK_ANALYSIS_TEXT_RECONCILIATION_REQUIRED");
    const result = await this.runtime.repository.consumeTextResult({ workspaceId: this.input.workspaceId, invocationId: receipt.invocationId, snapshotId: receipt.snapshotId, consumerKind: consumer.consumerKind, consumerKey: consumer.consumerKey, consumerFingerprint: consumer.consumerFingerprint }, async ({ tx, response: raw }) => {
      if (raw.type !== "STRUCTURED") throw new Error("BOOK_ANALYSIS_TEXT_RECONCILIATION_REQUIRED");
      await consumer.materialize(tx as unknown as AnalysisTransaction, validateAnalysisResponse(raw.structured));
    });
    return result.status;
  }
}

/** PHASE8C_CHECKPOINT3B_BOOK_PRODUCTION_GATEWAY: workspace BYOK only; no platform resolver. */
export function createBookProductionGatewayRuntime(source: NodeJS.ProcessEnv, overrides: BookProductionGatewayRuntimeOverrides = {}): BookGatewayRuntime {
  const cipher = parseKeyring(source.PROVIDER_GATEWAY_KEYRING); if (!cipher) throw new Error("PROVIDER_GATEWAY_KEYRING_MISSING");
  const manifest = parseManifest(source.PROVIDER_GATEWAY_MODEL_MANIFEST), registry = new ProviderRegistry(); for (const provider of manifest.providers) registry.register(provider);
  const store = new ProviderGatewayRepository(prisma, cipher), repository = new ProviderExecutionRepository(prisma, cipher), authorizer = new WorkspaceMembershipExecutionAuthorizer(prisma), redis = createRedisConnection(source.REDIS_URL ?? "");
  const gateway = createProductionProviderGateway(registry, { resolveWorkspaceRoute: input => store.resolveWorkspaceRoute(input) }, { resolve: async () => undefined }, overrides.adapterResolver ?? createProviderAdapterResolver(new FetchProviderHttpTransport()), { authorize: (principal, request) => authorizer.authorizeExecution(principal, request.workspaceId), assertRouteUsable: snapshot => store.assertResolvedRouteUsable(snapshot.workspaceId, snapshot.connectionId, snapshot.credentialVersionId), assertBudget: () => undefined, validateEndpoint: overrides.validateEndpoint ?? (async snapshot => { if (!snapshot.endpoint) throw new Error("ROUTE_UNAVAILABLE"); await validateProviderEndpoint(snapshot.endpoint, { environment: source.NODE_ENV ?? "production", dns: { lookup: async hostname => (await import("node:dns/promises")).resolve4(hostname) } }); }), repository, rate: overrides.rate ?? new RedisRateLimiter(redis), concurrency: overrides.concurrency ?? new RedisConcurrencyLimiter(redis), circuit: overrides.circuit ?? new RedisCircuitBreaker(redis) });
  const runtime: BookGatewayRuntime = { gateway, repository, createAnalysisProvider: async input => {
    const slots = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"] as const;
    const snapshots = await Promise.all(slots.map(routeSlot => gateway.resolveSnapshot({
      workspaceId: input.workspaceId, routeSlot, correlationId: input.analysisRunId,
      idempotencyKey: `book-analysis-route-preflight:${input.analysisRunId}:${routeSlot}`,
      inputHash: sha256(`${input.analysisRunId}:${routeSlot}`),
      capability: { family: "TEXT_GENERATION", structuredOutput: "STRICT_JSON_SCHEMA" },
    })));
    if (snapshots.some(snapshot => snapshot.providerKey !== input.provider || snapshot.modelId !== input.model)) throw new Error("BOOK_ANALYSIS_ROUTE_IDENTITY_MODEL_GAP");
    return new GatewayAnalysisProvider(runtime, input);
  } };
  return runtime;
}
