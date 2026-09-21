import { Queue, Worker } from "bullmq";
import { dispatchPendingPodcastAudioGeneration, normalizePodcastAudioDispatchPayload, processPodcastAudioGenerationRun, type AudioDependencies, type PodcastAudioDispatchPayload } from "@ai-cognitive/podcast-generation";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export const AUDIO_GENERATION_QUEUE = "podcast.audio-generation";
export type PodcastAudioQueueOptions = { prefix?: string; concurrency?: number };
export function createPodcastAudioWorker(environment: Environment, dependencies?: Omit<AudioDependencies, "storage">, options: PodcastAudioQueueOptions = {}) {
  if (!dependencies || (!dependencies.provider && !dependencies.providerForRun)) throw new Error("AUDIO_GENERATION_PROVIDER_NOT_CONFIGURED");
  const storage = new S3CompatibleStorageProvider({ endpoint: environment.S3_ENDPOINT, region: environment.S3_REGION, bucket: environment.S3_BUCKET, accessKey: environment.S3_ACCESS_KEY, secretKey: environment.S3_SECRET_KEY, forcePathStyle: environment.S3_FORCE_PATH_STYLE });
  return new Worker<PodcastAudioDispatchPayload>(AUDIO_GENERATION_QUEUE, job => { const payload = normalizePodcastAudioDispatchPayload(job.data); return processPodcastAudioGenerationRun(payload.audioGenerationRunId, { ...dependencies, storage }, payload.dispatchGeneration); }, { connection: createRedisConnection(environment.REDIS_URL), concurrency: options.concurrency ?? environment.WORKER_AUDIO_CONCURRENCY ?? 1, ...(options.prefix ? { prefix: options.prefix } : {}) });
}
export function createPodcastAudioQueue(environment: Environment, options: PodcastAudioQueueOptions = {}) { return new Queue<PodcastAudioDispatchPayload>(AUDIO_GENERATION_QUEUE, { connection: createRedisConnection(environment.REDIS_URL), ...(options.prefix ? { prefix: options.prefix } : {}) }); }
export function dispatchPodcastAudioGenerationWithQueue(queue: Queue<PodcastAudioDispatchPayload>, options?: Parameters<typeof dispatchPendingPodcastAudioGeneration>[1]): Promise<number> { return dispatchPendingPodcastAudioGeneration(queue, options); }
export async function dispatchPodcastAudioGeneration(environment: Environment): Promise<number> { const queue = createPodcastAudioQueue(environment); try { return await dispatchPodcastAudioGenerationWithQueue(queue); } finally { await queue.close(); } }
