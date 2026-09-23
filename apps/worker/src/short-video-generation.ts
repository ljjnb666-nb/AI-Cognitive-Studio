import { Queue, Worker } from "bullmq";
import {
  dispatchPendingShortVideoGeneration,
  processShortVideoGenerationRun,
  videoRenderFailureDetails,
  type ShortVideoProvider,
  type ShortVideoTtsProvider,
  type VideoRenderer,
} from "@ai-cognitive/short-video-generation";
import type { EmbeddingProvider } from "@ai-cognitive/book-intelligence";
import { logger } from "@ai-cognitive/shared";
import { normalizeDispatchGeneration } from "@ai-cognitive/ingestion";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import {
  createRedisConnection,
  type Environment,
} from "@ai-cognitive/shared/server";

export const SHORT_VIDEO_GENERATION_QUEUE = "short-video.generation";
export type ShortVideoGenerationQueueOptions = { prefix?: string; concurrency?: number };
export type ShortVideoRuntimeAdapter = {
  provider?: ShortVideoProvider;
  embeddingProvider?: EmbeddingProvider;
  tts?: ShortVideoTtsProvider;
  providerForRun?: (input: { workspaceId: string; shortVideoGenerationRunId: string; provider: string; model: string }) => Promise<ShortVideoProvider>;
  embeddingProviderForRun?: (input: { workspaceId: string; shortVideoGenerationRunId: string }) => Promise<EmbeddingProvider>;
  ttsForRun?: (input: { workspaceId: string; shortVideoGenerationRunId: string }) => Promise<ShortVideoTtsProvider>;
  renderer?: VideoRenderer;
  renderConfiguration?: { width: number; height: number; fps: number };
};
export function createShortVideoGenerationWorker(
  environment: Environment,
  dependencies?: ShortVideoRuntimeAdapter,
  options: ShortVideoGenerationQueueOptions = {},
) {
  if (!dependencies || (!dependencies.provider && !dependencies.providerForRun) || (!dependencies.embeddingProvider && !dependencies.embeddingProviderForRun) || (!dependencies.tts && !dependencies.ttsForRun))
    throw new Error("SHORT_VIDEO_GENERATION_PROVIDER_NOT_CONFIGURED");
  const storage = new S3CompatibleStorageProvider({
    endpoint: environment.S3_ENDPOINT,
    region: environment.S3_REGION,
    bucket: environment.S3_BUCKET,
    accessKey: environment.S3_ACCESS_KEY,
    secretKey: environment.S3_SECRET_KEY,
    forcePathStyle: environment.S3_FORCE_PATH_STYLE,
  });
  return new Worker<{ shortVideoGenerationRunId: string; dispatchGeneration?: number }>(
    SHORT_VIDEO_GENERATION_QUEUE,
    async (job) => {
      try {
        return await processShortVideoGenerationRun(job.data.shortVideoGenerationRunId, {
          ...dependencies,
          storage,
        }, normalizeDispatchGeneration(job.data));
      } catch (error) {
        if (error instanceof Error && error.message === "OUTBOX_PAYLOAD_INVALID") return;
        const diagnostic = videoRenderFailureDetails(error);
        logger.error("short_video.worker.failed", {
          shortVideoGenerationRunId: job.data.shortVideoGenerationRunId,
          queueJobId: job.id,
          ...(diagnostic ?? {
            code: error instanceof Error ? error.message.split(":")[0] : "SHORT_VIDEO_GENERATION_FAILED",
          }),
        });
        throw error;
      }
    },
    { connection: createRedisConnection(environment.REDIS_URL), concurrency: options.concurrency ?? environment.WORKER_SHORT_VIDEO_CONCURRENCY ?? 1, ...(options.prefix ? { prefix: options.prefix } : {}) },
  );
}
export function createShortVideoGenerationQueue(environment: Environment, options: ShortVideoGenerationQueueOptions = {}) {
  return new Queue<{ shortVideoGenerationRunId: string; dispatchGeneration?: number }>(
    SHORT_VIDEO_GENERATION_QUEUE,
    { connection: createRedisConnection(environment.REDIS_URL), ...(options.prefix ? { prefix: options.prefix } : {}) },
  );
}
export function dispatchShortVideoGenerationWithQueue(queue: Queue<{ shortVideoGenerationRunId: string }>, options?: Parameters<typeof dispatchPendingShortVideoGeneration>[1]): Promise<number> { return dispatchPendingShortVideoGeneration(queue, options); }
export async function dispatchShortVideoGeneration(
  environment: Environment,
): Promise<number> {
  const queue = createShortVideoGenerationQueue(environment);
  try {
    return await dispatchShortVideoGenerationWithQueue(queue);
  } finally {
    await queue.close();
  }
}
