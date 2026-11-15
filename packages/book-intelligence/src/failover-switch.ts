import { prisma } from "@ai-cognitive/db";
import {
  assessProviderFailover, boundedResourceUnits, stableHash, validateRouteManifestSelection,
  type GatewayRequest, type ProviderModelManifest, type ResolvedRoute,
  type FailoverHoldReason, type ProviderErrorCode,
} from "@ai-cognitive/provider-gateway";
import { assertBookExecutionAuthority } from "./execution-authority.js";
import { verifyFrozenBookFailoverPlan } from "./failover-plan.js";
import { bookRoutePlanHash, normalizeBookRoutePlan, type BookAnalysisRoutePlan, type BookRoutePlanEntry } from "./route-plan.js";
import type { BookFailoverOperation } from "./failover-checkpoint.js";

export type BookFailoverSwitchInput = BookFailoverOperation & {
  /** Only a trusted Worker may construct the complete outbound request. */
  request: GatewayRequest;
  manifest: ProviderModelManifest;
};
export type BookFailoverSwitchDecision =
  | { action: "HOLD"; reason: FailoverHoldReason | "INTEGRITY_FAILED" }
  | { action: "RESERVED"; nextCandidateIndex: 1; idempotencyKey: string; grantId: string };

const digest = /^[a-f0-9]{64}$/;
const fail = (): never => { throw new Error("BOOK_FAILOVER_SWITCH_INTEGRITY_FAILED"); };
const asCandidate = (entry: BookRoutePlanEntry) => ({
  source: "WORKSPACE" as const, providerKey: entry.providerKey,
  protocol: entry.protocol as ResolvedRoute["protocol"],
  modelId: entry.modelId, connectionId: entry.connectionId,
  credentialVersionId: entry.credentialVersionId,
  configuration: entry.configuration,
});

/** Same outbound request fingerprint the primary Worker sealed before sending. */
export function bookFailoverOutboundFingerprint(request: GatewayRequest): string {
  if (!request.text) fail();
  return stableHash({
    inputHash: request.inputHash, text: request.text,
    routeSlot: request.routeSlot, promptVersion: request.promptVersion,
    pipelineVersion: request.pipelineVersion, schemaVersion: request.schemaVersion,
  });
}

/**
 * Atomically reserves the FIRST backup, but deliberately never dispatches it.
 * An owner-issued additional paid call grant (no issuer API yet), verified
 * NOT_SENT provider claim, same outbound request, active backup credential,
 * frozen route chain and conservative workspace budgets are mandatory.
 *
 * A missing Invocation or any remote attempt is UNKNOWN, never free.
 * Only PENDING with cleared pre-remote ownership and zero attempts proves
 * NOT_SENT: Gateway.startAttempt persists before adapter.execute.
 */
