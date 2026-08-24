import { prisma } from "@ai-cognitive/db";
import { GatewayPodcastGenerationProvider, GatewayPodcastRetrievalEmbeddingProvider, GatewayPodcastSpeechSynthesisProvider, type DurablePodcastGenerationProvider, type DurableSpeechSynthesisProvider } from "@ai-cognitive/podcast-generation";
import { GatewayShortVideoProvider, GatewayShortVideoRetrievalEmbeddingProvider, GatewayShortVideoTtsProvider, type ShortVideoProvider, type ShortVideoTtsProvider } from "@ai-cognitive/short-video-generation";
import { loadConsumedBookAnalysisEmbeddingIdentity, type AnalysisProvider, type AnalysisRequest, type AnalysisReceiptConsumer, type AnalysisTransaction, type EmbeddingProvider, validateAnalysisResponse } from "@ai-cognitive/book-intelligence";
import { FetchProviderHttpTransport, ProviderExecutionRepository, ProviderGatewayRepository, ProviderRegistry, RedisCircuitBreaker, RedisConcurrencyLimiter, RedisRateLimiter, WorkspaceMembershipExecutionAuthorizer, createProductionProviderGateway, createProviderAdapterResolver, parseKeyring, validateProviderEndpoint, type GatewayExecutionDependencies, type GatewayRequest, type ModelCapability, type ProviderAdapterResolver, type ProviderDefinition, type ProviderGateway } from "@ai-cognitive/provider-gateway";
import { createRedisConnection } from "@ai-cognitive/shared/server";
import { sha256 } from "@ai-cognitive/book-intelligence";

