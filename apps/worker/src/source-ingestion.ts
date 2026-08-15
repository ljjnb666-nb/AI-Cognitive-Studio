import { Queue, Worker } from "bullmq";
import { createIngestionService, dispatchPendingIngestion, INGESTION_JOB, INGESTION_QUEUE } from "@ai-cognitive/ingestion";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export function createSourceIngestionWorker(environment: Environment) {
  const storage = new S3CompatibleStorageProvider({ endpoint: environment.S3_ENDPOINT, region: environment.S3_REGION, bucket: environment.S3_BUCKET, accessKey: environment.S3_ACCESS_KEY, secretKey: environment.S3_SECRET_KEY, forcePathStyle: environment.S3_FORCE_PATH_STYLE });
  const service = createIngestionService(storage, { maxUploadBytes: environment.SOURCE_MAX_UPLOAD_BYTES, uploadTtlSeconds: environment.SOURCE_UPLOAD_URL_TTL_SECONDS, maxPdfPages: environment.SOURCE_MAX_PDF_PAGES, completionLeaseMs: environment.SOURCE_UPLOAD_COMPLETION_LEASE_MS });
  return new Worker<{ ingestionRunId: string }>(INGESTION_QUEUE, async (job) => service.processIngestionRun(job.data.ingestionRunId), { connection: createRedisConnection(environment.REDIS_URL) });
}

export function createSourceIngestionQueue(environment: Environment) { return new Queue<{ ingestionRunId: string }>(INGESTION_QUEUE, { connection: createRedisConnection(environment.REDIS_URL) }); }
export function dispatchSourceIngestionWithQueue(queue: Queue<{ ingestionRunId: string }>, environment: Environment): Promise<number> { return dispatchPendingIngestion(queue, { leaseMs: environment.SOURCE_OUTBOX_LEASE_MS, maxAttempts: environment.SOURCE_OUTBOX_MAX_ATTEMPTS }); }
export async function dispatchSourceIngestion(environment: Environment): Promise<number> {
  const queue = createSourceIngestionQueue(environment);
  try { return await dispatchSourceIngestionWithQueue(queue, environment); }
  finally { await queue.close(); }
}
export { INGESTION_JOB };
