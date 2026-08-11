import type { AnalysisProvider, EmbeddingProvider } from "@ai-cognitive/book-intelligence";
import type { PodcastGenerationProvider } from "@ai-cognitive/podcast-generation";
import { logger } from "@ai-cognitive/shared";
import type { Environment } from "@ai-cognitive/shared/server";
import type { Worker } from "bullmq";
import { createBookAnalysisWorker, dispatchBookAnalysis } from "./book-analysis.js";
import { createPodcastGenerationWorker, dispatchPodcastGeneration } from "./podcast-generation.js";
import { createSourceIngestionWorker, dispatchSourceIngestion } from "./source-ingestion.js";
import { createHealthCheckWorker } from "./worker.js";

export type PodcastRuntimeAdapter = { provider: PodcastGenerationProvider; embeddingProvider: EmbeddingProvider };
export type WorkerRuntimeOptions = { source?: NodeJS.ProcessEnv; podcastAdapter?: PodcastRuntimeAdapter; bookDependencies?: { analysisProvider: AnalysisProvider; embeddingProvider: EmbeddingProvider }; dispatchIntervalMs?: number };

export function resolvePodcastRuntimeAdapter(source: NodeJS.ProcessEnv, injected?: PodcastRuntimeAdapter): PodcastRuntimeAdapter | undefined {
  const configured = source.PODCAST_GENERATION_PROVIDER?.trim();
  if (!configured) return undefined;
  if (!injected || injected.provider.identity.provider !== configured) throw new Error(`PODCAST_GENERATION_PROVIDER_UNSUPPORTED:${configured}`);
  return injected;
}

export async function startWorkerRuntime(environment: Environment, options: WorkerRuntimeOptions = {}) {
  const source = options.source ?? process.env;
  const podcastAdapter = resolvePodcastRuntimeAdapter(source, options.podcastAdapter);
  const healthWorker = createHealthCheckWorker(environment.REDIS_URL);
  const ingestionWorker = createSourceIngestionWorker(environment);
  const bookWorker = source.BOOK_ANALYSIS_PROVIDER ? createBookAnalysisWorker(environment, options.bookDependencies) : undefined;
  if (!bookWorker) logger.info("worker.book_analysis.disabled", { reason: "BOOK_ANALYSIS_PROVIDER_NOT_CONFIGURED" });
  const podcastWorker = podcastAdapter ? createPodcastGenerationWorker(environment, podcastAdapter) : undefined;
  if (!podcastWorker) logger.info("worker.podcast_generation.disabled", { reason: "PODCAST_GENERATION_PROVIDER_NOT_CONFIGURED" });
  const interval = options.dispatchIntervalMs ?? 1_000;
  const timers = [setInterval(() => void dispatchSourceIngestion(environment), interval)];
  if (bookWorker) timers.push(setInterval(() => void dispatchBookAnalysis(environment), interval));
  if (podcastWorker) timers.push(setInterval(() => void dispatchPodcastGeneration(environment), interval));
  await dispatchSourceIngestion(environment);
  if (bookWorker) await dispatchBookAnalysis(environment);
  if (podcastWorker) await dispatchPodcastGeneration(environment);
  logger.info("worker.started", { queue: "system.health-check", podcastGenerationEnabled: Boolean(podcastWorker) });
  let closed = false;
  return { healthWorker, ingestionWorker, bookWorker, podcastWorker, async close(signal = "manual") { if (closed) return; closed = true; logger.info("worker.shutdown.started", { signal }); for (const timer of timers) clearInterval(timer); await healthWorker.close(); await ingestionWorker.close(); await bookWorker?.close(); await podcastWorker?.close(); logger.info("worker.shutdown.completed", { signal }); } };
}

export type StartedWorkerRuntime = Awaited<ReturnType<typeof startWorkerRuntime>>;
export type RuntimeWorker = Worker;
