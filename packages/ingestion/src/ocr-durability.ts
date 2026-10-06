import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@ai-cognitive/db";

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
 * Host OCR capacity invariant (RF03 P1-02): ONE authoritative live/possibly-
 * live MinerU server per host capacity slot. A lease is grantable ONLY when
 * BOTH predicates hold in the SAME atomic statement:
 *  1. the slot itself is free or its lease expired, AND
 *  2. NO unresolved OcrServerInstance exists for the host (STARTING / RUNNING
 *     / STOPPING / ORPHANED) — a server whose process ownership has not been
 *     durably closed may still be alive, so the capacity stays poisoned even
 *     when the (expired) lease row looks free. ORPHANED rows therefore act as
 *     a capacity poison: "manual intervention required" must actually stop
 *     production from spawning a second server beside the unresolved one.
 * STOPPED rows never block. The currently executing claim fits this ordering:
 * it acquires the lease BEFORE creating its own server row; renewal/release
 * stay token-fenced.
 */
export async function acquireOcrHostLease(hostId: string, leaseMs = OCR_HOST_LEASE_TTL_MS, hostMetadata?: Record<string, unknown>): Promise<OcrHostLeaseGrant | null> {
  const claimToken = randomUUID();
  const rows = await prisma.$queryRaw<Array<{ claimToken: string; leaseUntil: Date }>>`
    INSERT INTO "OcrHostLease" ("hostId", "claimToken", "claimedAt", "leaseUntil", "hostMetadata", "updatedAt")
    SELECT ${hostId}, ${claimToken}, NOW(), NOW() + (${leaseMs} * INTERVAL '1 millisecond'), ${hostMetadata ? JSON.stringify(hostMetadata) : null}::jsonb, NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "OcrServerInstance" instance
      WHERE instance."hostId" = ${hostId}
        AND instance."status" IN ('STARTING', 'RUNNING', 'STOPPING', 'ORPHANED')
    )
    ON CONFLICT ("hostId") DO UPDATE SET
      "claimToken" = EXCLUDED."claimToken", "claimedAt" = EXCLUDED."claimedAt", "leaseUntil" = EXCLUDED."leaseUntil",
      "hostMetadata" = EXCLUDED."hostMetadata", "updatedAt" = NOW()
    WHERE ("OcrHostLease"."leaseUntil" IS NULL OR "OcrHostLease"."leaseUntil" < NOW())
      AND NOT EXISTS (
        SELECT 1 FROM "OcrServerInstance" instance
        WHERE instance."hostId" = EXCLUDED."hostId"
          AND instance."status" IN ('STARTING', 'RUNNING', 'STOPPING', 'ORPHANED')
      )
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
 *
 * RF01 P1-02: a caller that holds the CURRENT IngestionRun execution claim may
 * additionally take over a RUNNING page whose lease is still live. The takeover
 * branch is authorized by the run row itself (same statement, same snapshot):
 * it matches only while the caller's token is the run's live executionClaimToken,
 * which by construction means the live page lease belongs to a superseded run
 * execution — a live owner can never reach this branch for its own claim (it
 * holds the only live run token). Page token fencing for completion/failure is
 * unchanged; no migration, no second authority.
 */
export async function claimOcrPageAttempt(input: { workspaceId: string; sourceDocumentId: string; ingestionRunId: string; physicalPageIndex: number; routingGeneration: number; parserName: string; parserVersion: string; parserMode?: string | null; modelRevision?: string | null; maxAttempts?: number; leaseMs?: number; runExecutionToken?: string | null }): Promise<OcrPageClaim | null> {
  const maxAttempts = input.maxAttempts ?? OCR_PAGE_MAX_ATTEMPTS;
  const leaseMs = input.leaseMs ?? OCR_PAGE_LEASE_TTL_MS;
  const claimToken = randomUUID();
  const takeoverToken = input.runExecutionToken ?? null;
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
        OR (
          "status" = 'RUNNING' AND "leaseUntil" IS NOT NULL AND "leaseUntil" >= NOW()
          AND ${takeoverToken}::text IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM "IngestionRun" run
            WHERE run."id" = "OcrPageAttempt"."ingestionRunId"
              AND run."executionClaimToken" = ${takeoverToken}
              AND run."status" = 'RUNNING'
              AND run."executionLeaseUntil" > NOW()
          )
        )
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
 * RF03 P1-03: HOST CAPACITY unavailable is DEFERRAL, not processing failure.
 * Releases the claim WITHOUT consuming the page attempt budget, in ONE
 * transactional proof: the caller must still hold the live page claim token
 * (predicate enforces it), and the attemptCount it consumed on claim is given
 * back in the same statement (GREATEST floor guards against misuse). The page
 * returns to PENDING, immediately claimable, with NO future nextAttemptAt —
 * the scheduler's deferral cadence is the single retry clock (RF01 P1-01).
 * Only the live owner can defer, exactly one give-back per claim, so the net
 * page-attempt effect of a capacity deferral is exactly zero.
 */
export async function deferOcrPageAttempt(input: { workspaceId: string; ingestionRunId: string; physicalPageIndex: number; routingGeneration: number; claimToken: string; errorCode: string }): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE "OcrPageAttempt" SET
      "status" = 'PENDING', "claimToken" = NULL, "claimedAt" = NULL, "leaseUntil" = NULL,
      "nextAttemptAt" = NULL, "errorCode" = ${input.errorCode}, "updatedAt" = NOW(),
      "attemptCount" = GREATEST("attemptCount" - 1, 0)
    WHERE "workspaceId" = ${input.workspaceId} AND "ingestionRunId" = ${input.ingestionRunId}
      AND "physicalPageIndex" = ${input.physicalPageIndex} AND "routingGeneration" = ${input.routingGeneration}
      AND "status" = 'RUNNING' AND "claimToken" = ${input.claimToken} AND "leaseUntil" > NOW()
      AND "attemptCount" > 0`;
  return changed === 1;
}

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
  } catch (error) {
    // Only an explicit hostClaimToken unique-conflict maps to "already exists";
    // every other database failure (outage, FK/tenant-lineage violation) must
    // surface with its real class instead of masquerading as a duplicate.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && (error.meta as { target?: string[] } | undefined)?.target?.includes("hostClaimToken")) return null;
    throw error;
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

/**
 * Explicit, state-machine-closed transitions (RF01 P1-07). The lifecycle is
 * STARTING → RUNNING → STOPPING → STOPPED, with ORPHANED reachable from every
 * non-terminal state when recovery evidence warrants it. Each helper enforces
 * its legal previous-state predicate in PostgreSQL — arbitrary mutation
 * ("anything but STOPPED") is no longer expressible:
 *  - STOPPING: only from RUNNING (the owner is deliberately tearing down a
 *    server whose identity it recorded).
 *  - STOPPED: only from STOPPING, or from STARTING when cleanup can prove the
 *    server never became usable (no endpoint identity ever existed).
 *  - ORPHANED: from STARTING/RUNNING/STOPPING — a handled failure or a
 *    reconciler with evidence that the row's process can no longer be
 *    accounted for.
 * All writes are hostClaimToken-scoped: a stale owner can never mutate a
 * newer claim's row.
 */

export async function markOcrServerStopping(hostClaimToken: string, terminationReason?: string): Promise<boolean> {
  const changed = await prisma.ocrServerInstance.updateMany({
    where: { hostClaimToken, status: "RUNNING" },
    data: { status: "STOPPING", lastObservedAt: new Date(), ...(terminationReason ? { terminationReason } : {}) },
  });
  return changed.count === 1;
}

export async function markOcrServerStopped(hostClaimToken: string, terminationReason?: string): Promise<boolean> {
  const changed = await prisma.ocrServerInstance.updateMany({
    where: { hostClaimToken, status: "STOPPING" },
    data: { status: "STOPPED", stoppedAt: new Date(), lastObservedAt: new Date(), ...(terminationReason ? { terminationReason } : {}) },
  });
  return changed.count === 1;
}

/**
 * The ONLY STARTING -> STOPPED path (RF02 state-machine boundary). The proof
 * condition is encoded in the PostgreSQL predicate, never in a caller-supplied
 * reason string: the row must STILL carry no endpoint identity (pid and
 * serverId both NULL), which is durable evidence that recordOcrServerEndpoint
 * never committed for this claim. Callers must additionally hold process-tree
 * proof that nothing survived (spawn ENOENT, or a confirmed owned-tree
 * termination) — this helper deliberately cannot express any other case.
 */
export async function markOcrServerStartNeverStarted(hostClaimToken: string): Promise<boolean> {
  const changed = await prisma.ocrServerInstance.updateMany({
    where: { hostClaimToken, status: "STARTING", pid: null, serverId: null },
    data: { status: "STOPPED", stoppedAt: new Date(), lastObservedAt: new Date(), terminationReason: "NEVER_STARTED_NO_ENDPOINT_IDENTITY" },
  });
  return changed.count === 1;
}

/**
 * The reconciler's proven-gone convergence (RF02 P1-03/state-machine
 * boundary): a STARTING/RUNNING/STOPPING row whose durable endpoint identity
 * WAS recorded may converge to STOPPED only through this explicitly named
 * proof API, and only after the shared repeated-negative liveness rule has
 * confirmed the recorded process gone. The predicate encodes the proof
 * precondition in PostgreSQL — a row without durable identity (pid/serverId)
 * can never pass, so endpoint-file-only evidence can never converge a row.
 */
export async function markOcrServerStoppedProcessGone(hostClaimToken: string, terminationReason: string): Promise<boolean> {
  const changed = await prisma.ocrServerInstance.updateMany({
    where: { hostClaimToken, status: { in: ["STARTING", "RUNNING", "STOPPING"] }, pid: { not: null }, serverId: { not: null } },
    data: { status: "STOPPED", stoppedAt: new Date(), lastObservedAt: new Date(), terminationReason },
  });
  return changed.count === 1;
}

export async function markOcrServerOrphaned(hostClaimToken: string, terminationReason: string): Promise<boolean> {
  const changed = await prisma.ocrServerInstance.updateMany({
    where: { hostClaimToken, status: { in: ["STARTING", "RUNNING", "STOPPING"] } },
    data: { status: "ORPHANED", lastObservedAt: new Date(), terminationReason },
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

/**
 * Same-host reconciler discovery (RF02 P1-01). ORPHANED is a TERMINAL,
 * manual-intervention state: it is deliberately EXCLUDED from automatic
 * discovery so old orphan rows can never consume the bounded batch and starve
 * newer actionable STARTING/RUNNING/STOPPING rows. Batching is pushed into
 * the database query (orderBy + take) — never fetch-unbounded-then-slice.
 */
export async function listReconcilableOcrServerInstances(hostId: string, batchSize = 20): Promise<Array<{ id: string; hostClaimToken: string; runExecutionToken: string; mineruHome: string; pid: number | null; serverId: string | null; status: string }>> {
  return prisma.ocrServerInstance.findMany({
    where: { hostId, status: { in: ["STARTING", "RUNNING", "STOPPING"] } },
    select: { id: true, hostClaimToken: true, runExecutionToken: true, mineruHome: true, pid: true, serverId: true, status: true },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });
}

// ---------------------------------------------------------------------------
// Routing durability columns: write-once plan, one-way terminal outcome.
// 04B-2 executes PDF routing through these primitives — the optional
// transaction-client parameters exist so the publication path can write the
// routing outcome inside the SAME fenced transaction as the extraction (same
// table, same columns, same authority; never a parallel one).
// ---------------------------------------------------------------------------

/** Write-once: the routing plan can never be mutated once persisted. */
export async function writeRoutingPlan(runId: string, routingGeneration: number, plan: unknown, tx: Prisma.TransactionClient = prisma): Promise<boolean> {
  const changed = await tx.$executeRaw`UPDATE "IngestionRun" SET "routingGeneration" = ${routingGeneration}, "routingPlan" = ${JSON.stringify(plan)}::jsonb WHERE "id" = ${runId} AND "routingPlan" IS NULL`;
  return changed === 1;
}

/** One-way: a null routingOutcome may be filled exactly once, for the plan's own generation. */
export async function writeRoutingOutcome(runId: string, routingGeneration: number, outcome: unknown, tx: Prisma.TransactionClient = prisma): Promise<boolean> {
  const changed = await tx.$executeRaw`UPDATE "IngestionRun" SET "routingOutcome" = ${JSON.stringify(outcome)}::jsonb WHERE "id" = ${runId} AND "routingGeneration" = ${routingGeneration} AND "routingOutcome" IS NULL AND "routingPlan" IS NOT NULL`;
  return changed === 1;
}
