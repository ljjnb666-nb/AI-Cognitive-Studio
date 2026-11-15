import { prisma } from "@ai-cognitive/db";
import {
  boundedResourceUnits, stableHash, validateRouteManifestSelection,
} from "@ai-cognitive/provider-gateway";
import { assertBookExecutionAuthority } from "./execution-authority.js";
import { verifyFrozenBookFailoverPlan } from "./failover-plan.js";
import { bookRoutePlanHash, normalizeBookRoutePlan, type BookAnalysisRoutePlan } from "./route-plan.js";
import { bookFailoverOutboundFingerprint, type BookFailoverSwitchInput } from "./failover-switch.js";

export type BookBackupDryRunDecision =
  | { status: "HOLD"; reason: "PLAN_INVALID" | "NOT_RESERVED" | "REQUEST_CHANGED" |
      "GRANT_INVALID" | "PRIMARY_NOT_FENCED" | "BACKUP_ALREADY_EXISTS" |
      "CREDENTIAL_UNAVAILABLE" | "CAPABILITY_CHANGED" | "SOURCE_CHANGED"; canDispatch: false }
  | { status: "DRY_RUN_READY"; nextCandidateIndex: 1; canDispatch: false };

/**
 * The independent, read-only guard for a future Book backup executor.
 *
 * Does NOT invoke Gateway, create an invocation, allocate budget, issue grants,
 * unfreeze execution, or write checkpoint state. Even DRY_RUN_READY is NOT an
 * authorization to send a paid request. Any eventual production executor
 * must recheck these facts atomically with its OWN durable send reservation.
 */