type Manifest = { providers: ProviderDefinition[] };
export type BookGatewayRuntime = { gateway: ProviderGateway; repository: ProviderExecutionRepository; createAnalysisProvider(input: { workspaceId: string; userId: string; analysisRunId: string; provider: string; model: string }): Promise<AnalysisProvider>; close(): Promise<void>; };
/** Test-only seams keep production composition real while preventing external provider traffic. */
export type BookProductionGatewayRuntimeOverrides = Pick<GatewayExecutionDependencies, "circuit" | "rate" | "concurrency" | "validateEndpoint"> & { adapterResolver?: ProviderAdapterResolver; redisFactory?: (url: string) => ReturnType<typeof createRedisConnection> };

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
    if (outcome.status === "ALREADY_PROCESSED" && outcome.textConsumed) throw new Error("BOOK_ANALYSIS_TEXT_RECONCILIATION_REQUIRED");
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
  const store = new ProviderGatewayRepository(prisma, cipher), repository = new ProviderExecutionRepository(prisma, cipher), authorizer = new WorkspaceMembershipExecutionAuthorizer(prisma);
  const redis = !overrides.rate || !overrides.concurrency || !overrides.circuit ? (overrides.redisFactory ?? createRedisConnection)(source.REDIS_URL ?? "") : undefined;
  const gateway = createProductionProviderGateway(registry, { resolveWorkspaceRoute: input => store.resolveWorkspaceRoute(input) }, { resolve: async () => undefined }, overrides.adapterResolver ?? createProviderAdapterResolver(new FetchProviderHttpTransport()), { authorize: (principal, request) => authorizer.authorizeExecution(principal, request.workspaceId), assertRouteUsable: snapshot => store.assertResolvedRouteUsable(snapshot.workspaceId, snapshot.connectionId, snapshot.credentialVersionId), assertBudget: () => undefined, validateEndpoint: overrides.validateEndpoint ?? (async snapshot => { if (!snapshot.endpoint) throw new Error("ROUTE_UNAVAILABLE"); await validateProviderEndpoint(snapshot.endpoint, { environment: source.NODE_ENV ?? "production", dns: { lookup: async hostname => (await import("node:dns/promises")).resolve4(hostname) } }); }), repository, rate: overrides.rate ?? new RedisRateLimiter(redis!), concurrency: overrides.concurrency ?? new RedisConcurrencyLimiter(redis!), circuit: overrides.circuit ?? new RedisCircuitBreaker(redis!) });
  let closePromise: Promise<void> | undefined;
  const runtime: BookGatewayRuntime = { gateway, repository, close: () => closePromise ??= redis ? redis.quit().then(() => undefined) : Promise.resolve(), createAnalysisProvider: async input => {
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

export type PodcastGatewayRuntime = { createProviderForRun(input: { workspaceId: string; podcastGenerationRunId: string; provider: string; model: string }): Promise<DurablePodcastGenerationProvider>; createEmbeddingProviderForRun(input: { workspaceId: string; podcastGenerationRunId: string }): Promise<EmbeddingProvider>; close(): Promise<void>; };
export type PodcastAudioGatewayRuntime = { createSpeechProviderForRun(input: { workspaceId: string; audioGenerationRunId: string }): Promise<DurableSpeechSynthesisProvider>; close(): Promise<void>; };
export type ShortVideoGatewayRuntime = { createTextProviderForRun(input: { workspaceId: string; shortVideoGenerationRunId: string; provider: string; model: string }): Promise<ShortVideoProvider>; createEmbeddingProviderForRun(input: { workspaceId: string; shortVideoGenerationRunId: string }): Promise<EmbeddingProvider>; createSpeechProviderForRun(input: { workspaceId: string; shortVideoGenerationRunId: string }): Promise<ShortVideoTtsProvider>; close(): Promise<void>; };
/** Podcast TEXT and QUERY retrieval share the accepted workspace-BYOK gateway composition. */
export function createPodcastProductionGatewayRuntime(source: NodeJS.ProcessEnv, overrides: BookProductionGatewayRuntimeOverrides = {}): PodcastGatewayRuntime {
  const base = createBookProductionGatewayRuntime(source, overrides);
  const loadPrincipal = async (input: { workspaceId: string; podcastGenerationRunId: string }) => {
    const run = await prisma.podcastGenerationRun.findUniqueOrThrow({ where: { id: input.podcastGenerationRunId }, include: { job: true } });
    if (run.workspaceId !== input.workspaceId || run.job.workspaceId !== run.workspaceId) throw new Error("PODCAST_DURABLE_PRINCIPAL_WORKSPACE_MISMATCH");
    if (!run.job.userId) throw new Error("PODCAST_DURABLE_PRINCIPAL_MISSING");
    const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: run.workspaceId, userId: run.job.userId } } });
    if (!member) throw new Error("PODCAST_DURABLE_PRINCIPAL_MISSING");
    return run;
  };
  return { close: () => base.close(), createProviderForRun: async input => {
    const run = await loadPrincipal(input);
    return new GatewayPodcastGenerationProvider({ gateway: base.gateway, repository: base.repository, workspaceId: run.workspaceId, userId: run.job.userId!, podcastGenerationRunId: run.id, provider: input.provider, model: input.model, pipelineVersion: run.pipelineVersion, promptVersion: run.promptVersion });
  }, createEmbeddingProviderForRun: async input => {
    const run = await loadPrincipal(input);
    const sources = await prisma.podcastGenerationSource.findMany({ where: { podcastGenerationRunId: run.id, workspaceId: run.workspaceId }, select: { analysisRunId: true } });
    if (!sources.length) throw new Error("PODCAST_RETRIEVAL_EMBEDDING_IDENTITY_MISSING");
    let identities;
    try { identities = await Promise.all(sources.map(item => loadConsumedBookAnalysisEmbeddingIdentity({ workspaceId: run.workspaceId, analysisRunId: item.analysisRunId, embeddingVersion: "gateway" }))); }
    catch { throw new Error("PODCAST_RETRIEVAL_EMBEDDING_IDENTITY_MISSING"); }
    const identity = identities[0]!;
    if (identities.some(candidate => candidate.hash !== identity.hash || candidate.provider !== identity.provider || candidate.model !== identity.model || candidate.dimensions !== identity.dimensions || candidate.embeddingVersion !== identity.embeddingVersion || (candidate.modelVersion ?? "") !== (identity.modelVersion ?? ""))) throw new Error("PODCAST_RETRIEVAL_SOURCE_EMBEDDING_INCOMPATIBLE");
    return new GatewayPodcastRetrievalEmbeddingProvider({ gateway: base.gateway, repository: base.repository, workspaceId: run.workspaceId, userId: run.job.userId!, podcastGenerationRunId: run.id, pipelineVersion: run.pipelineVersion, identity });
  } };
}

