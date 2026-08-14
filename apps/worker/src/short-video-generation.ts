import { Queue, Worker } from "bullmq";
import {
  dispatchPendingShortVideoGeneration,
  processShortVideoGenerationRun,
  type ShortVideoProvider,
  type ShortVideoTtsProvider,
} from "@ai-cognitive/short-video-generation";
import type { EmbeddingProvider } from "@ai-cognitive/book-intelligence";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import {
  createRedisConnection,
  type Environment,
} from "@ai-cognitive/shared/server";

export const SHORT_VIDEO_GENERATION_QUEUE = "short-video.generation";
export type ShortVideoRuntimeAdapter = {
  provider: ShortVideoProvider;
  embeddingProvider: EmbeddingProvider;
  tts: ShortVideoTtsProvider;
  renderConfiguration?: { width: number; height: number; fps: number };
};
export function createShortVideoGenerationWorker(
  environment: Environment,
  dependencies?: ShortVideoRuntimeAdapter,
) {
  if (!dependencies)
    throw new Error("SHORT_VIDEO_GENERATION_PROVIDER_NOT_CONFIGURED");
  const storage = new S3CompatibleStorageProvider({
    endpoint: environment.S3_ENDPOINT,
    region: environment.S3_REGION,
    bucket: environment.S3_BUCKET,
    accessKey: environment.S3_ACCESS_KEY,
    secretKey: environment.S3_SECRET_KEY,
    forcePathStyle: environment.S3_FORCE_PATH_STYLE,
  });
  return new Worker<{ shortVideoGenerationRunId: string }>(
    SHORT_VIDEO_GENERATION_QUEUE,
    (job) =>
      processShortVideoGenerationRun(job.data.shortVideoGenerationRunId, {
        ...dependencies,
        storage,
      }),
    { connection: createRedisConnection(environment.REDIS_URL) },
  );
}
export function createShortVideoGenerationQueue(environment: Environment) {
  return new Queue<{ shortVideoGenerationRunId: string }>(
    SHORT_VIDEO_GENERATION_QUEUE,
    { connection: createRedisConnection(environment.REDIS_URL) },
  );
}
export function dispatchShortVideoGenerationWithQueue(queue: Queue<{ shortVideoGenerationRunId: string }>): Promise<number> { return dispatchPendingShortVideoGeneration(queue); }
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
