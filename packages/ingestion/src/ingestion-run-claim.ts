import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@ai-cognitive/db";

/**
 * Durable execution authority for IngestionRun (BOOK-INGESTION-04B-1).
 *
 * PostgreSQL is authoritative; BullMQ only schedules deliveries. A run may
 * execute work only while it is RUNNING with a live, token-matched execution
 * lease. Claimable states are QUEUED and RUNNING-with-expired-lease while the
 * durable attempt budget (Job.attemptCount < max) remains — FAILED is a
 * terminal state and is never claimable.
 */

export const INGESTION_EXECUTION_OWNERSHIP_LOST = "INGESTION_EXECUTION_OWNERSHIP_LOST";
export const INGESTION_EXECUTION_LEASE_EXPIRED = "INGESTION_EXECUTION_LEASE_EXPIRED";
export const INGESTION_ATTEMPTS_EXHAUSTED = "INGESTION_ATTEMPTS_EXHAUSTED";

export const RUN_LEASE_TTL_MS = 120_000;
export const RUN_RENEW_INTERVAL_MS = 30_000;

export type IngestionRunClaim = { token: string; attemptCount: number };

const claimLost = Symbol("ingestion-claim-lost");

const liveLeasePredicate = (token: string) =>
  Prisma.sql`AND "status" = 'RUNNING' AND "executionClaimToken" = ${token} AND "executionLeaseUntil" > NOW()`;

const expiredLeasePredicate = Prisma.sql`("status" = 'QUEUED' OR ("status" = 'RUNNING' AND ("executionLeaseUntil" IS NULL OR "executionLeaseUntil" < NOW())))`;

/**
 * Atomically claims the run for execution: run -> RUNNING with a fresh token
 * and lease, Job -> RUNNING with attemptCount + 1. The whole claim is one
 * short transaction over both rows; if either row cannot transition, the
 * transaction rolls back and the claim reports null. The attempt guard lives
 * in PostgreSQL, so no scheduler state (even a malformed Redis job) can
 * produce more than maxAttempts executions.
 */
export async function claimIngestionRun(runId: string, maxAttempts: number, leaseMs = RUN_LEASE_TTL_MS): Promise<IngestionRunClaim | null> {
  const token = randomUUID();
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "IngestionRun" WHERE "id" = ${runId} AND ${expiredLeasePredicate} FOR UPDATE`;
      if (locked.length !== 1) throw claimLost;
      const claimed = await tx.$executeRaw`UPDATE "IngestionRun" SET "status" = 'RUNNING', "executionClaimToken" = ${token}, "executionClaimedAt" = NOW(), "executionLeaseUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond'), "startedAt" = COALESCE("startedAt", NOW()) WHERE "id" = ${runId} AND ${expiredLeasePredicate}`;
      if (claimed !== 1) throw claimLost;
      const jobs = await tx.$queryRaw<Array<{ attemptCount: number }>>`UPDATE "Job" SET "status" = 'RUNNING', "attemptCount" = "attemptCount" + 1, "startedAt" = COALESCE("startedAt", NOW()), "updatedAt" = NOW() WHERE "id" = (SELECT "jobId" FROM "IngestionRun" WHERE "id" = ${runId}) AND "status" IN ('QUEUED', 'RUNNING') AND "attemptCount" < ${maxAttempts} RETURNING "attemptCount"`;
      if (jobs.length !== 1) throw claimLost;
      return { token, attemptCount: Number(jobs[0]!.attemptCount) };
    });
  } catch (error) {
    if (error === claimLost) return null;
    throw error;
  }
}

/** Extends the live lease; false means ownership was lost (0 rows). */
export async function renewIngestionRunClaim(runId: string, token: string, leaseMs = RUN_LEASE_TTL_MS): Promise<boolean> {
  const changed = await prisma.$executeRaw`UPDATE "IngestionRun" SET "executionLeaseUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond') WHERE "id" = ${runId} ${liveLeasePredicate(token)}`;
  return changed === 1;
}

/**
 * Publication fence: locks the authoritative run row inside the caller's
 * transaction and asserts live ownership. Exactly one row must come back; the
 * row lock keeps another claimant from reclaiming until the transaction ends.
 */