/** PHASE8C_CHECKPOINT5_PODCAST_SPEECH_GATEWAY_AUTONOMY: durable job principal and PODCAST_TTS only. */
export function createPodcastAudioProductionGatewayRuntime(source: NodeJS.ProcessEnv, overrides: BookProductionGatewayRuntimeOverrides = {}): PodcastAudioGatewayRuntime {
  const base = createBookProductionGatewayRuntime(source, overrides);
  return { close: () => base.close(), createSpeechProviderForRun: async input => {
    const run = await prisma.audioGenerationRun.findUniqueOrThrow({ where: { id: input.audioGenerationRunId }, include: { job: true } });
    if (run.workspaceId !== input.workspaceId || run.job.workspaceId !== run.workspaceId) throw new Error("AUDIO_DURABLE_PRINCIPAL_WORKSPACE_MISMATCH");
    if (!run.job.userId) throw new Error("AUDIO_DURABLE_PRINCIPAL_MISSING");
    const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: run.workspaceId, userId: run.job.userId } } });
    if (!member) throw new Error("AUDIO_DURABLE_PRINCIPAL_MISSING");
    return new GatewayPodcastSpeechSynthesisProvider({ gateway: base.gateway, repository: base.repository, workspaceId: run.workspaceId, userId: run.job.userId, audioGenerationRunId: run.id, provider: run.provider, model: run.model, modelVersion: run.modelVersion, pipelineVersion: run.pipelineVersion, speechPreparationVersion: run.speechPreparationVersion });
  } };
}

