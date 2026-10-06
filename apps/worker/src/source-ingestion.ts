import { Queue, Worker } from "bullmq";
import { createIngestionService, createMineruPdfOcrExecutor, dispatchPendingIngestion, INGESTION_JOB, INGESTION_QUEUE, resolveMineruExecutorConfig, type PdfOcrExecutor } from "@ai-cognitive/ingestion";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export type SourceIngestionQueueOptions = { prefix?: string; concurrency?: number; /** Real OCR fallback executor (04B-3). Resolved once via resolveSourceIngestionOcrExecutor; injected for testability. */ pdfOcrExecutor?: PdfOcrExecutor };
export function createSourceIngestionWorker(environment: Environment, options: SourceIngestionQueueOptions = {}) {
  const storage = new S3CompatibleStorageProvider({ endpoint: environment.S3_ENDPOINT, region: environment.S3_REGION, bucket: environment.S3_BUCKET, accessKey: environment.S3_ACCESS_KEY, secretKey: environment.S3_SECRET_KEY, forcePathStyle: environment.S3_FORCE_PATH_STYLE });
  const service = createIngestionService(storage, { maxUploadBytes: environment.SOURCE_MAX_UPLOAD_BYTES, uploadTtlSeconds: environment.SOURCE_UPLOAD_URL_TTL_SECONDS, maxPdfPages: environment.SOURCE_MAX_PDF_PAGES, completionLeaseMs: environment.SOURCE_UPLOAD_COMPLETION_LEASE_MS, processMaxAttempts: environment.SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS, ...(options.pdfOcrExecutor ? { pdfOcrExecutor: options.pdfOcrExecutor } : {}) });
  return new Worker<{ ingestionRunId: string }>(INGESTION_QUEUE, async (job) => service.processIngestionRun(job.data.ingestionRunId), { connection: createRedisConnection(environment.REDIS_URL), concurrency: options.concurrency ?? environment.WORKER_INGESTION_CONCURRENCY ?? 1, ...(options.prefix ? { prefix: options.prefix } : {}) });
}

export type SourceIngestionOcrRuntime = { pdfOcrExecutor: PdfOcrExecutor; close(): Promise<void> };

/**
 * Production OCR runtime resolution (BOOK-INGESTION-04B-3). Returns undefined
 * when OCR is intentionally unconfigured: production keeps the 04B-2 no-OCR
 * behavior. Malformed explicit MinerU configuration fails fast here, at worker
 * startup — never a silent fallback that could enable network behavior.
 */
export function resolveSourceIngestionOcrExecutor(environment: Environment): SourceIngestionOcrRuntime | undefined {
  const config = resolveMineruExecutorConfig(environment);
  if (!config) return undefined;
  const runtime = createMineruPdfOcrExecutor(config);
  return { pdfOcrExecutor: runtime.executor, close: () => runtime.close() };
}

export function createSourceIngestionQueue(environment: Environment, options: SourceIngestionQueueOptions = {}) {
  return new Queue<{ ingestionRunId: string }>(INGESTION_QUEUE, {
    connection: createRedisConnection(environment.REDIS_URL),
    ...(options.prefix ? { prefix: options.prefix } : {}),
    // SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS is the single authority for bounded
    // same-run processing attempts: it configures these BullMQ attempts AND the
    // PostgreSQL Job.attemptCount claim guard. OUTBOX DISPATCH ATTEMPTS
    // (SOURCE_OUTBOX_MAX_ATTEMPTS) govern OutboxEvent -> BullMQ enqueue delivery
    // and are unrelated to ingestion processing attempts.
    defaultJobOptions: { attempts: environment.SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 100 },
  });
}
export function dispatchSourceIngestionWithQueue(queue: Queue<{ ingestionRunId: string }>, environment: Environment, options: Omit<Parameters<typeof dispatchPendingIngestion>[1], "leaseMs" | "maxAttempts" | "dispatchConcurrency"> = {}): Promise<number> { return dispatchPendingIngestion(queue, { leaseMs: environment.SOURCE_OUTBOX_LEASE_MS, maxAttempts: environment.SOURCE_OUTBOX_MAX_ATTEMPTS, dispatchConcurrency: environment.OUTBOX_DISPATCH_CONCURRENCY, ...options }); }
export async function dispatchSourceIngestion(environment: Environment): Promise<number> {
  const queue = createSourceIngestionQueue(environment);
  try { return await dispatchSourceIngestionWithQueue(queue, environment); }
  finally { await queue.close(); }
}
export { INGESTION_JOB };
