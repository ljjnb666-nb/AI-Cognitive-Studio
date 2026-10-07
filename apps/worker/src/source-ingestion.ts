import { DelayedError, Queue, Worker } from "bullmq";
import { createIngestionService, createMineruPdfOcrExecutor, dispatchPendingIngestion, INGESTION_JOB, INGESTION_QUEUE, OcrCapacityDeferredError, resolveMineruExecutorConfig, verifyMineruRuntime, type MineruExecutorConfig, type PdfOcrExecutor } from "@ai-cognitive/ingestion";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export type SourceIngestionQueueOptions = { prefix?: string; concurrency?: number; /** Real OCR fallback executor (04B-3). Resolved once via resolveSourceIngestionOcrExecutor; injected for testability. */ pdfOcrExecutor?: PdfOcrExecutor };
export function createSourceIngestionWorker(environment: Environment, options: SourceIngestionQueueOptions = {}) {
  const storage = new S3CompatibleStorageProvider({ endpoint: environment.S3_ENDPOINT, region: environment.S3_REGION, bucket: environment.S3_BUCKET, accessKey: environment.S3_ACCESS_KEY, secretKey: environment.S3_SECRET_KEY, forcePathStyle: environment.S3_FORCE_PATH_STYLE });
  const service = createIngestionService(storage, { maxUploadBytes: environment.SOURCE_MAX_UPLOAD_BYTES, uploadTtlSeconds: environment.SOURCE_UPLOAD_URL_TTL_SECONDS, maxPdfPages: environment.SOURCE_MAX_PDF_PAGES, completionLeaseMs: environment.SOURCE_UPLOAD_COMPLETION_LEASE_MS, processMaxAttempts: environment.SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS, ...(options.pdfOcrExecutor ? { pdfOcrExecutor: options.pdfOcrExecutor } : {}) });
  const deferralDelayMs = environment.MINERU_CAPACITY_DEFERRAL_DELAY_MS ?? 30_000;
  return new Worker<{ ingestionRunId: string }>(INGESTION_QUEUE, async (job, jobToken) => {
    try {
      await service.processIngestionRun(job.data.ingestionRunId);
    } catch (error) {
      // RF05 P1-02 scheduler contract: the worker defers the BullMQ delivery
      // ONLY for the POST-COMMIT OcrCapacityDeferredError signal, which the
      // ingestion service creates strictly AFTER the atomic PostgreSQL
      // deferral transaction committed. The PRE-COMMIT
      // OcrCapacityDeferralError, message strings, and codes are never
      // scheduler authority. (BullMQ 5.81.3, verified from installed source:
      // moveToDelayed uses skipAttempt:true and DelayedError bypasses
      // moveToFailed — zero BullMQ failure attempts consumed.)
      if (await deferDeliveryOnPostCommitCapacitySignal(error, job, jobToken, deferralDelayMs)) throw new DelayedError();
      throw error;
    }
  }, { connection: createRedisConnection(environment.REDIS_URL), concurrency: options.concurrency ?? environment.WORKER_INGESTION_CONCURRENCY ?? 1, ...(options.prefix ? { prefix: options.prefix } : {}) });
}

/**
 * RF05 P1-02 test/authority seam: moves the delivery to delayed ONLY for the
 * POST-COMMIT OcrCapacityDeferredError signal. Returns true when the delivery
 * was deferred. A generic Error("SOURCE_OCR_HOST_CAPACITY") or the PRE-COMMIT
 * OcrCapacityDeferralError returns false — the caller rethrows and BullMQ
 * treats the delivery as an ordinary failure (consuming its attempt).
 */
export async function deferDeliveryOnPostCommitCapacitySignal(error: unknown, job: { moveToDelayed(timestamp: number, token: string): Promise<unknown> }, jobToken: string | undefined, delayMs: number): Promise<boolean> {
  if (!(error instanceof OcrCapacityDeferredError) || !jobToken) return false;
  await job.moveToDelayed(Date.now() + delayMs, jobToken);
  return true;
}

export type SourceIngestionOcrRuntime = {
  pdfOcrExecutor: PdfOcrExecutor;
  /** Verified runtime configuration for same-host OCR server reconciliation (RF01 P1-06). */
  config: MineruExecutorConfig;
  close(): Promise<void>;
};

/**
 * Production OCR runtime resolution (BOOK-INGESTION-04B-3, RF01 P1-08).
 * Returns undefined when OCR is intentionally unconfigured: production keeps
 * the 04B-2 no-OCR behavior. Malformed explicit MinerU configuration AND a
 * runtime whose --version does not report the pinned 4.0.3 fail fast here, at
 * worker startup — provenance is the verified/pinned authority, never
 * operator-declared text.
 */
export async function resolveSourceIngestionOcrExecutor(environment: Environment): Promise<SourceIngestionOcrRuntime | undefined> {
  const config = resolveMineruExecutorConfig(environment);
  if (!config) return undefined;
  await verifyMineruRuntime(config);
  const runtime = createMineruPdfOcrExecutor(config);
  return { pdfOcrExecutor: runtime.executor, config, close: () => runtime.close() };
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
