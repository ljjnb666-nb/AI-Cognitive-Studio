import type { EmbeddingProvider, ProcessBookAnalysisDependencies } from "@ai-cognitive/book-intelligence";
import type { PodcastGenerationProvider, DurablePodcastGenerationProvider } from "@ai-cognitive/podcast-generation";
import { logger } from "@ai-cognitive/shared";
import type { Environment } from "@ai-cognitive/shared/server";
import type { Worker } from "bullmq";
import { createBookAnalysisWorker, createBookAnalysisQueue, dispatchBookAnalysisWithQueue } from "./book-analysis.js";
import { createPodcastGenerationWorker, createPodcastGenerationQueue, dispatchPodcastGenerationWithQueue } from "./podcast-generation.js";
import { createPodcastAudioWorker, createPodcastAudioQueue, dispatchPodcastAudioGenerationWithQueue } from "./audio-generation.js";
import { createShortVideoGenerationWorker, createShortVideoGenerationQueue, dispatchShortVideoGenerationWithQueue, type ShortVideoRuntimeAdapter } from "./short-video-generation.js";
import { createSourceIngestionWorker, createSourceIngestionQueue, dispatchSourceIngestionWithQueue } from "./source-ingestion.js";
import { createBookAnalysisBootstrapWorker, createBookAnalysisBootstrapQueue, dispatchBookAnalysisBootstrapWithQueue, reconcileWaitingBookAnalysisBootstraps } from "./book-analysis-bootstrap.js";
import { createHealthCheckWorker } from "./worker.js";
import { createBookProductionGatewayRuntime, createPodcastAudioProductionGatewayRuntime, createPodcastProductionGatewayRuntime, createShortVideoProductionGatewayRuntime, type BookGatewayRuntime, type BookProductionGatewayRuntimeOverrides, type PodcastAudioGatewayRuntime, type PodcastGatewayRuntime, type ShortVideoGatewayRuntime } from "./provider-gateway-runtime.js";
import { startProcessingHeartbeat } from "./processing-heartbeat.js";
import { resolveCredentialKeyring, resolveProviderCatalog } from "@ai-cognitive/provider-gateway";

export type PodcastRuntimeAdapter = { provider?: PodcastGenerationProvider; providerForRun?: (input: { workspaceId: string; podcastGenerationRunId: string; provider: string; model: string }) => Promise<DurablePodcastGenerationProvider>; embeddingProvider?: EmbeddingProvider; embeddingProviderForRun?: (input: { workspaceId: string; podcastGenerationRunId: string }) => Promise<EmbeddingProvider> };
export type AudioRuntimeAdapter = Parameters<typeof createPodcastAudioWorker>[1];
export type WorkerRuntimeOptions = { source?: NodeJS.ProcessEnv; podcastAdapter?: PodcastRuntimeAdapter; audioAdapter?: AudioRuntimeAdapter; shortVideoAdapter?: ShortVideoRuntimeAdapter; bookDependencies?: ProcessBookAnalysisDependencies; /** Deterministic adapter/control seam for production-composition tests; never supplies Book dependencies. */ bookProductionGatewayOverrides?: BookProductionGatewayRuntimeOverrides; dispatchIntervalMs?: number; bullmqPrefix?: string; outboxTopics?: Partial<{ sourceIngestion: string; bookAnalysisBootstrap: string; bookAnalysis: string; podcastGeneration: string; podcastAudio: string; shortVideo: string }> };

export function resolvePodcastRuntimeAdapter(source: NodeJS.ProcessEnv, injected?: PodcastRuntimeAdapter): PodcastRuntimeAdapter | undefined {
  const configured = source.PODCAST_GENERATION_PROVIDER?.trim();
  if (!configured) return undefined;
  if (!injected) throw new Error(`PODCAST_GENERATION_PROVIDER_UNSUPPORTED:${configured}`);
  if (injected.provider && injected.provider.identity.provider !== configured) throw new Error(`PODCAST_GENERATION_PROVIDER_UNSUPPORTED:${configured}`);
  return injected;
}

