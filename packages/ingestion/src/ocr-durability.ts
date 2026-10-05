import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";

/**
 * Durable OCR ownership/checkpoint primitives (BOOK-INGESTION-04B-1).
 *
 * Pure PostgreSQL authority — no process execution in this phase (04B-3 adds
 * the MinerU executor). Every write is token/lease fenced so a stale worker
 * can never mutate newer checkpoint state, and every predicate carries the
 * workspace/source lineage so cross-tenant writes fail closed (0 rows).
 */

export const OCR_HOST_LEASE_TTL_MS = 60_000;
export const OCR_PAGE_LEASE_TTL_MS = 180_000;
export const OCR_PAGE_MAX_ATTEMPTS = 3;

export type OcrHostLeaseGrant = { claimToken: string; leaseUntil: Date };

/**
 * Atomically acquires the per-host OCR capacity slot. INSERT with a
 * conditional ON CONFLICT UPDATE: a live lease held by another token refuses
 * the takeover (0 rows), an expired lease is claimable. Advisory locks are
 * deliberately avoided — the row lease survives pool reconnects.
 */
export async function acquireOcrHostLease(hostId: string, leaseMs = OCR_HOST_LEASE_TTL_MS, hostMetadata?: Record<string, unknown>): Promise<OcrHostLeaseGrant | null> {
  const claimToken = randomUUID();
  const rows = await prisma.$queryRaw<Array<{ claimToken: string; leaseUntil: Date }>>`
    INSERT INTO "OcrHostLease" ("hostId", "claimToken", "claimedAt", "leaseUntil", "hostMetadata", "updatedAt")
    VALUES (${hostId}, ${claimToken}, NOW(), NOW() + (${leaseMs} * INTERVAL '1 millisecond'), ${hostMetadata ? JSON.stringify(hostMetadata) : null}::jsonb, NOW())
    ON CONFLICT ("hostId") DO UPDATE SET
      "claimToken" = EXCLUDED."claimToken", "claimedAt" = EXCLUDED."claimedAt", "leaseUntil" = EXCLUDED."leaseUntil",
      "hostMetadata" = EXCLUDED."hostMetadata", "updatedAt" = NOW()
    WHERE "OcrHostLease"."leaseUntil" IS NULL OR "OcrHostLease"."leaseUntil" < NOW()
    RETURNING "claimToken", "leaseUntil"`;
  return rows.length === 1 ? { claimToken: rows[0]!.claimToken, leaseUntil: rows[0]!.leaseUntil } : null;
}

/** Renewal requires hostId + claimToken + still-live lease; stale renewals are no-ops. */
export async function renewOcrHostLease(hostId: string, claimToken: string, leaseMs = OCR_HOST_LEASE_TTL_MS): Promise<boolean> {
  const changed = await prisma.$executeRaw`UPDATE "OcrHostLease" SET "leaseUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond'), "updatedAt" = NOW() WHERE "hostId" = ${hostId} AND "claimToken" = ${claimToken} AND "leaseUntil" > NOW()`;
  return changed === 1;
}

/** Release requires hostId + claimToken; a stale owner can never release a newer owner's lease. */
export async function releaseOcrHostLease(hostId: string, claimToken: string): Promise<boolean> {
  const changed = await prisma.$executeRaw`UPDATE "OcrHostLease" SET "claimToken" = NULL, "claimedAt" = NULL, "leaseUntil" = NULL, "updatedAt" = NOW() WHERE "hostId" = ${hostId} AND "claimToken" = ${claimToken}`;
  return changed === 1;
}

export type OcrPageIntent = { physicalPageIndex: number };

/** Creates PENDING checkpoint intents for the routing plan's OCR pages (idempotent). */
export async function createOcrPageIntents(input: { workspaceId: string; sourceDocumentId: string; ingestionRunId: string; routingGeneration: number; pages: OcrPageIntent[] }): Promise<number> {
  if (input.pages.length === 0) return 0;
  const result = await prisma.ocrPageAttempt.createMany({
    data: input.pages.map((page) => ({ workspaceId: input.workspaceId, sourceDocumentId: input.sourceDocumentId, ingestionRunId: input.ingestionRunId, physicalPageIndex: page.physicalPageIndex, routingGeneration: input.routingGeneration })),
    skipDuplicates: true,
  });
  return result.count;
}

export type OcrPageClaim = { claimToken: string; attemptCount: number };

/**
 * Claims one page checkpoint for execution: PENDING (or expired RUNNING) ->
 * RUNNING(token), attemptCount + 1. Budget-guarded in PostgreSQL; the
 * workspace lineage in the predicate makes cross-tenant claims fail closed.
 */
