import { prisma } from "@ai-cognitive/db";

export type OutboxQueue<T> = { add(name: string, payload: T, options: { jobId: string }): Promise<unknown> };
export const MAX_PERSISTED_DISPATCH_GENERATION = 2_147_483_647;
type OutboxTransaction = Pick<typeof prisma, "$executeRaw" | "$queryRaw" | "ingestionRun" | "bookAnalysisRun" | "podcastGenerationRun" | "shortVideoGenerationRun" | "job">;
export type DispatchOptions<T> = { topic: string; queue: OutboxQueue<T>; jobName: string; parse(payload: unknown): T; jobId(payload: T): string; afterDispatch?(tx: OutboxTransaction, payload: T, jobId: string): Promise<void>; batchSize?: number; leaseMs?: number; maxAttempts?: number; dispatchConcurrency?: number; aggregateIds?: string[]; beforeFinalize?: (eventId: string) => Promise<void> | void };

/** Historical events omit generation; newly written events must carry a safe non-negative integer. */
export function normalizeDispatchGeneration(payload: Record<string, unknown>): number {
  if (!Object.hasOwn(payload, "dispatchGeneration")) return 0;
  const value = payload.dispatchGeneration;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("OUTBOX_PAYLOAD_INVALID");
  return value;
}

/** Shared PostgreSQL-authoritative transactional-outbox claim, enqueue and finalization protocol. */
export async function dispatchPendingOutbox<T>(options: DispatchOptions<T>): Promise<number> {
  const batchSize = options.batchSize ?? 100, leaseMs = options.leaseMs ?? 60_000, maxAttempts = options.maxAttempts ?? 5;
  await prisma.$executeRaw`UPDATE "OutboxEvent" SET "status" = 'FAILED'::"OutboxStatus", "leaseUntil" = NULL, "claimToken" = NULL, "lastError" = COALESCE("lastError", 'OUTBOX_MAX_ATTEMPTS_EXCEEDED'), "updatedAt" = NOW() WHERE "topic" = ${options.topic} AND "status" = 'PROCESSING'::"OutboxStatus" AND "leaseUntil" < NOW() AND "attemptCount" >= ${maxAttempts}`;
  const events = await prisma.$queryRaw<Array<{ id: string; payload: unknown; claimToken: string }>>`
    WITH candidates AS (SELECT "id" FROM "OutboxEvent" WHERE "topic" = ${options.topic} AND (${options.aggregateIds ?? []}::text[] = '{}'::text[] OR "aggregateId" = ANY(${options.aggregateIds ?? []}::text[])) AND ("status" = 'PENDING'::"OutboxStatus" OR ("status" = 'PROCESSING'::"OutboxStatus" AND "leaseUntil" < NOW())) AND "attemptCount" < ${maxAttempts} ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT ${batchSize})
    UPDATE "OutboxEvent" AS event SET "status" = 'PROCESSING'::"OutboxStatus", "claimedAt" = NOW(), "claimToken" = md5(random()::text || clock_timestamp()::text || event."id"), "leaseUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond'), "attemptCount" = event."attemptCount" + 1, "updatedAt" = NOW() FROM candidates WHERE event."id" = candidates."id" RETURNING event."id", event."payload", event."claimToken"`;
  const concurrency = options.dispatchConcurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("OUTBOX_DISPATCH_CONCURRENCY_INVALID");
  let next = 0;
  const dispatchOne = async (event: { id: string; payload: unknown; claimToken: string }) => {
    try {
      const payload = options.parse(event.payload), jobId = options.jobId(payload);
      await options.queue.add(options.jobName, payload, { jobId });
      await options.beforeFinalize?.(event.id);
      await prisma.$transaction(async (tx) => {
        const marked = await tx.$executeRaw`UPDATE "OutboxEvent" SET "status" = 'DISPATCHED'::"OutboxStatus", "dispatchedAt" = NOW(), "leaseUntil" = NULL, "claimToken" = NULL, "updatedAt" = NOW() WHERE "id" = ${event.id} AND "status" = 'PROCESSING'::"OutboxStatus" AND "claimToken" = ${event.claimToken}`;
        if (marked !== 1) throw new Error("OUTBOX_CLAIM_LOST");
        await options.afterDispatch?.(tx, payload, jobId);
      });
    } catch (error) {
      const lastError = error instanceof Error ? error.message.slice(0, 2000) : "UNEXPECTED_ERROR";
      await prisma.$executeRaw`UPDATE "OutboxEvent" SET "status" = CASE WHEN "attemptCount" >= ${maxAttempts} THEN 'FAILED'::"OutboxStatus" ELSE 'PENDING'::"OutboxStatus" END, "leaseUntil" = NULL, "claimToken" = NULL, "lastError" = ${lastError}, "updatedAt" = NOW() WHERE "id" = ${event.id} AND "status" = 'PROCESSING'::"OutboxStatus" AND "claimToken" = ${event.claimToken}`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, events.length) }, async () => { while (next < events.length) { const event = events[next++]; if (event) await dispatchOne(event); } }));
  return events.length;
}