export async function reserveFirstBookFailoverSwitch(input: BookFailoverSwitchInput): Promise<BookFailoverSwitchDecision> {
  const { execution, routeSlot, operationHash, planHash, request } = input;
  if (!digest.test(operationHash) || !digest.test(planHash) ||
      !request.text || request.workspaceId !== execution.workspaceId ||
      request.executionRunId !== execution.analysisRunId ||
      request.routeSlot !== routeSlot || !request.pinnedRoute ||
      request.pinnedRoute.source !== "WORKSPACE" ||
      !request.idempotencyKey || request.idempotencyKey.length > 2048) fail();
  const newFingerprint = bookFailoverOutboundFingerprint(request);
  const units = boundedResourceUnits(request);
  return prisma.$transaction(async tx => {
    // Run/Job/grant locks serialize every writer of the same Book operation.
    const { job } = await assertBookExecutionAuthority(tx, execution);
    const payload = job.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail();
    const sealed = payload as Record<string, unknown>;
    if (!sealed.routePlan || typeof sealed.routePlanHash !== "string") fail();
    let plan: BookAnalysisRoutePlan;
    try {
      plan = normalizeBookRoutePlan(sealed.routePlan as BookAnalysisRoutePlan);
      if (bookRoutePlanHash(plan) !== sealed.routePlanHash) fail();
    } catch { return fail(); }
    const frozen = verifyFrozenBookFailoverPlan(sealed.failoverPlan, plan);
    const preference = frozen.slots[routeSlot];
    if (!preference || frozen.integrityHash !== planHash ||
        frozen.executionEnabled !== false || preference.maxSwitches < 1) fail();

    const where = { analysisRunId_routeSlot_operationHash: {
      analysisRunId: execution.analysisRunId, routeSlot, operationHash,
    } };
    const cursor = await tx.bookFailoverCheckpoint.findUnique({ where });
    if (!cursor || cursor.workspaceId !== execution.workspaceId ||
        cursor.planHash !== planHash || cursor.candidateIndex !== 0 ||
        cursor.switchesUsed !== 0 || cursor.state !== "HOLD" ||
        !cursor.sendIntentKey || !cursor.sendIntentInputHash ||
        !cursor.sendIntentAt || cursor.backupSendKey || cursor.paidGrantId ||
        !cursor.lastFailureCode)
      return { action: "HOLD" as const, reason: "INTEGRITY_FAILED" as const };
    if (cursor.sendIntentInputHash !== newFingerprint ||
        request.idempotencyKey === cursor.sendIntentKey) fail();

    const prior = preference.candidates[0]!;
    const backup = preference.candidates[1];
    if (!backup) return { action: "HOLD" as const, reason: "NO_BACKUP" as const };
    const pinned = request.pinnedRoute;
    if (pinned.providerKey !== backup.providerKey ||
        pinned.protocol !== backup.protocol ||
        pinned.modelId !== backup.modelId ||
        pinned.adapterVersion !== backup.adapterVersion ||
        pinned.connectionId !== backup.connectionId ||
        pinned.credentialVersionId !== backup.credentialVersionId ||
        pinned.endpoint !== backup.endpoint ||
        pinned.region !== backup.region ||
        stableHash(pinned.configuration) !== backup.configurationHash) fail();

    const invocation = await tx.providerInvocation.findUnique({
      where: { workspaceId_idempotencyKey: {
        workspaceId: execution.workspaceId, idempotencyKey: cursor.sendIntentKey,
      } },
      include: { attempts: { select: { id: true }, take: 1 } },
    });
    const noRemoteSend = Boolean(invocation && invocation.status === "PENDING" &&
      !invocation.claimToken && !invocation.claimOwner &&
      !invocation.claimExpiresAt && invocation.attempts.length === 0 &&
      invocation.routeSlot === routeSlot && invocation.providerKey === prior.providerKey &&
      invocation.modelId === prior.modelId &&
      invocation.connectionId === prior.connectionId &&
      invocation.credentialVersionId === prior.credentialVersionId &&
      cursor.latestInvocationId === invocation.id && !cursor.latestAttemptId);
    if (!noRemoteSend) return { action: "HOLD" as const, reason: "UNKNOWN_BILLING" as const };

    const connection = await tx.providerConnection.findFirst({
      where: { id: backup.connectionId, workspaceId: execution.workspaceId,
        status: "ACTIVE", providerKey: backup.providerKey, protocol: backup.protocol },
      include: { credentialVersions: {
        where: { id: backup.credentialVersionId, status: "ACTIVE" },
        select: { id: true },
      } },
    });
    if (!connection || connection.credentialVersions.length !== 1 ||
        connection.endpoint !== backup.endpoint ||
        connection.region !== (backup.region ?? null))
      return { action: "HOLD" as const, reason: "UNAUTHORIZED_TARGET" as const };
    try {
      const model = validateRouteManifestSelection(input.manifest, {
        routeSlot, providerKey: backup.providerKey,
        protocol: backup.protocol, modelId: backup.modelId,
        configuration: backup.configuration,
      });
      if ((model.structuredOutput !== "JSON_MODE" && model.structuredOutput !== "STRICT_JSON_SCHEMA") ||
          request.capability.family !== "TEXT_GENERATION" ||
          request.capability.structuredOutput !== model.structuredOutput ||
          pinned.capability.structuredOutput !== model.structuredOutput)
        fail();
    } catch { return { action: "HOLD" as const, reason: "INCOMPATIBLE_CAPABILITY" as const }; }

    const [{ now }] = await tx.$queryRawUnsafe<Array<{ now: Date }>>("SELECT clock_timestamp() AS now");
    if (!now) fail();
    const grant = await tx.bookFailoverPaidGrant.findUnique({
      where: { analysisRunId_routeSlot_operationHash_nextCandidateIndex: {
        analysisRunId: execution.analysisRunId, routeSlot, operationHash,
        nextCandidateIndex: 1,
      } },
    });
    const issuer = grant ? await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: {
        workspaceId: execution.workspaceId, userId: grant.authorizedByUserId,
      } },
      select: { role: true },
    }) : null;
    const paidAuthorized = Boolean(grant && !grant.usedAt && issuer?.role === "OWNER" &&
      grant.workspaceId === execution.workspaceId && grant.planHash === planHash &&
      grant.expiresAt > now && grant.maxAdditionalUnits >= units);

    const policy = await tx.workspaceResourcePolicy.findUnique({
      where: { workspaceId: execution.workspaceId },
    });
    const beginning = new Date(Date.UTC(now.getUTCFullYear(),
      now.getUTCMonth(), now.getUTCDate()));
    // Mirror Gateway's per-row COALESCE semantics, so unsettled reservations
    // retain their full upper-bound units and cannot be double counted.
    const [usage] = await tx.$queryRawUnsafe<Array<{ daily: bigint; run: bigint }>>(
      'SELECT COALESCE(SUM(COALESCE("chargedUnits","units")) FILTER (WHERE "createdAt">=$1),0)::bigint AS daily, ' +
      'COALESCE(SUM(COALESCE("chargedUnits","units")) FILTER (WHERE "scopeKey"=$2),0)::bigint AS run ' +
      'FROM "ProviderResourceReservation" WHERE "workspaceId"=$3',
      beginning, execution.analysisRunId, execution.workspaceId,
    );
    const budgetAvailable = Boolean(policy &&
      Number(usage?.daily ?? 0n) + units <= policy.dailyUnitLimit &&
      (policy.runLimitEnabled === false ||
        Number(usage?.run ?? 0n) + units <= policy.runUnitLimit));

    const decision = assessProviderFailover({
      routeSlot, manifest: input.manifest,
      candidates: preference.candidates.map(asCandidate), currentCandidateIndex: 0,
      errorCode: cursor.lastFailureCode as ProviderErrorCode,
      settledOutcome: "NOT_SENT",
      verified: {
        workspaceAuthority: true, sealedPlan: true,
        userEnabledFailover: preference.requestedEnabled,
        priorInvocationTerminal: true, noActiveExecutionClaim: true,
        newPaidCallAuthorized: paidAuthorized, budgetAvailable,
      },
      switchesUsed: cursor.switchesUsed, maxSwitches: preference.maxSwitches,
    });
    if (decision.action === "HOLD") return decision;
    if (decision.nextCandidateIndex !== 1 || !grant ||
        !paidAuthorized || !budgetAvailable) fail();

    // The execution is NOT enabled. The reservation cannot itself send a
    // model request. A future audited executor must take this exact key and
    // persist its outcome in a separate authenticated invocation.
    const updated = await tx.bookFailoverCheckpoint.updateMany({
      where: {
        ...where, revision: cursor.revision, state: "HOLD",
        candidateIndex: 0, switchesUsed: 0,
        backupSendKey: null, paidGrantId: null,
      },
      data: {
        state: "SWITCH_RESERVED", holdReason: "WAITING_FOR_EXECUTOR",
        settledOutcome: "NOT_SENT", candidateIndex: 1, switchesUsed: 1,
        backupSendKey: request.idempotencyKey,
        backupSendHash: newFingerprint, backupReservedAt: now,
        paidGrantId: grant.id, revision: { increment: 1 }, observedAt: now,
      },
    });
    if (updated.count !== 1) fail();
    const used = await tx.bookFailoverPaidGrant.updateMany({
      where: { id: grant.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (used.count !== 1) fail();
    return { action: "RESERVED" as const, nextCandidateIndex: 1 as const,
      idempotencyKey: request.idempotencyKey, grantId: grant.id };
  });
}
