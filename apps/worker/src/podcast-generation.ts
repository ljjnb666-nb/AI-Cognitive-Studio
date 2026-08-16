import { Queue, Worker } from "bullmq";
import { dispatchPendingPodcastGeneration, processPodcastGenerationRun, type PodcastGenerationProvider } from "@ai-cognitive/podcast-generation";
import type { EmbeddingProvider } from "@ai-cognitive/book-intelligence";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export const PODCAST_GENERATION_QUEUE = "podcast.generation";
export type PodcastGenerationQueueOptions = { prefix?: string };
export function createPodcastGenerationWorker(environment: Environment, dependencies?: { provider: PodcastGenerationProvider; embeddingProvider: EmbeddingProvider }, options: PodcastGenerationQueueOptions = {}) {
  if (!dependencies) throw new Error("PODCAST_GENERATION_PROVIDER_NOT_CONFIGURED");
  return new Worker<{ podcastGenerationRunId: string }>(PODCAST_GENERATION_QUEUE, async (job) => processPodcastGenerationRun(job.data.podcastGenerationRunId, dependencies), { connection: createRedisConnection(environment.REDIS_URL), ...(options.prefix ? { prefix: options.prefix } : {}) });
}
export function createPodcastGenerationQueue(environment: Environment, options: PodcastGenerationQueueOptions = {}) { return new Queue<{ podcastGenerationRunId: string }>(PODCAST_GENERATION_QUEUE, { connection: createRedisConnection(environment.REDIS_URL), ...(options.prefix ? { prefix: options.prefix } : {}) }); }
export function dispatchPodcastGenerationWithQueue(queue: Queue<{ podcastGenerationRunId: string }>, options?: Parameters<typeof dispatchPendingPodcastGeneration>[1]): Promise<number> { return dispatchPendingPodcastGeneration(queue, options); }
export async function dispatchPodcastGeneration(environment: Environment): Promise<number> { const queue = createPodcastGenerationQueue(environment); try { return await dispatchPodcastGenerationWithQueue(queue); } finally { await queue.close(); } }
