import type { EmbeddingProvider, ProcessBookAnalysisDependencies } from "@ai-cognitive/book-intelligence";
import type { PodcastGenerationProvider } from "@ai-cognitive/podcast-generation";
import { logger } from "@ai-cognitive/shared";
import type { Environment } from "@ai-cognitive/shared/server";
import type { Worker } from "bullmq";
import { createBookAnalysisWorker, createBookAnalysisQueue, dispatchBookAnalysisWithQueue } from "./book-analysis.js";
import { createPodcastGenerationWorker, createPodcastGenerationQueue, dispatchPodcastGenerationWithQueue } from "./podcast-generation.js";
import { createPodcastAudioWorker, createPodcastAudioQueue, dispatchPodcastAudioGenerationWithQueue } from "./audio-generation.js";
import { createShortVideoGenerationWorker, createShortVideoGenerationQueue, dispatchShortVideoGenerationWithQueue, type ShortVideoRuntimeAdapter } from "./short-video-generation.js";
import { createSourceIngestionWorker, createSourceIngestionQueue, dispatchSourceIngestionWithQueue } from "./source-ingestion.js";
import { createHealthCheckWorker } from "./worker.js";
import { createBookProductionGatewayRuntime } from "./provider-gateway-runtime.js";

export type PodcastRuntimeAdapter = { provider: PodcastGenerationProvider; embeddingProvider: EmbeddingProvider };
export type AudioRuntimeAdapter = Parameters<typeof createPodcastAudioWorker>[1];
export type WorkerRuntimeOptions = { source?: NodeJS.ProcessEnv; podcastAdapter?: PodcastRuntimeAdapter; audioAdapter?: AudioRuntimeAdapter; shortVideoAdapter?: ShortVideoRuntimeAdapter; bookDependencies?: ProcessBookAnalysisDependencies; dispatchIntervalMs?: number; bullmqPrefix?: string; outboxTopics?: Partial<{ sourceIngestion: string; bookAnalysis: string; podcastGeneration: string; podcastAudio: string; shortVideo: string }> };

export function resolvePodcastRuntimeAdapter(source: NodeJS.ProcessEnv, injected?: PodcastRuntimeAdapter): PodcastRuntimeAdapter | undefined {
  const configured = source.PODCAST_GENERATION_PROVIDER?.trim();
  if (!configured) return undefined;
  if (!injected || injected.provider.identity.provider !== configured) throw new Error(`PODCAST_GENERATION_PROVIDER_UNSUPPORTED:${configured}`);
  return injected;
}

export async function startWorkerRuntime(environment: Environment, options: WorkerRuntimeOptions = {}) {
  const source = options.source ?? process.env;
  const podcastAdapter = resolvePodcastRuntimeAdapter(source, options.podcastAdapter);
  const audioConfigured = source.AUDIO_GENERATION_PROVIDER?.trim();
  const shortVideoConfigured = source.SHORT_VIDEO_GENERATION_PROVIDER?.trim();
  if (audioConfigured && (!options.audioAdapter || options.audioAdapter.provider.identity.provider !== audioConfigured)) throw new Error(`AUDIO_GENERATION_PROVIDER_UNSUPPORTED:${audioConfigured}`);
  if (shortVideoConfigured && (!options.shortVideoAdapter || options.shortVideoAdapter.provider.identity.provider !== shortVideoConfigured)) throw new Error(`SHORT_VIDEO_GENERATION_PROVIDER_UNSUPPORTED:${shortVideoConfigured}`);
  const healthWorker = createHealthCheckWorker(environment.REDIS_URL);
  const queueOptions = options.bullmqPrefix ? { prefix: options.bullmqPrefix } : undefined;
  const ingestionWorker = createSourceIngestionWorker(environment, queueOptions);
  const bookConfigured = source.BOOK_ANALYSIS_PROVIDER?.trim();
  const productionBookDependencies = bookConfigured && !options.bookDependencies ? (() => { const runtime = createBookProductionGatewayRuntime(source); return { analysisProviderForRun: (input: { workspaceId: string; userId: string; analysisRunId: string; provider: string; model: string }) => runtime.createAnalysisProvider(input), embeddingGatewayForRun: (input: { workspaceId: string; userId: string; analysisRunId: string }) => ({ gateway: runtime.gateway, repository: runtime.repository, userId: input.userId }) }; })() : undefined;
  const bookWorker = bookConfigured ? createBookAnalysisWorker(environment, options.bookDependencies ?? productionBookDependencies, queueOptions) : undefined;
  if (!bookWorker) logger.info("worker.book_analysis.disabled", { reason: "BOOK_ANALYSIS_PROVIDER_NOT_CONFIGURED" });
  const podcastWorker = podcastAdapter ? createPodcastGenerationWorker(environment, podcastAdapter, queueOptions) : undefined;
  const audioWorker = audioConfigured ? createPodcastAudioWorker(environment, options.audioAdapter, queueOptions) : undefined;
  const shortVideoWorker = shortVideoConfigured ? createShortVideoGenerationWorker(environment, options.shortVideoAdapter, queueOptions) : undefined;
  const ingestionQueue = createSourceIngestionQueue(environment, queueOptions);
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
  const initial = [dispatch("source-ingestion", () => dispatchSourceIngestionWithQueue(ingestionQueue, environment, options.outboxTopics?.sourceIngestion ? { topic: options.outboxTopics.sourceIngestion } : {}))];
  if (bookQueue) initial.push(dispatch("book-analysis", () => dispatchBookAnalysisWithQueue(bookQueue, options.outboxTopics?.bookAnalysis ? { topic: options.outboxTopics.bookAnalysis } : undefined)));
  if (podcastQueue) initial.push(dispatch("podcast-generation", () => dispatchPodcastGenerationWithQueue(podcastQueue, options.outboxTopics?.podcastGeneration ? { topic: options.outboxTopics.podcastGeneration } : undefined)));
  if (audioQueue) initial.push(dispatch("podcast-audio", () => dispatchPodcastAudioGenerationWithQueue(audioQueue, options.outboxTopics?.podcastAudio ? { topic: options.outboxTopics.podcastAudio } : undefined)));
  if (shortVideoQueue) initial.push(dispatch("short-video-generation", () => dispatchShortVideoGenerationWithQueue(shortVideoQueue, options.outboxTopics?.shortVideo ? { topic: options.outboxTopics.shortVideo } : undefined)));
  await Promise.all(initial.map((run) => run()));
  logger.info("worker.started", { queue: "system.health-check", podcastGenerationEnabled: Boolean(podcastWorker) });
  let closePromise: Promise<void> | undefined;
  return { healthWorker, ingestionWorker, bookWorker, podcastWorker, audioWorker, shortVideoWorker, close(signal = "manual") { return closePromise ??= (async () => { stopping = true; logger.info("worker.shutdown.started", { signal }); for (const timer of schedules) clearInterval(timer); await Promise.allSettled(active); await ingestionQueue.close(); await bookQueue?.close(); await podcastQueue?.close(); await audioQueue?.close(); await shortVideoQueue?.close(); await healthWorker.close(); await ingestionWorker.close(); await bookWorker?.close(); await podcastWorker?.close(); await audioWorker?.close(); await shortVideoWorker?.close(); logger.info("worker.shutdown.completed", { signal }); })(); } };
}

export type StartedWorkerRuntime = Awaited<ReturnType<typeof startWorkerRuntime>>;
export type RuntimeWorker = Worker;