export async function inspectReservedBookBackupDryRun(
  input: BookFailoverSwitchInput,
): Promise<BookBackupDryRunDecision> {
  const hold = (reason: Extract<BookBackupDryRunDecision, { status: "HOLD" }>["reason"]) =>
    ({ status: "HOLD" as const, reason, canDispatch: false as const });
  const { execution, routeSlot, operationHash, planHash, request } = input;
  const pinned = request.pinnedRoute;
  if (!/^[a-f0-9]{64}$/.test(operationHash) || !/^[a-f0-9]{64}$/.test(planHash) ||
      !request.text || !pinned || pinned.source !== "WORKSPACE" ||
      request.workspaceId !== execution.workspaceId ||
      request.executionRunId !== execution.analysisRunId ||
      request.routeSlot !== routeSlot || !request.idempotencyKey ||
      request.idempotencyKey.length > 2048)
    return hold("REQUEST_CHANGED");
  let fingerprint: string;
  let units: number;
  try {
    fingerprint = bookFailoverOutboundFingerprint(request);
    units = boundedResourceUnits(request);
  } catch { return hold("REQUEST_CHANGED"); }

  return prisma.$transaction(async tx => {
    const { run, job } = await assertBookExecutionAuthority(tx, execution);
    const currentExtraction = await tx.currentDocumentExtraction.findUnique({
      where: { sourceDocumentId_workspaceId: {
        sourceDocumentId: run.sourceDocumentId, workspaceId: execution.workspaceId,
      } }, select: { extractionId: true },
    });
    const activeDocument = await tx.sourceDocument.findFirst({
      where: { id: run.sourceDocumentId, workspaceId: execution.workspaceId,
        source: { archivedAt: null } }, select: { id: true },
    });
    if (!activeDocument || currentExtraction?.extractionId !== run.extractionId)
      return hold("SOURCE_CHANGED");
    if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload))
      return hold("PLAN_INVALID");
    const payload = job.payload as Record<string, unknown>;
    let frozen: ReturnType<typeof verifyFrozenBookFailoverPlan>;
    try {
      const primary = normalizeBookRoutePlan(payload.routePlan as BookAnalysisRoutePlan);
      if (bookRoutePlanHash(primary) !== payload.routePlanHash)
        return hold("PLAN_INVALID");
      frozen = verifyFrozenBookFailoverPlan(payload.failoverPlan, primary);
    } catch { return hold("PLAN_INVALID"); }
    const chain = frozen.slots[routeSlot];
    if (frozen.integrityHash !== planHash || frozen.executionEnabled !== false ||
        !chain || chain.maxSwitches < 1 || !chain.candidates[1])
      return hold("PLAN_INVALID");
    const backup = chain.candidates[1]!;
    if (pinned.providerKey !== backup.providerKey || pinned.modelId !== backup.modelId ||
        pinned.protocol !== backup.protocol || pinned.adapterVersion !== backup.adapterVersion ||
        pinned.connectionId !== backup.connectionId ||
        pinned.credentialVersionId !== backup.credentialVersionId ||
        pinned.endpoint !== backup.endpoint || pinned.region !== backup.region ||
        stableHash(pinned.configuration) !== backup.configurationHash)
      return hold("REQUEST_CHANGED");
    const cursor = await tx.bookFailoverCheckpoint.findUnique({
      where: { analysisRunId_routeSlot_operationHash: {
        analysisRunId: execution.analysisRunId, routeSlot, operationHash,
      } },
    });
    if (!cursor || cursor.workspaceId !== execution.workspaceId ||
        cursor.sendIntentInputHash !== fingerprint ||
        cursor.backupSendKey === cursor.sendIntentKey || !cursor.lastFailureCode ||
        cursor.planHash !== planHash || cursor.state !== "SWITCH_RESERVED" ||
        cursor.candidateIndex !== 1 || cursor.switchesUsed !== 1 ||
        cursor.backupSendKey !== request.idempotencyKey || !cursor.sendIntentKey ||
        cursor.backupSendHash !== fingerprint || !cursor.paidGrantId ||
        cursor.latestAttemptId)
      return hold("NOT_RESERVED");

    const grant = await tx.bookFailoverPaidGrant.findUnique({
      where: { id: cursor.paidGrantId },
    });
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (!grant || !clock || !grant.usedAt || grant.usedAt > grant.expiresAt ||
        grant.expiresAt <= clock.now || grant.workspaceId !== execution.workspaceId ||
        grant.analysisRunId !== execution.analysisRunId ||
        grant.routeSlot !== routeSlot || grant.operationHash !== operationHash ||
        grant.planHash !== planHash || grant.nextCandidateIndex !== 1 ||
        grant.maxAdditionalUnits < units)
      return hold("GRANT_INVALID");
    const issuer = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: {
        workspaceId: execution.workspaceId, userId: grant.authorizedByUserId,
      } }, select: { role: true },
    });
    if (issuer?.role !== "OWNER") return hold("GRANT_INVALID");

    const primaryInvocation = await tx.providerInvocation.findUnique({
      where: { workspaceId_idempotencyKey: {
        workspaceId: execution.workspaceId, idempotencyKey: cursor.sendIntentKey,
      } }, include: { attempts: { select: { id: true }, take: 1 } },
    });
    const original = chain.candidates[0]!;
    if (!primaryInvocation || primaryInvocation.status !== "BLOCKED" ||
        primaryInvocation.attempts.length !== 0 ||
        primaryInvocation.claimToken || primaryInvocation.claimOwner ||
        primaryInvocation.claimExpiresAt ||
        cursor.latestInvocationId !== primaryInvocation.id ||
        primaryInvocation.routeSlot !== routeSlot ||
        primaryInvocation.providerKey !== original.providerKey ||
        primaryInvocation.modelId !== original.modelId ||
        primaryInvocation.connectionId !== original.connectionId ||
        primaryInvocation.credentialVersionId !== original.credentialVersionId)
      return hold("PRIMARY_NOT_FENCED");

    const existingBackup = await tx.providerInvocation.findUnique({
      where: { workspaceId_idempotencyKey: {
        workspaceId: execution.workspaceId, idempotencyKey: cursor.backupSendKey,
      } }, select: { id: true },
    });
    if (existingBackup) return hold("BACKUP_ALREADY_EXISTS");

    const connection = await tx.providerConnection.findFirst({
      where: { id: backup.connectionId, workspaceId: execution.workspaceId,
        providerKey: backup.providerKey, protocol: backup.protocol, status: "ACTIVE" },
      include: { credentialVersions: {
        where: { id: backup.credentialVersionId, status: "ACTIVE" },
        select: { id: true },
      } },
    });
    if (!connection || connection.credentialVersions.length !== 1 ||
        connection.endpoint !== backup.endpoint ||
        connection.region !== (backup.region ?? null))
      return hold("CREDENTIAL_UNAVAILABLE");
    try {
      const provider = input.manifest.providers.find(item => item.providerKey === backup.providerKey);
      if (!provider || provider.adapterVersion !== backup.adapterVersion)
        return hold("CAPABILITY_CHANGED");
      const model = validateRouteManifestSelection(input.manifest, {
        routeSlot, providerKey: backup.providerKey, protocol: backup.protocol,
        modelId: backup.modelId, configuration: backup.configuration,
      });
      if (request.capability.family !== "TEXT_GENERATION" ||
          (model.structuredOutput !== "JSON_MODE" &&
           model.structuredOutput !== "STRICT_JSON_SCHEMA") ||
          model.structuredOutput !== request.capability.structuredOutput ||
          pinned.capability.structuredOutput !== model.structuredOutput)
        return hold("CAPABILITY_CHANGED");
    } catch { return hold("CAPABILITY_CHANGED"); }

    return { status: "DRY_RUN_READY", nextCandidateIndex: 1, canDispatch: false };
  });
}
