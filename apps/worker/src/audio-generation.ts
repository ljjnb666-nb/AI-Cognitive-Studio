import { Queue, Worker } from "bullmq";
import { dispatchPendingPodcastAudioGeneration, processPodcastAudioGenerationRun, type AudioDependencies } from "@ai-cognitive/podcast-generation";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export const AUDIO_GENERATION_QUEUE = "podcast.audio-generation";
export function createPodcastAudioWorker(environment: Environment, dependencies?: Omit<AudioDependencies, "storage">) {
  if (!dependencies) throw new Error("AUDIO_GENERATION_PROVIDER_NOT_CONFIGURED");
  const storage = new S3CompatibleStorageProvider({ endpoint: environment.S3_ENDPOINT, region: environment.S3_REGION, bucket: environment.S3_BUCKET, accessKey: environment.S3_ACCESS_KEY, secretKey: environment.S3_SECRET_KEY, forcePathStyle: environment.S3_FORCE_PATH_STYLE });
  return new Worker<{ audioGenerationRunId: string }>(AUDIO_GENERATION_QUEUE, job => processPodcastAudioGenerationRun(job.data.audioGenerationRunId, { ...dependencies, storage }), { connection: createRedisConnection(environment.REDIS_URL) });
}
export function createPodcastAudioQueue(environment: Environment) { return new Queue<{ audioGenerationRunId: string }>(AUDIO_GENERATION_QUEUE, { connection: createRedisConnection(environment.REDIS_URL) }); }
export async function dispatchPodcastAudioGeneration(environment: Environment): Promise<number> { const queue = createPodcastAudioQueue(environment); try { return await dispatchPendingPodcastAudioGeneration(queue); } finally { await queue.close(); } }
