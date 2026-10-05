import { reconcileStaleBookAnalysisJobs, type EmbeddingProvider, type ProcessBookAnalysisDependencies } from "@ai-cognitive/book-intelligence";
import type { PodcastGenerationProvider, DurablePodcastGenerationProvider } from "@ai-cognitive/podcast-generation";
import { logger } from "@ai-cognitive/shared";
import type { Environment } from "@ai-cognitive/shared/server";
import type { Worker } from "bullmq";
import { createBookAnalysisWorker, createBookAnalysisQueue, dispatchBookAnalysisWithQueue } from "./book-analysis.js";
import { createPodcastGenerationWorker, createPodcastGenerationQueue, dispatchPodcastGenerationWithQueue } from "./podcast-generation.js";
import { createPodcastAudioWorker, createPodcastAudioQueue, dispatchPodcastAudioGenerationWithQueue } from "./audio-generation.js";
import { createShortVideoGenerationWorker, createShortVideoGenerationQueue, dispatchShortVideoGenerationWithQueue, type ShortVideoRuntimeAdapter } from "./short-video-generation.js";
import { createSourceIngestionWorker, createSourceIngestionQueue, dispatchSourceIngestionWithQueue, INGESTION_JOB } from "./source-ingestion.js";
import { reconcileIngestionDeliveries, type IngestionReconciliationQueuePort } from "@ai-cognitive/ingestion";
import { createBookAnalysisBootstrapWorker, createBookAnalysisBootstrapQueue, dispatchBookAnalysisBootstrapWithQueue, reconcileHistoricalBookAnalysisBootstraps, reconcileWaitingBookAnalysisBootstraps } from "./book-analysis-bootstrap.js";
import { createHealthCheckWorker } from "./worker.js";
import { createBookProductionGatewayRuntime, createPodcastAudioProductionGatewayRuntime, createPodcastProductionGatewayRuntime, createShortVideoProductionGatewayRuntime, type BookGatewayRuntime, type BookProductionGatewayRuntimeOverrides, type PodcastAudioGatewayRuntime, type PodcastGatewayRuntime, type ShortVideoGatewayRuntime } from "./provider-gateway-runtime.js";
import { startProcessingHeartbeat } from "./processing-heartbeat.js";
import { resolveCredentialKeyring, resolveProviderCatalog } from "@ai-cognitive/provider-gateway";
import { DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE, scheduleDurableOperationReconciliation, reconcileDurableExpensiveOperationsSweep, type ReconciliationQueue, type ReconciliationQueues, type ReconciliationSweepState, type ReconciliationTopics } from "./durable-operation-reconciliation.js";

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

