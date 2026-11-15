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
    return checkpoint;
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
    const observed = classifyBookFailoverEvidence(input.failureCode, invocation);
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
