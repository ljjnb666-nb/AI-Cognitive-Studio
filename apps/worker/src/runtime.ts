import type { AnalysisProvider, EmbeddingProvider } from "@ai-cognitive/book-intelligence";
import type { PodcastGenerationProvider } from "@ai-cognitive/podcast-generation";
import { logger } from "@ai-cognitive/shared";
import type { Environment } from "@ai-cognitive/shared/server";
import type { Worker } from "bullmq";
import { createBookAnalysisWorker, dispatchBookAnalysis } from "./book-analysis.js";
import { createPodcastGenerationWorker, dispatchPodcastGeneration } from "./podcast-generation.js";
import { createPodcastAudioWorker, dispatchPodcastAudioGeneration } from "./audio-generation.js";
import { createShortVideoGenerationWorker, dispatchShortVideoGeneration, type ShortVideoRuntimeAdapter } from "./short-video-generation.js";
import { createSourceIngestionWorker, dispatchSourceIngestion } from "./source-ingestion.js";
import { createHealthCheckWorker } from "./worker.js";

export type PodcastRuntimeAdapter = { provider: PodcastGenerationProvider; embeddingProvider: EmbeddingProvider };
export type AudioRuntimeAdapter = Parameters<typeof createPodcastAudioWorker>[1];
export type WorkerRuntimeOptions = { source?: NodeJS.ProcessEnv; podcastAdapter?: PodcastRuntimeAdapter; audioAdapter?: AudioRuntimeAdapter; shortVideoAdapter?: ShortVideoRuntimeAdapter; bookDependencies?: { analysisProvider: AnalysisProvider; embeddingProvider: EmbeddingProvider }; dispatchIntervalMs?: number };

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
  const ingestionWorker = createSourceIngestionWorker(environment);
  const bookWorker = source.BOOK_ANALYSIS_PROVIDER ? createBookAnalysisWorker(environment, options.bookDependencies) : undefined;
  if (!bookWorker) logger.info("worker.book_analysis.disabled", { reason: "BOOK_ANALYSIS_PROVIDER_NOT_CONFIGURED" });
  const podcastWorker = podcastAdapter ? createPodcastGenerationWorker(environment, podcastAdapter) : undefined;
  const audioWorker = audioConfigured ? createPodcastAudioWorker(environment, options.audioAdapter) : undefined;
  const shortVideoWorker = shortVideoConfigured ? createShortVideoGenerationWorker(environment, options.shortVideoAdapter) : undefined;
  if (!podcastWorker) logger.info("worker.podcast_generation.disabled", { reason: "PODCAST_GENERATION_PROVIDER_NOT_CONFIGURED" });
  if (!audioWorker) logger.info("worker.audio_generation.disabled", { reason: "AUDIO_GENERATION_PROVIDER_NOT_CONFIGURED" });
  if (!shortVideoWorker) logger.info("worker.short_video_generation.disabled", { reason: "SHORT_VIDEO_GENERATION_PROVIDER_NOT_CONFIGURED" });
  const interval = options.dispatchIntervalMs ?? 1_000;
  const timers = [setInterval(() => void dispatchSourceIngestion(environment), interval)];
  if (bookWorker) timers.push(setInterval(() => void dispatchBookAnalysis(environment), interval));
  if (podcastWorker) timers.push(setInterval(() => void dispatchPodcastGeneration(environment), interval));
  if (audioWorker) timers.push(setInterval(() => void dispatchPodcastAudioGeneration(environment), interval));
  if (shortVideoWorker) timers.push(setInterval(() => void dispatchShortVideoGeneration(environment), interval));
  await dispatchSourceIngestion(environment);
  if (bookWorker) await dispatchBookAnalysis(environment);
  if (podcastWorker) await dispatchPodcastGeneration(environment);
  if (audioWorker) await dispatchPodcastAudioGeneration(environment);
  if (shortVideoWorker) await dispatchShortVideoGeneration(environment);
  logger.info("worker.started", { queue: "system.health-check", podcastGenerationEnabled: Boolean(podcastWorker) });
  let closed = false;
  return { healthWorker, ingestionWorker, bookWorker, podcastWorker, audioWorker, shortVideoWorker, async close(signal = "manual") { if (closed) return; closed = true; logger.info("worker.shutdown.started", { signal }); for (const timer of timers) clearInterval(timer); await healthWorker.close(); await ingestionWorker.close(); await bookWorker?.close(); await podcastWorker?.close(); await audioWorker?.close(); await shortVideoWorker?.close(); logger.info("worker.shutdown.completed", { signal }); } };
}

export type StartedWorkerRuntime = Awaited<ReturnType<typeof startWorkerRuntime>>;
export type RuntimeWorker = Worker;
