import { prisma } from "@ai-cognitive/db";
import { type ProviderErrorCode } from "@ai-cognitive/provider-gateway";
import { assertBookExecutionAuthority, type BookExecutionContext } from "./execution-authority.js";
import { verifyFrozenBookFailoverPlan } from "./failover-plan.js";
import { bookRoutePlanHash, normalizeBookRoutePlan, type BookAnalysisRoutePlan } from "./route-plan.js";
import type { BookFailoverTextSlot, FrozenBookFailoverPlan } from "./failover-plan.js";

type Transaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
const digest = /^[a-f0-9]{64}$/;
const fail = (): never => { throw new Error("BOOK_FAILOVER_CHECKPOINT_INTEGRITY_FAILED"); };

export type BookFailoverOperation = {
  execution: BookExecutionContext;
  routeSlot: BookFailoverTextSlot;
  /** Hash of the semantic stage+operation+input, never raw book text. */
  operationHash: string;
  /** Already verified against the frozen primary Book route plan. */
  planHash: string;
};
export type BookFailoverFailure = BookFailoverOperation & {
  idempotencyKey: string;
  failureCode: ProviderErrorCode;
};
export type BookFailoverObservedOutcome = {
  settledOutcome: "NOT_SENT" | "UNKNOWN";
  holdReason: "NOT_ENABLED" | "UNKNOWN_BILLING" | "CONTENT_POLICY_REVIEW_REQUIRED";
  invocationId: string | null;
  attemptId: string | null;
};
type InvocationEvidence = {
  id: string; status: string; providerKey: string; modelId: string; routeSlot: string;
  connectionId: string | null; credentialVersionId: string | null;
  attempts: { id: string; status: string }[];
};

function validOperation(input: BookFailoverOperation): void {
  if (!digest.test(input.operationHash) || !digest.test(input.planHash) ||
      !["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"].includes(input.routeSlot))
    fail();
}

/** Revalidate plan IN the leased transaction; a stale Worker cannot write a new cursor. */
async function authoritativePlan(tx: Transaction, input: BookFailoverOperation): Promise<FrozenBookFailoverPlan> {
  validOperation(input);
  const { job } = await assertBookExecutionAuthority(tx, input.execution);
  const payload = job.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail();
  const data = payload as Record<string, unknown>;
  if (!data.routePlan || typeof data.routePlanHash !== "string" || !data.failoverPlan) fail();
  let primary: BookAnalysisRoutePlan;
  let frozen: FrozenBookFailoverPlan;
  try {
    primary = normalizeBookRoutePlan(data.routePlan as BookAnalysisRoutePlan);
    if (bookRoutePlanHash(primary) !== data.routePlanHash) fail();
    frozen = verifyFrozenBookFailoverPlan(data.failoverPlan, primary);
  } catch { return fail(); }
  if (frozen.integrityHash !== input.planHash || frozen.executionEnabled !== false ||
      !frozen.slots[input.routeSlot]) fail();
  return frozen;
}

/** Idempotent creation, never resets an existing cursor on redelivery. */
export async function seedBookFailoverCheckpoint(input: BookFailoverOperation) {
  return prisma.$transaction(async tx => {
    await authoritativePlan(tx, input);
    const where = {
      analysisRunId_routeSlot_operationHash: {
        analysisRunId: input.execution.analysisRunId,
        routeSlot: input.routeSlot,
        operationHash: input.operationHash,
      },
    };
    await tx.bookFailoverCheckpoint.createMany({
      data: [{
        workspaceId: input.execution.workspaceId,
        analysisRunId: input.execution.analysisRunId,
        routeSlot: input.routeSlot,
        operationHash: input.operationHash,
        planHash: input.planHash,
        state: "HOLD", holdReason: "NOT_ENABLED",
        settledOutcome: "UNKNOWN", candidateIndex: 0, switchesUsed: 0,
      }],
      skipDuplicates: true,
    });
    const checkpoint = await tx.bookFailoverCheckpoint.findUniqueOrThrow({ where });
    if (checkpoint.workspaceId !== input.execution.workspaceId ||
        checkpoint.planHash !== input.planHash || checkpoint.candidateIndex !== checkpoint.switchesUsed ||
        checkpoint.candidateIndex < 0 || checkpoint.candidateIndex > 2 ||
        checkpoint.state !== "HOLD") fail();
    // Failed operations may be redelivered under a *new* Job idempotency key.
    // A previous unresolved remote attempt must fence even the primary model;
    // otherwise a new key could silently trigger a second paid request.
    if (checkpoint.lastFailureCode &&
        (checkpoint.settledOutcome === "UNKNOWN" ||
         checkpoint.holdReason === "CONTENT_POLICY_REVIEW_REQUIRED")) {
      throw new Error("BOOK_FAILOVER_PRIOR_OUTCOME_REVIEW_REQUIRED");
    }
    // Older callers cannot bypass the atomic pre-send reservation contract
    // once an outbound intent exists, even if no failure was observed.
    if (checkpoint.sendIntentKey) {
      throw new Error("BOOK_FAILOVER_PRIOR_SEND_RECONCILIATION_REQUIRED");
    }
    return checkpoint;
  });
}

