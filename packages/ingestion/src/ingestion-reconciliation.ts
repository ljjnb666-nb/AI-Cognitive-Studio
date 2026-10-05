import { prisma } from "@ai-cognitive/db";
import { INGESTION_ATTEMPTS_EXHAUSTED, terminalizeExhaustedQueuedIngestionRun, terminalizeExpiredIngestionRun } from "./ingestion-run-claim.js";

/**
 * Source-ingestion delivery reconciliation (BOOK-INGESTION-04B-1).
 *
 * Reasons from PostgreSQL first, then inspects BullMQ. The queue is NOT
 * authoritative: Redis state loss may cost attempts, but the durable attempt
 * guard always bounds executions. Three cases:
 *   1. QUEUED run without a live delivery -> (re)enqueue deterministically.
 *   2. RUNNING with expired lease and attempt budget left -> enqueue the
 *      deterministic delivery; its claim reclaims the expired RUNNING row.
 *   3. RUNNING with expired lease and exhausted budget -> terminal FAILED.
 */

export type IngestionDeliveryState = "waiting" | "delayed" | "active" | "completed" | "failed";
export type IngestionReconciliationQueuePort = {
  getJobState(jobId: string): Promise<IngestionDeliveryState | null>;
  remove(jobId: string): Promise<void>;
  add(jobId: string): Promise<void>;
};

export const INGESTION_RECONCILIATION_BATCH_SIZE = 25;
const LIVE_STATES = new Set(["waiting", "delayed", "active"]);

export type IngestionReconciliationResult = { queuedRepairCount: number; expiredRetryableCount: number; expiredTerminalCount: number };

export async function reconcileIngestionDeliveries(options: { queue: IngestionReconciliationQueuePort; maxAttempts: number; batchSize?: number }): Promise<IngestionReconciliationResult> {
  const result: IngestionReconciliationResult = { queuedRepairCount: 0, expiredRetryableCount: 0, expiredTerminalCount: 0 };
  const runs = await prisma.ingestionRun.findMany({
    where: { OR: [{ status: "QUEUED" }, { status: "RUNNING", OR: [{ executionLeaseUntil: null }, { executionLeaseUntil: { lt: new Date() } }] }] },
    orderBy: { createdAt: "asc" },
    take: options.batchSize ?? INGESTION_RECONCILIATION_BATCH_SIZE,
    select: { id: true, status: true, job: { select: { attemptCount: true } } },
  });
  for (const run of runs) {
    const attemptCount = run.job.attemptCount;
    if (run.status === "QUEUED") {
      if (attemptCount >= options.maxAttempts) {
        // A QUEUED run beyond the durable budget is terminal: no live claim can
        // exist, so it CAS-terminalizes here instead of occupying the oldest
        // reconciliation window forever.
        if (await terminalizeExhaustedQueuedIngestionRun(run.id, options.maxAttempts, INGESTION_ATTEMPTS_EXHAUSTED)) result.expiredTerminalCount += 1;
        continue;
      }
      const state = await options.queue.getJobState(run.id);
      if (state && LIVE_STATES.has(state)) continue;
      // A retained failed/completed job with the same deterministic id blocks a
      // plain re-add; remove ONLY the proven non-live record, then re-enqueue.
      if (state) await options.queue.remove(run.id);
      await options.queue.add(run.id);
      result.queuedRepairCount += 1;
      continue;
    }
    // RUNNING with expired lease.
    if (attemptCount >= options.maxAttempts) {
      if (await terminalizeExpiredIngestionRun(run.id)) result.expiredTerminalCount += 1;
      continue;
    }
    const state = await options.queue.getJobState(run.id);
    if (state && LIVE_STATES.has(state)) continue; // a live delivery will reclaim the expired claim
    if (state) await options.queue.remove(run.id);
    await options.queue.add(run.id);
    result.expiredRetryableCount += 1;
  }
  return result;
}
