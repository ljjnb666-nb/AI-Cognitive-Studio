
import { prisma } from "@ai-cognitive/db";
import { verifyFrozenBookFailoverPlan, type BookFailoverTextSlot } from "./failover-plan.js";
import { bookRoutePlanHash, normalizeBookRoutePlan, type BookAnalysisRoutePlan } from "./route-plan.js";

export type FirstBackupConsent = {
  analysisRunId: string;
  routeSlot: BookFailoverTextSlot;
  operationHash: string;
  planHash: string;
  expectedRevision: number;
  maxAdditionalUnits: number;
  expiresInMinutes: number;
  /** An explicit confirmation per operation, not a saved workspace preference. */
  approval: "AUTHORIZE_ONE_ADDITIONAL_MODEL_CALL";
};

const digest = /^[0-9a-f]{64}$/;
const fail = (reason: string): never => { throw new Error(reason); };

/**
 * Owner-only, per-operation additional-cost consent.
 * No Gateway invocation, no model call, no switching, and no production
 * execution. A request MUST be demonstrably not sent by the original Gateway.
 * This is the ONLY new issuer of BookFailoverPaidGrant records.
 */
export async function authorizeOneBookBackupCall(
  actor: { userId: string; workspaceId: string },
  request: FirstBackupConsent,
) {
  if (!actor.userId || !actor.workspaceId ||
      request.approval !== "AUTHORIZE_ONE_ADDITIONAL_MODEL_CALL" ||
      !["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"].includes(request.routeSlot) ||
      !digest.test(request.operationHash) || !digest.test(request.planHash) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 ||
      !Number.isSafeInteger(request.maxAdditionalUnits) ||
      request.maxAdditionalUnits < 1 || request.maxAdditionalUnits > 1_000_000 ||
      !Number.isSafeInteger(request.expiresInMinutes) ||
      request.expiresInMinutes < 1 || request.expiresInMinutes > 60)
    fail("BOOK_FAILOVER_GRANT_INVALID_REQUEST");

  return prisma.$transaction(async tx => {
    // Lock order matches the Book Worker: Run -> Job, then operation cursor.
    const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "BookAnalysisRun" WHERE "id"=$1 FOR UPDATE', request.analysisRunId,
    );
    if (locked.length !== 1) fail("BOOK_FAILOVER_GRANT_ACCESS_DENIED");
    const run = await tx.bookAnalysisRun.findUniqueOrThrow({ where: { id: request.analysisRunId } });
    if (run.workspaceId !== actor.workspaceId || run.status !== "RUNNING" ||
        !run.executionLeaseUntil) fail("BOOK_FAILOVER_GRANT_ACCESS_DENIED");
    const [clock] = await tx.$queryRawUnsafe<Array<{ now: Date }>>("SELECT clock_timestamp() AS now");
    if (!clock?.now || run.executionLeaseUntil <= clock.now)
      fail("BOOK_FAILOVER_GRANT_EXECUTION_NOT_ACTIVE");

    const owner = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: actor.userId } },
      select: { role: true },
    });
    if (owner?.role !== "OWNER") fail("BOOK_FAILOVER_GRANT_OWNER_REQUIRED");

    const jobLocked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "Job" WHERE "id"=$1 FOR UPDATE', run.jobId,
    );
    if (jobLocked.length !== 1) fail("BOOK_FAILOVER_GRANT_ACCESS_DENIED");
    const job = await tx.job.findUniqueOrThrow({ where: { id: run.jobId } });
    if (job.workspaceId !== actor.workspaceId || job.status !== "RUNNING" ||
        !job.userId) fail("BOOK_FAILOVER_GRANT_ACCESS_DENIED");

    const payload = job.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      fail("BOOK_FAILOVER_GRANT_UNSEALED_PLAN");
    const data = payload as Record<string, unknown>;
    if (!data.routePlan || typeof data.routePlanHash !== "string" || !data.failoverPlan)
      fail("BOOK_FAILOVER_GRANT_UNSEALED_PLAN");
    let frozen;
    try {
      const primary = normalizeBookRoutePlan(data.routePlan as BookAnalysisRoutePlan);
      if (bookRoutePlanHash(primary) !== data.routePlanHash) fail("BOOK_FAILOVER_GRANT_UNSEALED_PLAN");
      frozen = verifyFrozenBookFailoverPlan(data.failoverPlan, primary);
    } catch { return fail("BOOK_FAILOVER_GRANT_UNSEALED_PLAN"); }
    const slot = frozen.slots[request.routeSlot];
    if (!slot || slot.maxSwitches < 1 ||
        frozen.integrityHash !== request.planHash || frozen.executionEnabled !== false)
      fail("BOOK_FAILOVER_GRANT_UNSEALED_PLAN");

    const operation = await tx.bookFailoverCheckpoint.findUnique({
      where: { analysisRunId_routeSlot_operationHash: {
        analysisRunId: request.analysisRunId, routeSlot: request.routeSlot,
        operationHash: request.operationHash,
      } },
    });
    if (!operation || operation.workspaceId !== actor.workspaceId ||
        operation.planHash !== request.planHash ||
        operation.revision !== request.expectedRevision ||
        operation.state !== "HOLD" || operation.candidateIndex !== 0 ||
        operation.switchesUsed !== 0 || !operation.lastFailureCode ||
        !operation.sendIntentKey || !operation.sendIntentAt ||
        !operation.sendIntentInputHash || operation.backupSendKey ||
        operation.paidGrantId || operation.lastFailureCode === "CONTENT_REJECTED" ||
        operation.holdReason === "CONTENT_POLICY_REVIEW_REQUIRED")
      fail("BOOK_FAILOVER_GRANT_OPERATION_NOT_ELIGIBLE");

    // An error code alone never proves unbilled. A PENDING claim with no
    // attempt and no owner is the Gateway's demonstrable NOT_SENT state.
    const original = await tx.providerInvocation.findUnique({
      where: { workspaceId_idempotencyKey: {
        workspaceId: actor.workspaceId, idempotencyKey: operation.sendIntentKey,
      } },
      include: { attempts: { select: { id: true }, take: 1 } },
    });
    const primaryRoute = slot.candidates[0]!;
    if (!original || original.status !== "PENDING" || original.attempts.length !== 0 ||
        original.claimToken || original.claimOwner || original.claimExpiresAt ||
        operation.latestInvocationId !== original.id || operation.latestAttemptId ||
        original.providerKey !== primaryRoute.providerKey ||
        original.modelId !== primaryRoute.modelId ||
        original.routeSlot !== request.routeSlot ||
        original.connectionId !== primaryRoute.connectionId ||
        original.credentialVersionId !== primaryRoute.credentialVersionId)
      fail("BOOK_FAILOVER_GRANT_REMOTE_OUTCOME_UNKNOWN");

    // Verify the Book source is still the same, non-archived extraction.
    const extraction = await tx.currentDocumentExtraction.findUnique({
      where: { sourceDocumentId_workspaceId: {
        sourceDocumentId: run.sourceDocumentId, workspaceId: actor.workspaceId,
      } },
    });
    const doc = await tx.sourceDocument.findFirst({
      where: { id: run.sourceDocumentId, workspaceId: actor.workspaceId,
        source: { archivedAt: null } }, select: { id: true },
    });
    if (!doc || extraction?.extractionId !== run.extractionId)
      fail("BOOK_FAILOVER_GRANT_SOURCE_CHANGED");

    // Model route, credential and actual resource budget are independently
    // checked AGAIN by reserveFirstBookFailoverSwitch; consent alone cannot send.
    const expiresAt = new Date(clock.now.getTime() + request.expiresInMinutes * 60_000);
    const grant = await tx.bookFailoverPaidGrant.create({ data: {
      workspaceId: actor.workspaceId, analysisRunId: request.analysisRunId,
      routeSlot: request.routeSlot, operationHash: request.operationHash,
      planHash: request.planHash, nextCandidateIndex: 1,
      authorizedByUserId: actor.userId,
      maxAdditionalUnits: request.maxAdditionalUnits, expiresAt,
    } });
    await tx.providerAuditEvent.create({ data: {
      workspaceId: actor.workspaceId, actorUserId: actor.userId,
      action: "ROUTING_UPDATED", targetType: "BookFailoverPaidGrant",
      targetId: grant.id, metadata: {
        version: 1, operationHash: request.operationHash,
        planHash: request.planHash, routeSlot: request.routeSlot,
        analysisRunId: request.analysisRunId, maxAdditionalUnits: request.maxAdditionalUnits,
        expiresAt: expiresAt.toISOString(),
        explicitOneAdditionalModelCallConsent: true, executableNow: false,
      },
    } });
    return { grantId: grant.id, analysisRunId: request.analysisRunId,
      routeSlot: request.routeSlot, maxAdditionalUnits: request.maxAdditionalUnits,
      expiresAt: expiresAt.toISOString(), executionEnabled: false as const };
  });
}