export async function claimOcrPageAttempt(input: { workspaceId: string; sourceDocumentId: string; ingestionRunId: string; physicalPageIndex: number; routingGeneration: number; parserName: string; parserVersion: string; parserMode?: string | null; modelRevision?: string | null; maxAttempts?: number; leaseMs?: number }): Promise<OcrPageClaim | null> {
  const maxAttempts = input.maxAttempts ?? OCR_PAGE_MAX_ATTEMPTS;
  const leaseMs = input.leaseMs ?? OCR_PAGE_LEASE_TTL_MS;
  const claimToken = randomUUID();
  const rows = await prisma.$queryRaw<Array<{ attemptCount: number }>>`
    UPDATE "OcrPageAttempt" SET
      "status" = 'RUNNING', "claimToken" = ${claimToken}, "claimedAt" = NOW(), "leaseUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
      "attemptCount" = "attemptCount" + 1,
      "parserName" = ${input.parserName}, "parserVersion" = ${input.parserVersion}, "parserMode" = ${input.parserMode ?? null}, "modelRevision" = ${input.modelRevision ?? null},
      "errorCode" = NULL
    WHERE "workspaceId" = ${input.workspaceId} AND "sourceDocumentId" = ${input.sourceDocumentId}
      AND "ingestionRunId" = ${input.ingestionRunId} AND "physicalPageIndex" = ${input.physicalPageIndex} AND "routingGeneration" = ${input.routingGeneration}
      AND "attemptCount" < ${maxAttempts}
      AND (
        ("status" = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
        OR ("status" = 'RUNNING' AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW()))
      )
    RETURNING "attemptCount"`;
  return rows.length === 1 ? { claimToken, attemptCount: Number(rows[0]!.attemptCount) } : null;
}