function asReconciliationQueue(queue: { getJob(id: string): Promise<{ id?: string; data: unknown; getState(): Promise<string> } | null | undefined> }): ReconciliationQueue {
  return {
    getJob: async id => {
      const job = await queue.getJob(id);
      return job ? { id: job.id ?? "", data: job.data, getState: () => job.getState() } : null;
    },
  };
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
  const dispatch = (name: string, work: () => Promise<unknown>, cadenceMs = interval, schedule = true) => {
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
    if (schedule) schedules.push(setInterval(() => { void run(); }, cadenceMs));
    return run;
  };
  // Provider-wait repair is deliberately coarse-grained, rather than tied to
  // the high-frequency outbox dispatcher, so an unconfigured workspace cannot poll tightly.
  schedules.push(setInterval(() => { if (!stopping) void Promise.all([reconcileHistoricalBookAnalysisBootstraps(25), reconcileWaitingBookAnalysisBootstraps(25, source)]).catch(error => logger.warn("worker.book_analysis_bootstrap_reconciliation.failed", { error: error instanceof Error ? error.message : String(error) })); }, 60_000));
  // This bounded domain sweep has its own dispatch guard and error boundary;
  // the PR #46 durable-operation sweep is scheduled independently below.
  const reconcileBookAnalysisStale = dispatch("book-analysis-stale-reconciliation", () => reconcileStaleBookAnalysisJobs(25), 60_000);
  // Durable ingestion delivery reconciliation: PostgreSQL first, BullMQ second.
  // Redis state loss may delay a delivery; it can never exceed the durable
  // attempt guard or strand an expired RUNNING run.
  const ingestionReconciliationQueue: IngestionReconciliationQueuePort = {
    getJobState: async (jobId) => {
      const job = await ingestionQueue.getJob(jobId);
      if (!job) return null;
      const state = await job.getState();
      return state === "waiting" || state === "delayed" || state === "active" || state === "completed" || state === "failed" ? state : null;
    },
    remove: async (jobId) => { await ingestionQueue.remove(jobId); },
    add: async (jobId) => { await ingestionQueue.add(INGESTION_JOB, { ingestionRunId: jobId }, { jobId }); },
  };
  const reconcileIngestionDeliveriesSweep = dispatch("source-ingestion-reconciliation", () => reconcileIngestionDeliveries({ queue: ingestionReconciliationQueue, maxAttempts: environment.SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS }), 60_000);
  const initial: Array<() => Promise<void>> = [dispatch("source-ingestion", () => dispatchSourceIngestionWithQueue(ingestionQueue, environment, options.outboxTopics?.sourceIngestion ? { topic: options.outboxTopics.sourceIngestion } : {})), dispatch("book-analysis-bootstrap", () => dispatchBookAnalysisBootstrapWithQueue(bookBootstrapQueue, { ...(options.outboxTopics?.bookAnalysisBootstrap ? { topic: options.outboxTopics.bookAnalysisBootstrap } : {}), dispatchConcurrency: environment.OUTBOX_DISPATCH_CONCURRENCY })), async () => { await reconcileHistoricalBookAnalysisBootstraps(25); await reconcileWaitingBookAnalysisBootstraps(25, source); }];
  initial.push(reconcileBookAnalysisStale);
  initial.push(reconcileIngestionDeliveriesSweep);
  if (bookQueue) initial.push(dispatch("book-analysis", () => dispatchBookAnalysisWithQueue(bookQueue, { ...(options.outboxTopics?.bookAnalysis ? { topic: options.outboxTopics.bookAnalysis } : {}), dispatchConcurrency: environment.OUTBOX_DISPATCH_CONCURRENCY })));
  if (podcastQueue) initial.push(dispatch("podcast-generation", () => dispatchPodcastGenerationWithQueue(podcastQueue, { ...(options.outboxTopics?.podcastGeneration ? { topic: options.outboxTopics.podcastGeneration } : {}), dispatchConcurrency: environment.OUTBOX_DISPATCH_CONCURRENCY })));
  if (audioQueue) initial.push(dispatch("podcast-audio", () => dispatchPodcastAudioGenerationWithQueue(audioQueue, { ...(options.outboxTopics?.podcastAudio ? { topic: options.outboxTopics.podcastAudio } : {}), dispatchConcurrency: environment.OUTBOX_DISPATCH_CONCURRENCY })));
  if (shortVideoQueue) initial.push(dispatch("short-video-generation", () => dispatchShortVideoGenerationWithQueue(shortVideoQueue, { ...(options.outboxTopics?.shortVideo ? { topic: options.outboxTopics.shortVideo } : {}), dispatchConcurrency: environment.OUTBOX_DISPATCH_CONCURRENCY })));
  await Promise.all(initial.map((run) => run()));
  const reconciliationQueues: ReconciliationQueues = {
    ...(bookQueue ? { BOOK_ANALYSIS: asReconciliationQueue(bookQueue) } : {}),
    ...(podcastQueue ? { PODCAST_GENERATION: asReconciliationQueue(podcastQueue) } : {}),
    ...(shortVideoQueue ? { SHORT_VIDEO_GENERATION: asReconciliationQueue(shortVideoQueue) } : {}),
    ...(audioQueue ? { PODCAST_AUDIO_GENERATION: asReconciliationQueue(audioQueue) } : {}),
  };
  const reconciliationTopics: ReconciliationTopics = {
    ...(options.outboxTopics?.bookAnalysis ? { BOOK_ANALYSIS: options.outboxTopics.bookAnalysis } : {}),
    ...(options.outboxTopics?.podcastGeneration ? { PODCAST_GENERATION: options.outboxTopics.podcastGeneration } : {}),
    ...(options.outboxTopics?.shortVideo ? { SHORT_VIDEO_GENERATION: options.outboxTopics.shortVideo } : {}),
    ...(options.outboxTopics?.podcastAudio ? { PODCAST_AUDIO_GENERATION: options.outboxTopics.podcastAudio } : {}),
  };
  let reconciliationSweepState: ReconciliationSweepState | undefined;
  const reconcileDurableOperations = dispatch("durable-operation-reconciliation", async () => {
    const result = await reconcileDurableExpensiveOperationsSweep({
      batchSize: DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE,
      state: reconciliationSweepState,
      queues: reconciliationQueues,
      topics: reconciliationTopics,
    });
    reconciliationSweepState = result.nextState;
  }, undefined, false);
  schedules.push(scheduleDurableOperationReconciliation(() => { void reconcileDurableOperations(); }));
  // Startup work is one bounded page and does not delay readiness.
  void reconcileDurableOperations();
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