export type BookFailoverSendIntent = BookFailoverOperation & {
  idempotencyKey: string;
  inputHash: string;
};
export type BookFailoverSendDecision =
  | { action: "SEND_PRIMARY_ONCE"; idempotencyKey: string }
  | { action: "RECOVER_PERSISTED_TEXT"; idempotencyKey: string; invocationId: string; snapshotId: string };

/**
 * Atomic pre-send reservation. A crash after commit must NEVER allow a
 * subsequent delivery to start a different paid request. The only automatic
 * recovery is a proven successful, persisted text receipt for the exact
 * originally reserved idempotency identity.
 *
 * Even a same-key retry without a receipt is unsafe: the Gateway may reclaim
 * an old pre-remote invocation while its prior Worker is still in flight.
 */
export async function reserveBookFailoverSendIntent(input: BookFailoverSendIntent): Promise<BookFailoverSendDecision> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 2048 || !digest.test(input.inputHash))
    fail();
  return prisma.$transaction(async tx => {
    const frozen = await authoritativePlan(tx, input);
    const primary = frozen.slots[input.routeSlot]!.candidates[0]!;
    const where = {
      analysisRunId_routeSlot_operationHash: {
        analysisRunId: input.execution.analysisRunId,
        routeSlot: input.routeSlot,
        operationHash: input.operationHash,
      },
    };
    const created = await tx.bookFailoverCheckpoint.createMany({
      data: [{
        workspaceId: input.execution.workspaceId,
        analysisRunId: input.execution.analysisRunId,
        routeSlot: input.routeSlot,
        operationHash: input.operationHash,
        planHash: input.planHash,
        candidateIndex: 0, switchesUsed: 0,
        state: "HOLD", holdReason: "UNKNOWN_BILLING",
        settledOutcome: "UNKNOWN",
        sendIntentKey: input.idempotencyKey,
        sendIntentInputHash: input.inputHash,
        sendIntentAt: new Date(),
      }],
      skipDuplicates: true,
    });
    const checkpoint = await tx.bookFailoverCheckpoint.findUniqueOrThrow({ where });
    if (checkpoint.workspaceId !== input.execution.workspaceId ||
        checkpoint.planHash !== input.planHash || checkpoint.state !== "HOLD" ||
        checkpoint.candidateIndex !== 0 || checkpoint.switchesUsed !== 0) fail();
    if (created.count === 1) {
      // The transaction COMMIT must complete before Gateway.execute can begin.
      return { action: "SEND_PRIMARY_ONCE" as const, idempotencyKey: input.idempotencyKey };
    }
    // Rows created before pre-send intents existed are UNKNOWN, not "free."
    if (!checkpoint.sendIntentKey || !checkpoint.sendIntentInputHash ||
        !checkpoint.sendIntentAt || checkpoint.sendIntentInputHash !== input.inputHash)
      throw new Error("BOOK_FAILOVER_PRIOR_SEND_RECONCILIATION_REQUIRED");

    const previous = await tx.providerInvocation.findUnique({
      where: { workspaceId_idempotencyKey: {
        workspaceId: input.execution.workspaceId,
        idempotencyKey: checkpoint.sendIntentKey,
      } },
      select: {
        id: true, snapshotId: true,
        status: true, providerKey: true, modelId: true, routeSlot: true,
        connectionId: true, credentialVersionId: true,
        textResult: { select: { id: true } },
      },
    });
    // Only a Gateway-persisted, successful, matching original receipt
    // permits a read-only recovery. Any other state holds indefinitely.
    if (previous?.status !== "SUCCEEDED" || !previous.textResult ||
        previous.routeSlot !== input.routeSlot ||
        previous.providerKey !== primary.providerKey || previous.modelId !== primary.modelId ||
        previous.connectionId !== primary.connectionId ||
        previous.credentialVersionId !== primary.credentialVersionId)
      throw new Error("BOOK_FAILOVER_PRIOR_SEND_RECONCILIATION_REQUIRED");
    return { action: "RECOVER_PERSISTED_TEXT" as const, idempotencyKey: checkpoint.sendIntentKey, invocationId: previous.id, snapshotId: previous.snapshotId };
  });
}