/** Owner-only success commit; stale/expired completions fail closed (0 rows). */
export async function completeOcrPageAttempt(input: { workspaceId: string; ingestionRunId: string; physicalPageIndex: number; routingGeneration: number; claimToken: string; authoritativeArtifactKey: string; textSha256: string; durationMs: number }): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE "OcrPageAttempt" SET "status" = 'SUCCEEDED', "authoritativeArtifactKey" = ${input.authoritativeArtifactKey}, "textSha256" = ${input.textSha256}, "durationMs" = ${input.durationMs}, "errorCode" = NULL, "updatedAt" = NOW()
    WHERE "workspaceId" = ${input.workspaceId} AND "ingestionRunId" = ${input.ingestionRunId}
      AND "physicalPageIndex" = ${input.physicalPageIndex} AND "routingGeneration" = ${input.routingGeneration}
      AND "status" = 'RUNNING' AND "claimToken" = ${input.claimToken} AND "leaseUntil" > NOW()`;
  return changed === 1;
}

export type OcrPageFailureKind = "transient" | "terminal";

/**
 * Records a page failure under live ownership. Transient failures requeue to
 * PENDING while attempt budget remains and become FAILED when exhausted;
 * deterministic failures go straight to FAILED. The page lease must still be
 * live — a worker that lost its lease writes nothing.
 */
export async function failOcrPageAttempt(input: { workspaceId: string; ingestionRunId: string; physicalPageIndex: number; routingGeneration: number; claimToken: string; errorCode: string; kind: OcrPageFailureKind; nextAttemptAt?: Date; maxAttempts?: number }): Promise<boolean> {
  const maxAttempts = input.maxAttempts ?? OCR_PAGE_MAX_ATTEMPTS;
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ attemptCount: number }>>`
      UPDATE "OcrPageAttempt" SET "errorCode" = ${input.errorCode}, "updatedAt" = NOW()
      WHERE "workspaceId" = ${input.workspaceId} AND "ingestionRunId" = ${input.ingestionRunId}
        AND "physicalPageIndex" = ${input.physicalPageIndex} AND "routingGeneration" = ${input.routingGeneration}
        AND "status" = 'RUNNING' AND "claimToken" = ${input.claimToken} AND "leaseUntil" > NOW()
      RETURNING "attemptCount"`;
    if (rows.length !== 1) return false;
    const exhausted = input.kind === "terminal" || Number(rows[0]!.attemptCount) >= maxAttempts;
    const changed = exhausted
      ? await tx.$executeRaw`UPDATE "OcrPageAttempt" SET "status" = 'FAILED', "leaseUntil" = NULL, "updatedAt" = NOW() WHERE "workspaceId" = ${input.workspaceId} AND "ingestionRunId" = ${input.ingestionRunId} AND "physicalPageIndex" = ${input.physicalPageIndex} AND "routingGeneration" = ${input.routingGeneration} AND "claimToken" = ${input.claimToken}`
      : await tx.$executeRaw`UPDATE "OcrPageAttempt" SET "status" = 'PENDING', "claimToken" = NULL, "claimedAt" = NULL, "leaseUntil" = NULL, "nextAttemptAt" = ${input.nextAttemptAt ?? null}, "updatedAt" = NOW() WHERE "workspaceId" = ${input.workspaceId} AND "ingestionRunId" = ${input.ingestionRunId} AND "physicalPageIndex" = ${input.physicalPageIndex} AND "routingGeneration" = ${input.routingGeneration} AND "claimToken" = ${input.claimToken}`;
    return changed === 1;
  });
}

// ---------------------------------------------------------------------------
// OCR server instance durable identity (no process execution in this phase).
// ---------------------------------------------------------------------------

export type OcrServerEndpoint = { pid: number; serverId: string; transports: Array<Record<string, unknown>> };

/** Persists the pre-launch STARTING row (endpoint identity intentionally absent). */
export async function createOcrServerInstance(input: { workspaceId: string; sourceDocumentId: string; ingestionRunId: string; hostId: string; hostClaimToken: string; runExecutionToken: string; mineruHome: string }): Promise<string | null> {
  try {
    const row = await prisma.ocrServerInstance.create({
      data: { workspaceId: input.workspaceId, sourceDocumentId: input.sourceDocumentId, ingestionRunId: input.ingestionRunId, hostId: input.hostId, hostClaimToken: input.hostClaimToken, runExecutionToken: input.runExecutionToken, mineruHome: input.mineruHome, status: "STARTING" },
      select: { id: true },
    });
    return row.id;
  } catch {
    // hostClaimToken is unique: a duplicate claim must not fabricate a second instance identity.
    return null;
  }
}

/** STARTING -> RUNNING: fills the validated endpoint identity (status-dependent contract). */
export async function recordOcrServerEndpoint(input: { hostClaimToken: string; endpoint: OcrServerEndpoint }): Promise<boolean> {
  const changed = await prisma.ocrServerInstance.updateMany({
    where: { hostClaimToken: input.hostClaimToken, status: "STARTING" },
    data: { pid: input.endpoint.pid, serverId: input.endpoint.serverId, transports: input.endpoint.transports as object, status: "RUNNING", startedAt: new Date(), lastObservedAt: new Date() },
  });
  return changed.count === 1;
}

/** Late owners may transition only their own instance row (hostClaimToken-scoped). */
export async function markOcrServerStatus(hostClaimToken: string, status: "STOPPING" | "STOPPED" | "ORPHANED", terminationReason?: string): Promise<boolean> {
  const changed = await prisma.ocrServerInstance.updateMany({
    where: { hostClaimToken, status: { not: "STOPPED" } },
    data: { status, ...(status === "STOPPED" || status === "ORPHANED" ? { stoppedAt: new Date() } : {}), lastObservedAt: new Date(), ...(terminationReason ? { terminationReason } : {}) },
  });
  return changed.count === 1;
}

/**
 * Status-dependent endpoint contract (service/domain layer, per 04B-0): a
 * RUNNING/STOPPING instance must carry its validated endpoint identity;
 * STARTING may precede the endpoint; STOPPED retains whatever existed.
 */
export function validateOcrServerInstanceContract(row: { status: string; pid: number | null; serverId: string | null; transports: unknown }): string[] {
  const errors: string[] = [];
  const hasEndpoint = row.pid !== null && row.serverId !== null && row.transports !== null && row.transports !== undefined;
  if ((row.status === "RUNNING" || row.status === "STOPPING") && !hasEndpoint) errors.push("OCR_SERVER_ENDPOINT_REQUIRED");
  return errors;
}

/** Same-host reconciler discovery for 04B-3 (durable evidence, not live handles). */
export async function listReconcilableOcrServerInstances(hostId: string): Promise<Array<{ id: string; hostClaimToken: string; mineruHome: string; pid: number | null; serverId: string | null; status: string }>> {
  return prisma.ocrServerInstance.findMany({
    where: { hostId, status: { in: ["STARTING", "RUNNING", "STOPPING", "ORPHANED"] } },
    select: { id: true, hostClaimToken: true, mineruHome: true, pid: true, serverId: true, status: true },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Routing durability columns: write-once plan, one-way terminal outcome.
// ---------------------------------------------------------------------------

/** Write-once: the routing plan can never be mutated once persisted. */
export async function writeRoutingPlan(runId: string, routingGeneration: number, plan: unknown): Promise<boolean> {
  const changed = await prisma.$executeRaw`UPDATE "IngestionRun" SET "routingGeneration" = ${routingGeneration}, "routingPlan" = ${JSON.stringify(plan)}::jsonb WHERE "id" = ${runId} AND "routingPlan" IS NULL`;
  return changed === 1;
}

/** One-way: a null routingOutcome may be filled exactly once, for the plan's own generation. */
export async function writeRoutingOutcome(runId: string, routingGeneration: number, outcome: unknown): Promise<boolean> {
  const changed = await prisma.$executeRaw`UPDATE "IngestionRun" SET "routingOutcome" = ${JSON.stringify(outcome)}::jsonb WHERE "id" = ${runId} AND "routingGeneration" = ${routingGeneration} AND "routingOutcome" IS NULL AND "routingPlan" IS NOT NULL`;
  return changed === 1;
}
