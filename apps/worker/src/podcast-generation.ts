import { Queue, Worker } from "bullmq";
import { dispatchPendingPodcastGeneration, processPodcastGenerationRun, type PodcastGenerationProvider } from "@ai-cognitive/podcast-generation";
import type { EmbeddingProvider } from "@ai-cognitive/book-intelligence";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export const PODCAST_GENERATION_QUEUE = "podcast.generation";
export function createPodcastGenerationWorker(environment: Environment, dependencies?: { provider: PodcastGenerationProvider; embeddingProvider: EmbeddingProvider }) {
  if (!dependencies) throw new Error("PODCAST_GENERATION_PROVIDER_NOT_CONFIGURED");
  return new Worker<{ podcastGenerationRunId: string }>(PODCAST_GENERATION_QUEUE, async (job) => processPodcastGenerationRun(job.data.podcastGenerationRunId, dependencies), { connection: createRedisConnection(environment.REDIS_URL) });
}
export function createPodcastGenerationQueue(environment: Environment) { return new Queue<{ podcastGenerationRunId: string }>(PODCAST_GENERATION_QUEUE, { connection: createRedisConnection(environment.REDIS_URL) }); }
export async function dispatchPodcastGeneration(environment: Environment): Promise<number> { const queue = createPodcastGenerationQueue(environment); try { return await dispatchPendingPodcastGeneration(queue); } finally { await queue.close(); } }