/** Safe observation only. This NEVER upgrades UNKNOWN to unbilled or paid-and-reconciled. */
export function classifyBookFailoverEvidence(
  failureCode: ProviderErrorCode,
  invocation: InvocationEvidence | null,
): BookFailoverObservedOutcome {
  const attempt = invocation?.attempts[0];
  const settledOutcome = !invocation || (!attempt && invocation.status === "PENDING") ? "NOT_SENT" : "UNKNOWN";
  return {
    settledOutcome,
    holdReason: failureCode === "CONTENT_REJECTED" ? "CONTENT_POLICY_REVIEW_REQUIRED"
      : settledOutcome === "UNKNOWN" ? "UNKNOWN_BILLING" : "NOT_ENABLED",
    invocationId: invocation?.id ?? null,
    attemptId: attempt?.id ?? null,
  };
}

/**
 * Capture a failed invocation under the same Book owner lease. Any recorded
 * remote attempt is treated as potentially billable, including TIMEOUT.
 * Unique invocation/attempt identities are checked against the sealed primary.
 */
export async function observeBookFailoverFailure(input: BookFailoverFailure) {
  return prisma.$transaction(async tx => {
    const frozen = await authoritativePlan(tx, input);
    const primary = frozen.slots[input.routeSlot]!.candidates[0]!;
    const where = {
      analysisRunId_routeSlot_operationHash: {
        analysisRunId: input.execution.analysisRunId,
        routeSlot: input.routeSlot,
        operationHash: input.operationHash,
      },
    };
    const checkpoint = await tx.bookFailoverCheckpoint.findUnique({ where });
    if (!checkpoint) throw new Error("BOOK_FAILOVER_CHECKPOINT_INTEGRITY_FAILED");
    if (checkpoint.workspaceId !== input.execution.workspaceId ||
        checkpoint.planHash !== input.planHash || checkpoint.state !== "HOLD" ||
        checkpoint.candidateIndex !== 0 || checkpoint.switchesUsed !== 0) fail();
    const invocation = await tx.providerInvocation.findUnique({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: input.execution.workspaceId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: {
        id: true, status: true, routeSlot: true, providerKey: true, modelId: true,
        connectionId: true, credentialVersionId: true,
        attempts: {
          orderBy: { attemptNumber: "desc" }, take: 1,
          select: { id: true, status: true },
        },
      },
    });
    if (invocation &&
        (invocation.routeSlot !== input.routeSlot ||
         invocation.providerKey !== primary.providerKey ||
         invocation.modelId !== primary.modelId ||
         invocation.connectionId !== primary.connectionId ||
         invocation.credentialVersionId !== primary.credentialVersionId)) fail();
    // Moderation rejection is a permanent review barrier for this operation;
    // a subsequent retry classification may not erase it.
    if (checkpoint.lastFailureCode === "CONTENT_REJECTED" && input.failureCode !== "CONTENT_REJECTED")
      throw new Error("BOOK_FAILOVER_CONTENT_POLICY_REVIEW_REQUIRED");
    if (checkpoint.sendIntentKey && checkpoint.sendIntentKey !== input.idempotencyKey) fail();
    const initial = classifyBookFailoverEvidence(input.failureCode, invocation);
    // Once a send was reserved, absence of an invocation does not prove that
    // the prior Worker never crossed the network boundary before crashing.
    const observed = checkpoint.sendIntentKey && initial.settledOutcome === "NOT_SENT"
      ? { ...initial, settledOutcome: "UNKNOWN" as const,
          holdReason: input.failureCode === "CONTENT_REJECTED"
            ? "CONTENT_POLICY_REVIEW_REQUIRED" as const : "UNKNOWN_BILLING" as const }
      : initial;
    // Redeliveries must preserve both the cursor and the evidence revision.
    if (checkpoint.latestInvocationId === observed.invocationId &&
        checkpoint.latestAttemptId === observed.attemptId &&
        checkpoint.lastFailureCode === input.failureCode &&
        checkpoint.settledOutcome === observed.settledOutcome &&
        checkpoint.holdReason === observed.holdReason) return checkpoint;
    return tx.bookFailoverCheckpoint.update({
      where,
      data: {
        settledOutcome: observed.settledOutcome,
        holdReason: observed.holdReason,
        latestInvocationId: observed.invocationId,
        latestAttemptId: observed.attemptId,
        lastFailureCode: input.failureCode,
        revision: { increment: 1 },
        observedAt: new Date(),
      },
    });
  });
}