/** Uses the Provider Gateway's own runtime prerequisites; manifests are optional. */
export function resolveBookWorkerCapability(source: NodeJS.ProcessEnv): boolean {
  // Parse an explicit manifest even when a keyring is absent: malformed operator
  // configuration must fail fast rather than silently disabling the worker.
  resolveProviderCatalog(source.PROVIDER_GATEWAY_MODEL_MANIFEST);
  return Boolean(resolveCredentialKeyring(source));
}

export async function startWorkerRuntime(environment: Environment, options: WorkerRuntimeOptions = {}) {
  const source = options.source ?? process.env;
  let productionPodcastGatewayRuntime: PodcastGatewayRuntime | undefined;
  let productionPodcastAudioGatewayRuntime: PodcastAudioGatewayRuntime | undefined;
  let productionShortVideoGatewayRuntime: ShortVideoGatewayRuntime | undefined;
  let podcastAdapter = options.podcastAdapter ? resolvePodcastRuntimeAdapter(source, options.podcastAdapter) : undefined;
  const audioConfigured = source.AUDIO_GENERATION_PROVIDER?.trim();
  const shortVideoConfigured = source.SHORT_VIDEO_GENERATION_PROVIDER?.trim();
  if (audioConfigured && options.audioAdapter?.provider && options.audioAdapter.provider.identity.provider !== audioConfigured) throw new Error(`AUDIO_GENERATION_PROVIDER_UNSUPPORTED:${audioConfigured}`);
  if (shortVideoConfigured && options.shortVideoAdapter?.provider && options.shortVideoAdapter.provider.identity.provider !== shortVideoConfigured) throw new Error(`SHORT_VIDEO_GENERATION_PROVIDER_UNSUPPORTED:${shortVideoConfigured}`);
  const queueOptions = options.bullmqPrefix ? { prefix: options.bullmqPrefix } : undefined;
  const workerOptions = (concurrency: number) => ({ ...(queueOptions ?? {}), concurrency });
  const bookConfigured = source.BOOK_ANALYSIS_PROVIDER?.trim();
  // Workspace BYOK is resolved per run. A gateway-capable worker must not be
  // hidden behind the legacy process-global provider toggle.
  const gatewayConfigured = resolveBookWorkerCapability(source);
  const bookEnabled = Boolean(options.bookDependencies || bookConfigured || gatewayConfigured);
  let productionBookGatewayRuntime: BookGatewayRuntime | undefined;
  try {
  if (!podcastAdapter && source.PODCAST_GENERATION_PROVIDER?.trim()) {
    const runtime = productionPodcastGatewayRuntime = createPodcastProductionGatewayRuntime(source, options.bookProductionGatewayOverrides);
    podcastAdapter = { providerForRun: input => runtime.createProviderForRun(input), embeddingProviderForRun: input => runtime.createEmbeddingProviderForRun(input) };
  }
  const audioAdapter = audioConfigured ? options.audioAdapter ?? { providerForRun: input => (productionPodcastAudioGatewayRuntime ??= createPodcastAudioProductionGatewayRuntime(source, options.bookProductionGatewayOverrides)).createSpeechProviderForRun(input) } : undefined;
  const productionBookDependencies = bookEnabled && !options.bookDependencies ? (() => { const runtime = productionBookGatewayRuntime = createBookProductionGatewayRuntime(source, options.bookProductionGatewayOverrides); return { analysisProviderForRun: (input: { workspaceId: string; userId: string; analysisRunId: string; provider: string; model: string }) => runtime.createAnalysisProvider(input), embeddingGatewayForRun: (input: { workspaceId: string; userId: string; analysisRunId: string }) => runtime.createEmbeddingGatewayForRun(input) }; })() : undefined;
  const bookWorker = bookEnabled ? createBookAnalysisWorker(environment, options.bookDependencies ?? productionBookDependencies, workerOptions(environment.WORKER_BOOK_ANALYSIS_CONCURRENCY)) : undefined;
  const bookBootstrapWorker = createBookAnalysisBootstrapWorker(environment, { ...workerOptions(environment.WORKER_BOOK_ANALYSIS_CONCURRENCY), source });
  const healthWorker = createHealthCheckWorker(environment.REDIS_URL);
  const ingestionWorker = createSourceIngestionWorker(environment, workerOptions(environment.WORKER_INGESTION_CONCURRENCY));
  if (!bookWorker) logger.info("worker.book_analysis.disabled", { reason: "BOOK_ANALYSIS_PROVIDER_NOT_CONFIGURED" });
  const podcastWorker = podcastAdapter ? createPodcastGenerationWorker(environment, podcastAdapter, workerOptions(environment.WORKER_PODCAST_GENERATION_CONCURRENCY)) : undefined;
  const audioWorker = audioConfigured ? createPodcastAudioWorker(environment, audioAdapter, workerOptions(environment.WORKER_AUDIO_CONCURRENCY)) : undefined;
  const shortVideoAdapter = shortVideoConfigured ? options.shortVideoAdapter ?? { providerForRun: input => (productionShortVideoGatewayRuntime ??= createShortVideoProductionGatewayRuntime(source, options.bookProductionGatewayOverrides)).createTextProviderForRun(input), embeddingProviderForRun: input => (productionShortVideoGatewayRuntime ??= createShortVideoProductionGatewayRuntime(source, options.bookProductionGatewayOverrides)).createEmbeddingProviderForRun(input), ttsForRun: input => (productionShortVideoGatewayRuntime ??= createShortVideoProductionGatewayRuntime(source, options.bookProductionGatewayOverrides)).createSpeechProviderForRun(input) } : undefined;
  const shortVideoWorker = shortVideoConfigured ? createShortVideoGenerationWorker(environment, shortVideoAdapter, workerOptions(environment.WORKER_SHORT_VIDEO_CONCURRENCY)) : undefined;
  const ingestionQueue = createSourceIngestionQueue(environment, queueOptions);
  const bookBootstrapQueue = createBookAnalysisBootstrapQueue(environment, queueOptions);
  const bookQueue = bookWorker ? createBookAnalysisQueue(environment, queueOptions) : undefined;
  const podcastQueue = podcastWorker ? createPodcastGenerationQueue(environment, queueOptions) : undefined;
  const audioQueue = audioWorker ? createPodcastAudioQueue(environment, queueOptions) : undefined;
  const shortVideoQueue = shortVideoWorker ? createShortVideoGenerationQueue(environment, queueOptions) : undefined;
  if (!podcastWorker) logger.info("worker.podcast_generation.disabled", { reason: "PODCAST_GENERATION_PROVIDER_NOT_CONFIGURED" });
  if (!audioWorker) logger.info("worker.audio_generation.disabled", { reason: "AUDIO_GENERATION_PROVIDER_NOT_CONFIGURED" });
  if (!shortVideoWorker) logger.info("worker.short_video_generation.disabled", { reason: "SHORT_VIDEO_GENERATION_PROVIDER_NOT_CONFIGURED" });
  const interval = options.dispatchIntervalMs ?? 1_000;
  let stopping = false;
  const active = new Set<Promise<void>>();
  const schedules: NodeJS.Timeout[] = [];
  const heartbeat = startProcessingHeartbeat(environment.REDIS_URL, { ingestion: true, bookAnalysis: Boolean(bookWorker), podcastGeneration: Boolean(podcastWorker), podcastAudio: Boolean(audioWorker), shortVideoGeneration: Boolean(shortVideoWorker) }, { onError: () => logger.warn("worker.heartbeat.failed", { code: "HEARTBEAT_WRITE_FAILED" }) });
  await heartbeat.beat().catch(() => logger.warn("worker.heartbeat.failed", { code: "HEARTBEAT_WRITE_FAILED" }));
  const dispatch = (name: string, work: () => Promise<unknown>) => {
    let running = false;
    const run = async () => {
      if (stopping || running) return;
      running = true;
      const operation = Promise.resolve(work()).then(() => undefined).catch((error: unknown) => {
        if (!stopping) logger.error("worker.dispatch.failed", { dispatcher: name, error: error instanceof Error ? error.message : String(error) });
      }).finally(() => { running = false; active.delete(operation); });
      active.add(operation);
      await operation;
    };
    schedules.push(setInterval(() => { void run(); }, interval));
    return run;
  };
  // Provider-wait repair is deliberately coarse-grained, rather than tied to
  // the high-frequency outbox dispatcher, so an unconfigured workspace cannot poll tightly.
  schedules.push(setInterval(() => { if (!stopping) void reconcileWaitingBookAnalysisBootstraps(25, source).catch(error => logger.warn("worker.book_analysis_provider_reconciliation.failed", { error: error instanceof Error ? error.message : String(error) })); }, 30_000));
  const initial: Array<() => Promise<void>> = [dispatch("source-ingestion", () => dispatchSourceIngestionWithQueue(ingestionQueue, environment, options.outboxTopics?.sourceIngestion ? { topic: options.outboxTopics.sourceIngestion } : {})), dispatch("book-analysis-bootstrap", () => dispatchBookAnalysisBootstrapWithQueue(bookBootstrapQueue, { ...(options.outboxTopics?.bookAnalysisBootstrap ? { topic: options.outboxTopics.bookAnalysisBootstrap } : {}), dispatchConcurrency: environment.OUTBOX_DISPATCH_CONCURRENCY })), async () => { await reconcileWaitingBookAnalysisBootstraps(25, source); }];
  if (bookQueue) initial.push(dispatch("book-analysis", () => dispatchBookAnalysisWithQueue(bookQueue, { ...(options.outboxTopics?.bookAnalysis ? { topic: options.outboxTopics.bookAnalysis } : {}), dispatchConcurrency: environment.OUTBOX_DISPATCH_CONCURRENCY })));
  if (podcastQueue) initial.push(dispatch("podcast-generation", () => dispatchPodcastGenerationWithQueue(podcastQueue, { ...(options.outboxTopics?.podcastGeneration ? { topic: options.outboxTopics.podcastGeneration } : {}), dispatchConcurrency: environment.OUTBOX_DISPATCH_CONCURRENCY })));
  if (audioQueue) initial.push(dispatch("podcast-audio", () => dispatchPodcastAudioGenerationWithQueue(audioQueue, { ...(options.outboxTopics?.podcastAudio ? { topic: options.outboxTopics.podcastAudio } : {}), dispatchConcurrency: environment.OUTBOX_DISPATCH_CONCURRENCY })));
  if (shortVideoQueue) initial.push(dispatch("short-video-generation", () => dispatchShortVideoGenerationWithQueue(shortVideoQueue, { ...(options.outboxTopics?.shortVideo ? { topic: options.outboxTopics.shortVideo } : {}), dispatchConcurrency: environment.OUTBOX_DISPATCH_CONCURRENCY })));
  await Promise.all(initial.map((run) => run()));
  logger.info("worker.started", { queue: "system.health-check", podcastGenerationEnabled: Boolean(podcastWorker) });
  let closePromise: Promise<void> | undefined;
  return { healthWorker, ingestionWorker, bookBootstrapWorker, bookWorker, podcastWorker, audioWorker, shortVideoWorker, close(signal = "manual") { return closePromise ??= (async () => { stopping = true; logger.info("worker.shutdown.started", { signal }); for (const timer of schedules) clearInterval(timer); await Promise.allSettled(active); await heartbeat.close().catch(() => undefined); await ingestionQueue.close(); await bookBootstrapQueue.close(); await bookQueue?.close(); await podcastQueue?.close(); await audioQueue?.close(); await shortVideoQueue?.close(); await healthWorker.close(); await ingestionWorker.close(); await bookBootstrapWorker.close(); await bookWorker?.close(); await podcastWorker?.close(); await audioWorker?.close(); await shortVideoWorker?.close(); await productionBookGatewayRuntime?.close(); await productionPodcastGatewayRuntime?.close(); await productionPodcastAudioGatewayRuntime?.close(); await productionShortVideoGatewayRuntime?.close(); logger.info("worker.shutdown.completed", { signal }); })(); } };
  } catch (error) {
    await productionBookGatewayRuntime?.close(); await productionPodcastGatewayRuntime?.close(); await productionPodcastAudioGatewayRuntime?.close(); await productionShortVideoGatewayRuntime?.close();
    throw error;
  }
}

export type StartedWorkerRuntime = Awaited<ReturnType<typeof startWorkerRuntime>>;
export type RuntimeWorker = Worker;
