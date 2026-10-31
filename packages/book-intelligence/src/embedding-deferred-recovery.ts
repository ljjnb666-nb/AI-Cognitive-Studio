/**
 * Bounded, receipt-only recovery of BookAnalysis runs deferred while the
 * previous Gateway owner was still executing remotely. Not a generic retry:
 * unknown outcomes and malformed receipts must remain quarantined.
 */
import { prisma } from "../../db/src/index.js";
import { logger } from "@ai-cognitive/shared";
import { bookAnalysisEmbeddingIdempotencyKey, isBookAnalysisEmbeddingIdempotencyKey } from "./gateway-materialization.js";
import { rearmBookAnalysisRunById } from "./pipeline.js";

export const BOOK_EMBEDDING_DEFERRED_CODE = "BOOK_ANALYSIS_EMBEDDING_GATEWAY_DEFERRED";
export const BOOK_EMBEDDING_AUTO_REARM_MIN_AGE_MS = 45_000;
export type DeferredEmbeddingRecoveryCursor = { completedAt: Date; id: string };
export type DeferredEmbeddingRecoveryResult = {
  nextCursor: DeferredEmbeddingRecoveryCursor | null;
  discovered: number; recovered: number; skipped: number; capacityBlocked: number; raced: number; errors: number;
};

export async function recoverSettledDeferredBookEmbeddings(options: {
  now?: Date;
  limit?: number;
  topic?: string;
  cursor?: DeferredEmbeddingRecoveryCursor | null;
} = {}): Promise<DeferredEmbeddingRecoveryResult> {
  const limit = options.limit ?? 25;
  const now = options.now ?? new Date();
  const cursor = options.cursor ?? null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25 ||
      !Number.isFinite(now.getTime()) ||
      (cursor !== null && (!(cursor.completedAt instanceof Date) ||
        !Number.isFinite(cursor.completedAt.getTime()) || !cursor.id))) throw new RangeError("BOOK_EMBEDDING_AUTO_REARM_SCAN_INVALID");
  const cutoff = new Date(now.getTime() - BOOK_EMBEDDING_AUTO_REARM_MIN_AGE_MS);
  // Generation zero only: one automatic retry at most per BookAnalysisRun.
  // Forward keyset pagination prevents a fixed collection of quarantined
  // rows from starving later eligible records forever.
  const runs = await prisma.bookAnalysisRun.findMany({
    where: {
      status: "FAILED",
      analysisStage: "EMBEDDINGS",
      errorCode: BOOK_EMBEDDING_DEFERRED_CODE,
      dispatchGeneration: 0,
      completedAt: { lte: cutoff },
      ...(cursor ? { OR: [
        { completedAt: { gt: cursor.completedAt } },
        { completedAt: cursor.completedAt, id: { gt: cursor.id } },
      ] } : {}),
      job: { is: { type: "book.analysis", status: "FAILED" } },
    },
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, workspaceId: true, jobId: true, completedAt: true },
  });
  const result: DeferredEmbeddingRecoveryResult = {
    nextCursor: runs.length === limit ? { completedAt: runs[runs.length - 1]!.completedAt!, id: runs[runs.length - 1]!.id } : null,
    discovered: runs.length, recovered: 0, skipped: 0, capacityBlocked: 0, raced: 0, errors: 0,
  };
  for (const run of runs) {
    try {
      const base = bookAnalysisEmbeddingIdempotencyKey(run.id);
      const invocations = await prisma.providerInvocation.findMany({
        where: { workspaceId: run.workspaceId, idempotencyKey: { startsWith: base } },
        select: { id: true, status: true, snapshotId: true, idempotencyKey: true },
        take: 129,
      });
      if (!invocations.length || invocations.length > 128 ||
          invocations.some(invocation =>
            !isBookAnalysisEmbeddingIdempotencyKey(invocation.idempotencyKey, run.id) ||
            invocation.status !== "SUCCEEDED")) {
        result.skipped++;
        continue;
      }
      let pending = 0;
      let receiptsSafe = true;
      for (const invocation of invocations) {
        const receipt = await prisma.providerEmbeddingResult.findUnique({
          where: { invocationId: invocation.id },
        });
        if (!receipt || receipt.workspaceId !== run.workspaceId ||
            receipt.snapshotId !== invocation.snapshotId) {
          receiptsSafe = false; break;
        }
        if (receipt.consumedAt === null && receipt.purgedAt === null &&
            receipt.consumerKind === null && receipt.consumerKey === null &&
            receipt.consumerFingerprint === null &&
            receipt.ciphertext && receipt.iv && receipt.authTag && receipt.keyVersion) {
          pending++;
        } else if (receipt.consumedAt !== null && receipt.purgedAt !== null &&
                   receipt.consumerKind === "BOOK_ANALYSIS_EMBEDDINGS" &&
                   receipt.consumerKey === run.id && receipt.consumerFingerprint &&
                   receipt.ciphertext === null && receipt.iv === null &&
                   receipt.authTag === null && receipt.keyVersion === null) {
          // Previously consumed, correctly purged batch is still authoritative.
        } else {
          receiptsSafe = false; break;
        }
      }
      if (!receiptsSafe || pending === 0) { result.skipped++; continue; }
      // Existing PostgreSQL generation CAS and workspace capacity gate.
      // Competing sweepers or manual rearm can create at most one new outbox.
      const changed = await rearmBookAnalysisRunById(run.id, 0, options.topic);
      if (changed === "REARMED") result.recovered++;
      else if (changed === "CAPACITY_BLOCKED") result.capacityBlocked++;
      else result.raced++;
    } catch {
      result.errors++;
      // Never export provider, database, or private receipt errors to CI logs.
      logger.warn("book.embedding.deferred_auto_rearm.failed", { errorCode: "RECOVERY_ATTEMPT_FAILED" });
    }
  }
  const { nextCursor: _nextCursor, ...safeSummary } = result;
  logger.info("book.embedding.deferred_auto_rearm.completed", safeSummary);
  return result;
}