/** PHASE8C_CHECKPOINT6_SHORT_VIDEO_GATEWAY_AUTONOMY: one shared BYOK Gateway runtime for text, query, and speech. */
export function createShortVideoProductionGatewayRuntime(source: NodeJS.ProcessEnv, overrides: BookProductionGatewayRuntimeOverrides = {}): ShortVideoGatewayRuntime {
  const base = createBookProductionGatewayRuntime(source, overrides);
  const loadPrincipal = async (input: { workspaceId: string; shortVideoGenerationRunId: string }) => {
    const run = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: input.shortVideoGenerationRunId }, include: { job: true, styleProfile: true, speechExecutionPin: true } });
    if (run.workspaceId !== input.workspaceId || run.job.workspaceId !== run.workspaceId) throw new Error("SHORT_VIDEO_DURABLE_PRINCIPAL_WORKSPACE_MISMATCH");
    if (!run.job.userId) throw new Error("SHORT_VIDEO_DURABLE_PRINCIPAL_MISSING");
    const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: run.workspaceId, userId: run.job.userId } } });
    if (!member) throw new Error("SHORT_VIDEO_DURABLE_PRINCIPAL_MISSING");
    return run;
  };
  return { close: () => base.close(), createTextProviderForRun: async input => {
    const run = await loadPrincipal(input);
    return new GatewayShortVideoProvider({ gateway: base.gateway, repository: base.repository, workspaceId: run.workspaceId, userId: run.job.userId!, runId: run.id, provider: run.provider, model: run.model, modelVersion: run.modelVersion, pipelineVersion: run.pipelineVersion, promptVersion: run.promptVersion });
  }, createEmbeddingProviderForRun: async input => {
    const run = await loadPrincipal(input);
    const sources = await prisma.shortVideoGenerationSource.findMany({ where: { shortVideoGenerationRunId: run.id, workspaceId: run.workspaceId }, select: { analysisRunId: true } });
    if (!sources.length) throw new Error("SHORT_VIDEO_RETRIEVAL_EMBEDDING_IDENTITY_MISSING");
    let identities;
    try { identities = await Promise.all(sources.map(item => loadConsumedBookAnalysisEmbeddingIdentity({ workspaceId: run.workspaceId, analysisRunId: item.analysisRunId, embeddingVersion: "gateway" }))); } catch { throw new Error("SHORT_VIDEO_RETRIEVAL_EMBEDDING_IDENTITY_MISSING"); }
    const identity = identities[0]!;
    if (identities.some(candidate => candidate.hash !== identity.hash || candidate.provider !== identity.provider || candidate.model !== identity.model || candidate.dimensions !== identity.dimensions || candidate.embeddingVersion !== identity.embeddingVersion || (candidate.modelVersion ?? "") !== (identity.modelVersion ?? ""))) throw new Error("SHORT_VIDEO_RETRIEVAL_SOURCE_EMBEDDING_INCOMPATIBLE");
    return new GatewayShortVideoRetrievalEmbeddingProvider({ gateway: base.gateway, repository: base.repository, workspaceId: run.workspaceId, userId: run.job.userId!, runId: run.id, pipelineVersion: run.pipelineVersion, identity });
  }, createSpeechProviderForRun: async input => {
    const run = await loadPrincipal(input);
    const route = await prisma.providerRouteBinding.findUnique({ where: { workspaceId_routeSlot: { workspaceId: run.workspaceId, routeSlot: "SHORT_VIDEO_TTS" } }, include: { connection: true } });
    const configuration = (route?.configuration ?? {}) as Record<string, unknown>;
    const providerVoiceId = typeof configuration.providerVoiceId === "string" && configuration.providerVoiceId.trim() ? configuration.providerVoiceId : undefined;
    const voiceVersion = typeof configuration.voiceVersion === "string" && configuration.voiceVersion.trim() ? configuration.voiceVersion : undefined;
    const outputFormat = typeof configuration.outputFormat === "string" && configuration.outputFormat.trim() ? configuration.outputFormat : undefined;
    const speakingRate = typeof configuration.speakingRate === "number" && Number.isFinite(configuration.speakingRate) ? configuration.speakingRate : undefined;
    const pitch = typeof configuration.pitch === "number" && Number.isFinite(configuration.pitch) ? configuration.pitch : undefined;
    if (!route || !providerVoiceId || !voiceVersion || !outputFormat || speakingRate === undefined || pitch === undefined) throw new Error("SHORT_VIDEO_TTS_VOICE_CONFIGURATION_REQUIRED");
    const routeIdentity = { provider: route.connection.providerKey, model: route.modelId, modelVersion: typeof configuration.modelVersion === "string" ? configuration.modelVersion : null, providerVoiceId, voiceVersion, speakingRate, pitch, style: typeof configuration.style === "string" ? configuration.style : null, language: run.styleProfile.language, outputFormat };
    const pin = run.speechExecutionPin ?? await prisma.shortVideoSpeechExecutionPin.create({ data: { workspaceId: run.workspaceId, shortVideoGenerationRunId: run.id, ...routeIdentity, voiceIdentityHash: sha256(JSON.stringify(routeIdentity)), audioVersion: run.audioVersion, pipelineVersion: run.pipelineVersion } }).catch(async error => { if ((error as { code?: string }).code !== "P2002") throw error; return prisma.shortVideoSpeechExecutionPin.findUniqueOrThrow({ where: { shortVideoGenerationRunId: run.id } }); });
    if (pin.provider !== routeIdentity.provider || pin.model !== routeIdentity.model || (pin.modelVersion ?? "") !== (routeIdentity.modelVersion ?? "") || pin.providerVoiceId !== routeIdentity.providerVoiceId || (pin.voiceVersion ?? "") !== routeIdentity.voiceVersion || pin.speakingRate !== routeIdentity.speakingRate || pin.pitch !== routeIdentity.pitch || (pin.style ?? "") !== (routeIdentity.style ?? "") || pin.language !== routeIdentity.language || pin.outputFormat !== routeIdentity.outputFormat) throw new Error("SHORT_VIDEO_TTS_ROUTE_IDENTITY_MISMATCH");
    return new GatewayShortVideoTtsProvider({ gateway: base.gateway, repository: base.repository, workspaceId: run.workspaceId, userId: run.job.userId!, runId: run.id, pipelineVersion: run.pipelineVersion, pin });
  } };
}
