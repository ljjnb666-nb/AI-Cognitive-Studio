import { prisma } from "@ai-cognitive/db";
import { boundedResourceUnits, stableHash } from "@ai-cognitive/provider-gateway";
import { assertBookExecutionAuthority } from "./execution-authority.js";
import { inspectReservedBookBackupDryRun } from "./failover-dryrun.js";
import { verifyFrozenBookFailoverPlan } from "./failover-plan.js";
import { bookRoutePlanHash, normalizeBookRoutePlan, type BookAnalysisRoutePlan } from "./route-plan.js";
import { bookFailoverOutboundFingerprint, type BookFailoverSwitchInput } from "./failover-switch.js";

/**
 * Real PostgreSQL CAS for an OFFLINE / TEST-ONLY fake-adapter rehearsal.
 *
 * Intentionally NOT exported from the package public index or called by a
 * production Worker. It cannot enable a paid provider route: the sealed Book
 * plan remains executionEnabled=false and the production Gateway forbids it.
 * A successful rehearsal claim is irreversible. Crash, concurrent delivery
 * and replay are all HOLD, never a new claim or permission to re-send.
 */
export async function claimBookReservedBackupSimulationOnce(input: BookFailoverSwitchInput):
  Promise<{ status: "CLAIMED_FOR_FAKE_ADAPTER"; canDispatch: false } |
          { status: "HOLD"; reason: "NOT_READY" | "ALREADY_CLAIMED"; canDispatch: false }> {
  if (process.env.NODE_ENV !== "test")
    throw new Error("BOOK_BACKUP_SIMULATION_TEST_ENV_ONLY");

  const preflight = await inspectReservedBookBackupDryRun(input);
  if (preflight.status !== "DRY_RUN_READY")
    return { status: "HOLD", reason: "NOT_READY", canDispatch: false };

  const { execution, routeSlot, operationHash, planHash, request } = input;
  const pinned = request.pinnedRoute;
  const fingerprint = bookFailoverOutboundFingerprint(request);
  const units = boundedResourceUnits(request);
  return prisma.$transaction(async tx => {
    const { run, job } = await assertBookExecutionAuthority(tx, execution);
    if (!pinned || pinned.source !== "WORKSPACE" ||
        !job.payload || typeof job.payload !== "object" ||
        Array.isArray(job.payload))
      return { status: "HOLD" as const, reason: "NOT_READY" as const, canDispatch: false as const };

    const payload = job.payload as Record<string, unknown>;
    let chain: ReturnType<typeof verifyFrozenBookFailoverPlan>["slots"][typeof routeSlot];
    try {
      const primary = normalizeBookRoutePlan(payload.routePlan as BookAnalysisRoutePlan);
      if (bookRoutePlanHash(primary) !== payload.routePlanHash)
        throw new Error("BOOK_BACKUP_SIMULATION_INVALID_PLAN");
      const frozen = verifyFrozenBookFailoverPlan(payload.failoverPlan, primary);
      if (frozen.integrityHash !== planHash || frozen.executionEnabled !== false)
        throw new Error("BOOK_BACKUP_SIMULATION_INVALID_PLAN");
      chain = frozen.slots[routeSlot];
    } catch {
      return { status: "HOLD" as const, reason: "NOT_READY" as const, canDispatch: false as const };
    }
    const backup = chain?.candidates[1];
    if (!backup || request.workspaceId !== execution.workspaceId ||
        request.executionRunId !== execution.analysisRunId ||
        request.routeSlot !== routeSlot ||
        request.capability.family !== "TEXT_GENERATION" ||
        pinned.providerKey !== backup.providerKey ||
        pinned.protocol !== backup.protocol ||
        pinned.modelId !== backup.modelId ||
        pinned.connectionId !== backup.connectionId ||
        pinned.credentialVersionId !== backup.credentialVersionId ||
        pinned.endpoint !== backup.endpoint ||
        (pinned.region ?? null) !== (backup.region ?? null) ||
        pinned.adapterVersion !== backup.adapterVersion ||
        pinned.capability.structuredOutput !== backup.structuredOutput ||
        request.capability.structuredOutput !== backup.structuredOutput ||
        stableHash(pinned.configuration) !== backup.configurationHash)
      return { status: "HOLD" as const, reason: "NOT_READY" as const, canDispatch: false as const };

    const current = await tx.currentDocumentExtraction.findUnique({
      where: { sourceDocumentId_workspaceId: {
        sourceDocumentId: run.sourceDocumentId, workspaceId: execution.workspaceId,
      } }, select: { extractionId: true },
    });
    const source = await tx.sourceDocument.findFirst({
      where: { id: run.sourceDocumentId, workspaceId: execution.workspaceId,
        source: { archivedAt: null } }, select: { id: true },
    });
    if (!source || current?.extractionId !== run.extractionId)
      return { status: "HOLD" as const, reason: "NOT_READY" as const, canDispatch: false as const };

    const where = { analysisRunId_routeSlot_operationHash: {
      analysisRunId: execution.analysisRunId, routeSlot, operationHash,
    } };
    const cursor = await tx.bookFailoverCheckpoint.findUnique({ where });
    if (cursor?.state === "SWITCH_RESERVED" && cursor.holdReason === "SIMULATION_ONLY")
      return { status: "HOLD" as const, reason: "ALREADY_CLAIMED" as const, canDispatch: false as const };
    if (!cursor || cursor.workspaceId !== execution.workspaceId ||
        cursor.planHash !== planHash || cursor.state !== "SWITCH_RESERVED" ||
        cursor.holdReason !== "WAITING_FOR_EXECUTOR" ||
        cursor.candidateIndex !== 1 || cursor.switchesUsed !== 1 ||
        cursor.sendIntentInputHash !== fingerprint ||
        cursor.backupSendHash !== fingerprint ||
        cursor.backupSendKey !== request.idempotencyKey ||
        cursor.sendIntentKey === cursor.backupSendKey ||
        !cursor.backupSendKey || !cursor.paidGrantId ||
        !cursor.sendIntentAt || !cursor.backupReservedAt ||
        !cursor.latestInvocationId || cursor.latestAttemptId)
      return { status: "HOLD" as const, reason: "NOT_READY" as const, canDispatch: false as const };

    const grant = await tx.bookFailoverPaidGrant.findUnique({
      where: { id: cursor.paidGrantId },
    });
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (!clock || !grant || !grant.usedAt ||
        grant.usedAt > grant.expiresAt || grant.expiresAt <= clock.now ||
        grant.workspaceId !== execution.workspaceId ||
        grant.analysisRunId !== execution.analysisRunId ||
        grant.routeSlot !== routeSlot || grant.operationHash !== operationHash ||
        grant.planHash !== planHash || grant.nextCandidateIndex !== 1 ||
        grant.maxAdditionalUnits < units)
      return { status: "HOLD" as const, reason: "NOT_READY" as const, canDispatch: false as const };
    const owner = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: {
        workspaceId: execution.workspaceId, userId: grant.authorizedByUserId,
      } }, select: { role: true },
    });
    if (owner?.role !== "OWNER")
      return { status: "HOLD" as const, reason: "NOT_READY" as const, canDispatch: false as const };

    const original = chain!.candidates[0]!;
    const primaryInvocation = await tx.providerInvocation.findUnique({
      where: { workspaceId_idempotencyKey: {
        workspaceId: execution.workspaceId, idempotencyKey: cursor.sendIntentKey!,
      } }, include: { attempts: { select: { id: true }, take: 1 } },
    });
    if (!primaryInvocation || primaryInvocation.id !== cursor.latestInvocationId ||
        primaryInvocation.status !== "BLOCKED" ||
        primaryInvocation.claimToken || primaryInvocation.claimOwner ||
        primaryInvocation.claimExpiresAt || primaryInvocation.attempts.length !== 0 ||
        primaryInvocation.routeSlot !== routeSlot ||
        primaryInvocation.providerKey !== original.providerKey ||
        primaryInvocation.modelId !== original.modelId ||
        primaryInvocation.connectionId !== original.connectionId ||
        primaryInvocation.credentialVersionId !== original.credentialVersionId)
      return { status: "HOLD" as const, reason: "NOT_READY" as const, canDispatch: false as const };

    const priorBackup = await tx.providerInvocation.findUnique({
      where: { workspaceId_idempotencyKey: {
        workspaceId: execution.workspaceId, idempotencyKey: cursor.backupSendKey,
      } }, select: { id: true },
    });
    const connection = await tx.providerConnection.findFirst({
      where: { workspaceId: execution.workspaceId, id: backup.connectionId,
        status: "ACTIVE", providerKey: backup.providerKey, protocol: backup.protocol },
      include: { credentialVersions: {
        where: { id: backup.credentialVersionId, status: "ACTIVE" },
        select: { id: true },
      } },
    });
    if (priorBackup || !connection || connection.credentialVersions.length !== 1 ||
        connection.endpoint !== backup.endpoint ||
        connection.region !== (backup.region ?? null))
      return { status: "HOLD" as const, reason: "NOT_READY" as const, canDispatch: false as const };

    // Atomic, once-only, durable transition. This never conveys Gateway
    // execution authority; a test may call only an in-memory Fake Adapter.
    const claimed = await tx.bookFailoverCheckpoint.updateMany({
      where: { analysisRunId: execution.analysisRunId,
        routeSlot, operationHash, workspaceId: execution.workspaceId,
        revision: cursor.revision, state: "SWITCH_RESERVED",
        holdReason: "WAITING_FOR_EXECUTOR",
        candidateIndex: 1, switchesUsed: 1,
        backupSendKey: request.idempotencyKey, paidGrantId: cursor.paidGrantId },
      data: { holdReason: "SIMULATION_ONLY",
        revision: { increment: 1 }, observedAt: clock.now },
    });
    return claimed.count === 1
      ? { status: "CLAIMED_FOR_FAKE_ADAPTER" as const, canDispatch: false as const }
      : { status: "HOLD" as const, reason: "ALREADY_CLAIMED" as const, canDispatch: false as const };
  });
}