export async function lockRunForPublication(tx: Prisma.TransactionClient, runId: string, token: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "IngestionRun" WHERE "id" = ${runId} ${liveLeasePredicate(token)} FOR UPDATE`;
  return rows.length === 1;
}

/**
 * Retryable failure under live ownership: run RUNNING -> QUEUED with the
 * transient error recorded and the claim cleared, Job RUNNING -> QUEUED. One
 * transaction; BullMQ's configured attempt policy schedules the next
 * execution, which re-claims the QUEUED run.
 */
export async function transitionRunToRetryable(runId: string, token: string, errorCode: string): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`UPDATE "IngestionRun" SET "status" = 'QUEUED', "errorCode" = ${errorCode}, "executionClaimToken" = NULL, "executionClaimedAt" = NULL, "executionLeaseUntil" = NULL WHERE "id" = ${runId} ${liveLeasePredicate(token)}`;
      if (changed !== 1) throw claimLost;
      const jobs = await tx.$queryRaw<Array<{ id: string }>>`UPDATE "Job" SET "status" = 'QUEUED', "error" = ${JSON.stringify({ code: errorCode })}::jsonb, "updatedAt" = NOW() WHERE "id" = (SELECT "jobId" FROM "IngestionRun" WHERE "id" = ${runId}) AND "status" = 'RUNNING' RETURNING "id"`;
      if (jobs.length !== 1) throw claimLost;
      return true;
    });
  } catch (error) {
    if (error === claimLost) return false;
    throw error;
  }
}

/** Terminal failure statuses a run may take (Job always becomes FAILED). */
export type IngestionTerminalStatus = "FAILED" | "REJECTED" | "OCR_REQUIRED" | "PASSWORD_REQUIRED";

const terminalStatuses = new Set(["FAILED", "REJECTED", "OCR_REQUIRED", "PASSWORD_REQUIRED"]);

/** Terminal failure under live ownership; one transaction over run + Job. */
export async function transitionRunToTerminal(runId: string, token: string, status: IngestionTerminalStatus, errorCode: string): Promise<boolean> {
  if (!terminalStatuses.has(status)) throw new Error(`INVALID_INGESTION_TERMINAL_STATUS:${status}`);
  try {
    return await prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`UPDATE "IngestionRun" SET "status" = ${status}::"IngestionStatus", "errorCode" = ${errorCode}, "completedAt" = NOW(), "executionClaimToken" = NULL, "executionClaimedAt" = NULL, "executionLeaseUntil" = NULL WHERE "id" = ${runId} ${liveLeasePredicate(token)}`;
      if (changed !== 1) throw claimLost;
      const jobs = await tx.$queryRaw<Array<{ id: string }>>`UPDATE "Job" SET "status" = 'FAILED', "error" = ${JSON.stringify({ code: errorCode })}::jsonb, "completedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = (SELECT "jobId" FROM "IngestionRun" WHERE "id" = ${runId}) AND "status" = 'RUNNING' RETURNING "id"`;
      if (jobs.length !== 1) throw claimLost;
      return true;
    });
  } catch (error) {
    if (error === claimLost) return false;
    throw error;
  }
}

/** Success terminalization, executed inside the caller's publication transaction. */
export async function completeRunSuccess(tx: Prisma.TransactionClient, runId: string, token: string): Promise<void> {
  const changed = await tx.$executeRaw`UPDATE "IngestionRun" SET "status" = 'SUCCEEDED', "completedAt" = NOW(), "executionClaimToken" = NULL, "executionClaimedAt" = NULL, "executionLeaseUntil" = NULL WHERE "id" = ${runId} AND "status" = 'RUNNING' AND "executionClaimToken" = ${token}`;
  if (changed !== 1) throw new Error(INGESTION_EXECUTION_OWNERSHIP_LOST);
  const jobs = await tx.$queryRaw<Array<{ id: string }>>`UPDATE "Job" SET "status" = 'SUCCEEDED', "progress" = 100, "completedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = (SELECT "jobId" FROM "IngestionRun" WHERE "id" = ${runId}) AND "status" = 'RUNNING' RETURNING "id"`;
  if (jobs.length !== 1) throw new Error(INGESTION_EXECUTION_OWNERSHIP_LOST);
}

/**
 * CASE-3 reconciliation terminalization: an expired RUNNING run whose attempt
 * budget is exhausted becomes FAILED without any live owner. CAS-guarded: only
 * a still-RUNNING, still-expired run transitions; reclaimed, live or terminal
 * runs are never touched.
 */
export async function terminalizeExpiredIngestionRun(runId: string, errorCode = INGESTION_EXECUTION_LEASE_EXPIRED): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`UPDATE "IngestionRun" SET "status" = 'FAILED', "errorCode" = ${errorCode}, "completedAt" = NOW() WHERE "id" = ${runId} AND "status" = 'RUNNING' AND ("executionLeaseUntil" IS NULL OR "executionLeaseUntil" < NOW())`;
      if (changed !== 1) throw claimLost;
      const jobs = await tx.$queryRaw<Array<{ id: string }>>`UPDATE "Job" SET "status" = 'FAILED', "error" = ${JSON.stringify({ code: errorCode })}::jsonb, "completedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = (SELECT "jobId" FROM "IngestionRun" WHERE "id" = ${runId}) AND "status" = 'RUNNING' RETURNING "id"`;
      if (jobs.length !== 1) throw claimLost;
      return true;
    });
  } catch (error) {
    if (error === claimLost) return false;
    throw error;
  }
}
