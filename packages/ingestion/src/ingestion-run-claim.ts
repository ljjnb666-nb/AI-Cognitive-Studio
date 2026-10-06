import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@ai-cognitive/db";
import { writeRoutingOutcome } from "./ocr-durability.js";
import { SourceError } from "./source-errors.js";

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

/**
 * RF03 P1-03: capacity/deferral transition — the run goes back to QUEUED with
 * its processing-attempt budget restored, transactionally. The proof of
 * correctness for the give-back: claimIngestionRun atomically paired
 * (Job.attemptCount + 1, Job RUNNING, run RUNNING under THIS token); only the
 * live token owner can execute this transition (liveLeasePredicate), exactly
 * once per delivery, and the Job row must still be the one THIS claim moved to
 * RUNNING — so the decrement can never cancel anyone else's consumption.
 * Net effect of a capacity deferral on the durable attempt budget: exactly
 * zero. The scheduler (BullMQ delayed deferral) owns when the delivery
 * returns; PostgreSQL remains the upper-bound authority for real attempts.
 */
export async function transitionRunToDeferred(runId: string, token: string, errorCode: string): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`UPDATE "IngestionRun" SET "status" = 'QUEUED', "errorCode" = ${errorCode}, "executionClaimToken" = NULL, "executionClaimedAt" = NULL, "executionLeaseUntil" = NULL WHERE "id" = ${runId} ${liveLeasePredicate(token)}`;
      if (changed !== 1) throw claimLost;
      const jobs = await tx.$queryRaw<Array<{ attemptCount: number }>>`UPDATE "Job" SET "status" = 'QUEUED', "error" = ${JSON.stringify({ code: errorCode })}::jsonb, "updatedAt" = NOW(), "attemptCount" = GREATEST("attemptCount" - 1, 0) WHERE "id" = (SELECT "jobId" FROM "IngestionRun" WHERE "id" = ${runId}) AND "status" = 'RUNNING' AND "attemptCount" > 0 RETURNING "attemptCount"`;
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

/** Key-order-independent JSON comparison for routing-slot reuse validation. */
function stableRoutingJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, walk(entry)]));
    return input;
  };
  return JSON.stringify(walk(value));
}

/**
 * RF01 P1-03: the non-publish routing outcome and the terminal run transition
 * are owned by the SAME authoritative run claim, in ONE PostgreSQL
 * transaction: lock/verify the run (RUNNING + token + live lease), write the
 * routing outcome only if null (or validate an already-identical one), then
 * transition run + Job terminal. A superseded owner's write changes ZERO
 * durable state — the in-memory ownershipLost flag is never the authority.
 * Reuses the 04B-1 writeRoutingOutcome primitive for the slot itself.
 */
export async function terminalizeRunWithRoutingOutcome(runId: string, token: string, status: IngestionTerminalStatus, errorCode: string, routingGeneration: number, outcome: unknown): Promise<boolean> {
  if (!terminalStatuses.has(status)) throw new Error(`INVALID_INGESTION_TERMINAL_STATUS:${status}`);
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ routingOutcome: unknown }>>`SELECT "routingOutcome" FROM "IngestionRun" WHERE "id" = ${runId} ${liveLeasePredicate(token)} FOR UPDATE`;
      if (locked.length !== 1) throw claimLost;
      const existing = locked[0]!.routingOutcome;
      if (existing == null) {
        if (!await writeRoutingOutcome(runId, routingGeneration, outcome, tx)) throw new Error(SourceError.ROUTING_PLAN_CONFLICT);
      } else if (stableRoutingJson(existing) !== stableRoutingJson(outcome)) {
        throw new Error(SourceError.ROUTING_PLAN_CONFLICT);
      }
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

/**
 * QUEUED runs whose durable attempt budget is exhausted are terminal: no live
 * execution claim exists, so the run (still QUEUED, claim-free) and its QUEUED
 * Job with attemptCount >= maxAttempts CAS to FAILED atomically. A QUEUED run
 * with budget left never matches; the expired-RUNNING helper must not be used
 * for this state because its predicate requires status = RUNNING.
 */
export async function terminalizeExhaustedQueuedIngestionRun(runId: string, maxAttempts: number, errorCode = INGESTION_ATTEMPTS_EXHAUSTED): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`UPDATE "IngestionRun" SET "status" = 'FAILED', "errorCode" = ${errorCode}, "completedAt" = NOW() WHERE "id" = ${runId} AND "status" = 'QUEUED' AND "executionClaimToken" IS NULL`;
      if (changed !== 1) throw claimLost;
      const jobs = await tx.$queryRaw<Array<{ id: string }>>`UPDATE "Job" SET "status" = 'FAILED', "error" = ${JSON.stringify({ code: errorCode })}::jsonb, "completedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = (SELECT "jobId" FROM "IngestionRun" WHERE "id" = ${runId}) AND "status" = 'QUEUED' AND "attemptCount" >= ${maxAttempts} RETURNING "id"`;
      if (jobs.length !== 1) throw claimLost;
      return true;
    });
  } catch (error) {
    if (error === claimLost) return false;
    throw error;
  }
}
