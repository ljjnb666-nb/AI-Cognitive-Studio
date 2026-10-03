import { expensiveJobTypes, lockWorkspaceExpensiveOperationCapacity, Prisma, prisma, type ExpensiveOperationRecoveryTarget } from "@ai-cognitive/db";
import { normalizeDispatchGeneration } from "@ai-cognitive/ingestion";
import { rearmBookAnalysisRunById } from "@ai-cognitive/book-intelligence";
import { AUDIO_GENERATION_JOB, convergeSupersededPodcastAudioGenerationById, rearmPodcastAudioGenerationById, rearmPodcastGenerationRunById } from "@ai-cognitive/podcast-generation";
import { SHORT_VIDEO_GENERATION_JOB, rearmShortVideoGenerationRunById } from "@ai-cognitive/short-video-generation";
import { logger } from "@ai-cognitive/shared";
import { BOOK_ANALYSIS_JOB } from "@ai-cognitive/book-intelligence";
import { PODCAST_GENERATION_JOB } from "@ai-cognitive/podcast-generation";

export type DurableOperationDomain = "BOOK_ANALYSIS" | "PODCAST_GENERATION" | "SHORT_VIDEO_GENERATION" | "PODCAST_AUDIO_GENERATION";
export type ReconciliationDecision = "NOOP_ACTIVE_OWNER" | "NOOP_OUTBOX_PENDING" | "NOOP_QUEUE_PRESENT" | "NOOP_QUEUE_DISABLED" | "NOOP_ALREADY_CONVERGED" | "CONVERGED_TERMINAL" | "RECOVERED_TRANSPORT" | "STALE_GENERATION_IGNORED" | "AMBIGUOUS_SKIPPED" | "INFRA_FAILURE";
export const DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE = 25;
export const MAX_DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE = 100;
export const DURABLE_OPERATION_RECONCILIATION_INTERVAL_MS = 60_000;
export type ReconciliationIntervalScheduler = (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;

/** Small timer seam so cadence wiring is testable without waiting 60 seconds. */
export function scheduleDurableOperationReconciliation(run: () => void, schedule: ReconciliationIntervalScheduler = setInterval): ReturnType<typeof setInterval> {
  return schedule(run, DURABLE_OPERATION_RECONCILIATION_INTERVAL_MS);
}

export type ReconciliationCursor = { createdAt: Date; id: string };
export type ReconciliationSweepState = {
  nextLane: "FORWARD" | "REVISIT";
  forwardCursor: ReconciliationCursor | null;
  revisitCursor: ReconciliationCursor | null;
  revisitThrough: ReconciliationCursor | null;
};
export type ReconciliationQueue = {
  getJob(id: string): Promise<{ id: string; data: unknown; getState(): Promise<string> } | null | undefined>;
};
export type ReconciliationQueues = Partial<Record<DurableOperationDomain, ReconciliationQueue>>;
export type ReconciliationTopics = Partial<Record<DurableOperationDomain, string>>;
export type ReconciliationTarget = {
  domain: DurableOperationDomain;
  workspaceId: string;
  jobId: string;
  jobType: string;
  runId: string;
  dispatchGeneration: number;
  runStatus: string;
  jobStatus: string;
  jobQueueId: string | null;
};
export type ReconciliationHooks = {
  /** Deterministic race seam after bounded discovery and before the fresh DB read. */
  afterCandidateDiscovered?: (candidate: ReconciliationTarget) => Promise<void> | void;
  /** Deterministic race seam after transport inspection and before exact rearm. */
  afterTransportInspected?: (candidate: ReconciliationTarget) => Promise<void> | void;
};
export type ReconciliationRecord = {
  domain: DurableOperationDomain;
  workspaceId: string | null;
  jobId: string;
  runId: string | null;
  dispatchGeneration: number | null;
  decision: ReconciliationDecision;
  reason: string;
};
export type ReconciliationBatchResult = {
  discovered: number;
  processed: number;
  converged: number;
  recovered: number;
  skipped: number;
  nextCursor: ReconciliationCursor | null;
  decisions: ReconciliationRecord[];
};

type RunState = {
  id: string;
  workspaceId: string;
  jobId: string;
  status: string;
  dispatchGeneration: number;
  executionClaimToken: string | null;
  executionClaimedAt: Date | null;
  executionLeaseUntil: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
};
type JobState = { id: string; workspaceId: string | null; type: string; status: string; queueJobId: string | null };
type FreshAssessment = { target: ReconciliationTarget } | { record: ReconciliationRecord };
type CandidateRow = {
  id: string;
  workspaceId: string | null;
  type: string;
  status: string;
  createdAt: Date;
  bookAnalysisRun: Pick<RunState, "id" | "workspaceId" | "jobId" | "status" | "dispatchGeneration"> | null;
  podcastGenerationRun: Pick<RunState, "id" | "workspaceId" | "jobId" | "status" | "dispatchGeneration"> | null;
  shortVideoGenerationRun: Pick<RunState, "id" | "workspaceId" | "jobId" | "status" | "dispatchGeneration"> | null;
  audioGenerationRun: Pick<RunState, "id" | "workspaceId" | "jobId" | "status" | "dispatchGeneration"> | null;
};

const domainByJobType: Record<string, DurableOperationDomain> = {
  [BOOK_ANALYSIS_JOB]: "BOOK_ANALYSIS",
  [PODCAST_GENERATION_JOB]: "PODCAST_GENERATION",
  [SHORT_VIDEO_GENERATION_JOB]: "SHORT_VIDEO_GENERATION",
  [AUDIO_GENERATION_JOB]: "PODCAST_AUDIO_GENERATION",
};
const runRelationByDomain: Record<DurableOperationDomain, keyof CandidateRow> = {
  BOOK_ANALYSIS: "bookAnalysisRun",
  PODCAST_GENERATION: "podcastGenerationRun",
  SHORT_VIDEO_GENERATION: "shortVideoGenerationRun",
  PODCAST_AUDIO_GENERATION: "audioGenerationRun",
};
const jobTypeByDomain: Record<DurableOperationDomain, string> = {
  BOOK_ANALYSIS: BOOK_ANALYSIS_JOB,
  PODCAST_GENERATION: PODCAST_GENERATION_JOB,
  SHORT_VIDEO_GENERATION: SHORT_VIDEO_GENERATION_JOB,
  PODCAST_AUDIO_GENERATION: AUDIO_GENERATION_JOB,
};
const runIdFieldByDomain: Record<DurableOperationDomain, string> = {
  BOOK_ANALYSIS: "analysisRunId",
  PODCAST_GENERATION: "podcastGenerationRunId",
  SHORT_VIDEO_GENERATION: "shortVideoGenerationRunId",
  PODCAST_AUDIO_GENERATION: "audioGenerationRunId",
};
const activeStatuses = ["QUEUED", "RUNNING"] as const;
const transportPresentStates = new Set(["waiting", "active", "delayed", "waiting-children", "prioritized", "paused"]);
const transportTerminalStates = new Set(["completed", "failed"]);

function record(input: ReconciliationRecord): ReconciliationRecord {
  const log = {
    domain: input.domain,
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    runId: input.runId,
    dispatchGeneration: input.dispatchGeneration,
    decision: input.decision,
    reason: input.reason,
  };
  if (input.decision === "INFRA_FAILURE" || input.decision === "AMBIGUOUS_SKIPPED") logger.warn("worker.durable_operation_reconciliation", log);
  else logger.info("worker.durable_operation_reconciliation", log);
  return input;
}

function baseRecord(candidate: { domain: DurableOperationDomain; jobId: string; workspaceId: string | null; runId?: string | null; dispatchGeneration?: number | null; generation?: number | null }, decision: ReconciliationDecision, reason: string): ReconciliationRecord {
  return record({ domain: candidate.domain, jobId: candidate.jobId, workspaceId: candidate.workspaceId, runId: candidate.runId ?? null, dispatchGeneration: candidate.dispatchGeneration ?? candidate.generation ?? null, decision, reason });
}

async function discoverCandidates(batchSize: number, cursor: ReconciliationCursor | null, candidateJobIds?: readonly string[], through?: ReconciliationCursor | null): Promise<CandidateRow[]> {
  return await prisma.job.findMany({
    where: {
      ...(candidateJobIds ? { id: { in: [...candidateJobIds] } } : {}),
      type: { in: [...expensiveJobTypes] },
      status: { in: [...activeStatuses] },
      ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}),
      ...(through ? { AND: [{ OR: [{ createdAt: { lt: through.createdAt } }, { createdAt: through.createdAt, id: { lte: through.id } }] }] } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: {
      id: true,
      workspaceId: true,
      type: true,
      status: true,
      createdAt: true,
      bookAnalysisRun: { select: { id: true, workspaceId: true, jobId: true, status: true, dispatchGeneration: true } },
      podcastGenerationRun: { select: { id: true, workspaceId: true, jobId: true, status: true, dispatchGeneration: true } },
      shortVideoGenerationRun: { select: { id: true, workspaceId: true, jobId: true, status: true, dispatchGeneration: true } },
      audioGenerationRun: { select: { id: true, workspaceId: true, jobId: true, status: true, dispatchGeneration: true } },
    },
  }) as CandidateRow[];
}

async function discoverActiveFrontier(candidateJobIds?: readonly string[]): Promise<ReconciliationCursor | null> {
  const row = await prisma.job.findFirst({
    where: {
      ...(candidateJobIds ? { id: { in: [...candidateJobIds] } } : {}),
      type: { in: [...expensiveJobTypes] },
      status: { in: [...activeStatuses] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true, id: true },
  });
  return row;
}

type Candidate = { domain: DurableOperationDomain; jobId: string; workspaceId: string | null; runId: string | null; generation: number | null; identityError?: string };

function makeCandidate(row: CandidateRow): Candidate | null {
  const domain = domainByJobType[row.type];
  if (!domain) return null;
  const fields = row as unknown as Record<string, unknown>;
  const relations = ["bookAnalysisRun", "podcastGenerationRun", "shortVideoGenerationRun", "audioGenerationRun"];
  const relation = fields[runRelationByDomain[domain]] as { id: string; dispatchGeneration: number } | null;
  if (!relation) return { domain, jobId: row.id, workspaceId: row.workspaceId, runId: null, generation: null };
  if (relations.some(name => name !== runRelationByDomain[domain] && fields[name] !== null)) return { domain, jobId: row.id, workspaceId: row.workspaceId, runId: relation.id, generation: relation.dispatchGeneration, identityError: "MULTIPLE_DOMAIN_RUNS" };
  return { domain, jobId: row.id, workspaceId: row.workspaceId, runId: relation.id, generation: relation.dispatchGeneration };
}

async function lockRunRow(tx: Prisma.TransactionClient, domain: DurableOperationDomain, runId: string): Promise<boolean> {
  let rows: Array<{ id: string }> = [];
  switch (domain) {
    case "BOOK_ANALYSIS": rows = await tx.$queryRaw`SELECT "id" FROM "BookAnalysisRun" WHERE "id" = ${runId} FOR UPDATE`; break;
    case "PODCAST_GENERATION": rows = await tx.$queryRaw`SELECT "id" FROM "PodcastGenerationRun" WHERE "id" = ${runId} FOR UPDATE`; break;
    case "SHORT_VIDEO_GENERATION": rows = await tx.$queryRaw`SELECT "id" FROM "ShortVideoGenerationRun" WHERE "id" = ${runId} FOR UPDATE`; break;
    case "PODCAST_AUDIO_GENERATION": rows = await tx.$queryRaw`SELECT "id" FROM "AudioGenerationRun" WHERE "id" = ${runId} FOR UPDATE`; break;
  }
  return rows.length === 1;
}

async function loadRun(tx: Prisma.TransactionClient, domain: DurableOperationDomain, runId: string): Promise<RunState | null> {
  const select = { id: true, workspaceId: true, jobId: true, status: true, dispatchGeneration: true, executionClaimToken: true, executionClaimedAt: true, executionLeaseUntil: true, completedAt: true, errorCode: true } as const;
  switch (domain) {
    case "BOOK_ANALYSIS": return await tx.bookAnalysisRun.findUnique({ where: { id: runId }, select }) as RunState | null;
    case "PODCAST_GENERATION": return await tx.podcastGenerationRun.findUnique({ where: { id: runId }, select }) as RunState | null;
    case "SHORT_VIDEO_GENERATION": return await tx.shortVideoGenerationRun.findUnique({ where: { id: runId }, select }) as RunState | null;
    case "PODCAST_AUDIO_GENERATION": return await tx.audioGenerationRun.findUnique({ where: { id: runId }, select }) as RunState | null;
  }
}

async function clearTerminalLease(tx: Prisma.TransactionClient, domain: DurableOperationDomain, run: RunState): Promise<void> {
  const where = { id: run.id, status: run.status as never };
  const data = { executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null };
  switch (domain) {
    case "BOOK_ANALYSIS": await tx.bookAnalysisRun.updateMany({ where, data }); break;
    case "PODCAST_GENERATION": await tx.podcastGenerationRun.updateMany({ where, data }); break;
    case "SHORT_VIDEO_GENERATION": await tx.shortVideoGenerationRun.updateMany({ where, data }); break;
    case "PODCAST_AUDIO_GENERATION": await tx.audioGenerationRun.updateMany({ where, data }); break;
  }
}

async function suppressUndispatchedTerminalOutbox(tx: Prisma.TransactionClient, domain: DurableOperationDomain, runId: string): Promise<void> {
  const runIdField = runIdFieldByDomain[domain];
  await tx.$executeRaw`UPDATE "OutboxEvent"
SET "status" = 'FAILED'::"OutboxStatus", "leaseUntil" = NULL, "claimToken" = NULL,
    "lastError" = 'PR_A_TARGET_TERMINAL', "updatedAt" = NOW()
WHERE "aggregateId" = ${runId}
  AND "payload" ->> ${runIdField} = ${runId}
  AND ("status" = 'PENDING'::"OutboxStatus" OR ("status" = 'PROCESSING'::"OutboxStatus" AND "leaseUntil" < NOW()))`;
}

async function assessFreshCandidate(candidate: { domain: DurableOperationDomain; jobId: string; workspaceId: string | null; runId: string; generation: number }): Promise<FreshAssessment> {
  return await prisma.$transaction(async tx => {
    if (!(await lockRunRow(tx, candidate.domain, candidate.runId))) return { record: baseRecord(candidate, "AMBIGUOUS_SKIPPED", "DURABLE_RUN_MISSING") };
    const run = await loadRun(tx, candidate.domain, candidate.runId);
    const job = await tx.job.findUnique({ where: { id: candidate.jobId }, select: { id: true, workspaceId: true, type: true, status: true, queueJobId: true } }) as JobState | null;
    const expectedType = jobTypeByDomain[candidate.domain];
    if (!run || !job || !candidate.workspaceId || job.id !== run.jobId || job.workspaceId !== run.workspaceId || job.workspaceId !== candidate.workspaceId || job.type !== expectedType || run.workspaceId !== candidate.workspaceId) {
      return { record: baseRecord(candidate, "AMBIGUOUS_SKIPPED", "JOB_RUN_IDENTITY_MISMATCH") };
    }

    if (run.status === "SUCCEEDED" || run.status === "FAILED") {
      const shouldConverge = activeStatuses.includes(job.status as typeof activeStatuses[number]);
      if (shouldConverge) {
        await lockWorkspaceExpensiveOperationCapacity(tx, run.workspaceId);
        const jobStatus = run.status;
        const changed = await tx.job.updateMany({
          where: { id: job.id, workspaceId: run.workspaceId, type: expectedType, status: { in: [...activeStatuses] } },
          data: {
            status: jobStatus as "SUCCEEDED" | "FAILED",
            ...(jobStatus === "SUCCEEDED" ? { progress: 100, error: Prisma.JsonNull } : { error: { code: run.errorCode ?? "BUSINESS_OPERATION_FAILED" } }),
            completedAt: run.completedAt ?? new Date(),
          },
        });
        await clearTerminalLease(tx, candidate.domain, run);
        await suppressUndispatchedTerminalOutbox(tx, candidate.domain, run.id);
        if (changed.count === 1) return { record: baseRecord({ ...candidate, workspaceId: run.workspaceId, runId: run.id, dispatchGeneration: run.dispatchGeneration }, "CONVERGED_TERMINAL", run.status === "SUCCEEDED" ? "BUSINESS_SUCCEEDED" : "BUSINESS_FAILED") };
        return { record: baseRecord({ ...candidate, workspaceId: run.workspaceId, runId: run.id, dispatchGeneration: run.dispatchGeneration }, "NOOP_ALREADY_CONVERGED", "JOB_BECAME_TERMINAL") };
      }
      await clearTerminalLease(tx, candidate.domain, run);
      await suppressUndispatchedTerminalOutbox(tx, candidate.domain, run.id);
      return { record: baseRecord({ ...candidate, workspaceId: run.workspaceId, runId: run.id, dispatchGeneration: run.dispatchGeneration }, "NOOP_ALREADY_CONVERGED", "JOB_ALREADY_TERMINAL") };
    }

    if (run.dispatchGeneration !== candidate.generation) return { record: baseRecord({ ...candidate, workspaceId: run.workspaceId, runId: run.id, dispatchGeneration: run.dispatchGeneration }, "STALE_GENERATION_IGNORED", "CURRENT_GENERATION_CHANGED") };
    if (!(activeStatuses.includes(job.status as typeof activeStatuses[number]) && activeStatuses.includes(run.status as typeof activeStatuses[number]))) return { record: baseRecord(candidate, "AMBIGUOUS_SKIPPED", "ACTIVE_STATE_MISMATCH") };
    if (job.status !== run.status) return { record: baseRecord(candidate, "AMBIGUOUS_SKIPPED", "JOB_RUN_STATUS_MISMATCH") };

    const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS "now"`)[0]!.now;
    if (run.status === "RUNNING") {
      const allLeaseFieldsAbsent = run.executionClaimToken === null && run.executionClaimedAt === null && run.executionLeaseUntil === null;
      const leaseFieldsComplete = run.executionClaimToken !== null && run.executionClaimedAt !== null && run.executionLeaseUntil !== null;
      if (leaseFieldsComplete && run.executionLeaseUntil! > now) return { record: baseRecord({ ...candidate, workspaceId: run.workspaceId, runId: run.id, dispatchGeneration: run.dispatchGeneration }, "NOOP_ACTIVE_OWNER", "CURRENT_LEASE_VALID") };
      if (!allLeaseFieldsAbsent && !leaseFieldsComplete) return { record: baseRecord(candidate, "AMBIGUOUS_SKIPPED", "LEASE_METADATA_INCONSISTENT") };
    } else if (run.executionClaimToken !== null || run.executionClaimedAt !== null || run.executionLeaseUntil !== null) {
      return { record: baseRecord(candidate, "AMBIGUOUS_SKIPPED", "QUEUED_RUN_HAS_LEASE_METADATA") };
    }
    return {
      target: {
        domain: candidate.domain,
        workspaceId: run.workspaceId,
        jobId: job.id,
        jobType: expectedType,
        runId: run.id,
        dispatchGeneration: run.dispatchGeneration,
        runStatus: run.status,
        jobStatus: job.status,
        jobQueueId: job.queueJobId,
      },
    };
  });
}

function currentEventIdentity(domain: DurableOperationDomain, runId: string, payload: unknown): { generation: number; queueJobId: string } | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const runField = runIdFieldByDomain[domain];
  if (value[runField] !== runId) return null;
  let generation: number;
  try { generation = normalizeDispatchGeneration(value); } catch { return null; }
  if (domain === "BOOK_ANALYSIS") {
    const base = value.queueJobId;
    if (base !== undefined && (typeof base !== "string" || !base)) return null;
    const queueBase = typeof base === "string" ? base : runId;
    return { generation, queueJobId: generation === 0 ? queueBase : `${queueBase}-g${generation}` };
  }
  if (domain === "PODCAST_AUDIO_GENERATION") return { generation, queueJobId: generation === 0 ? runId : `podcast-audio-${runId}-g${generation}` };
  return { generation, queueJobId: generation === 0 ? runId : `${runId}-g${generation}` };
}

async function inspectCurrentOutbox(target: ReconciliationTarget): Promise<{ queueJobId: string } | { record: ReconciliationRecord }> {
  const events = await prisma.outboxEvent.findMany({
    where: { aggregateId: target.runId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE,
    select: { id: true, status: true, payload: true },
  });
  const matching: Array<{ status: string; queueJobId: string }> = [];
  let sawStale = false;
  for (const event of events) {
    const identity = currentEventIdentity(target.domain, target.runId, event.payload);
    if (!identity) return { record: baseRecord(target, "AMBIGUOUS_SKIPPED", "OUTBOX_PAYLOAD_INVALID") };
    if (identity.generation < target.dispatchGeneration) { sawStale = true; continue; }
    if (identity.generation > target.dispatchGeneration) return { record: baseRecord(target, "AMBIGUOUS_SKIPPED", "OUTBOX_GENERATION_AHEAD") };
    matching.push({ status: event.status, queueJobId: identity.queueJobId });
  }
  if (matching.length === 0) return { record: baseRecord(target, sawStale ? "STALE_GENERATION_IGNORED" : "AMBIGUOUS_SKIPPED", sawStale ? "ONLY_STALE_OUTBOX_EXISTS" : "CURRENT_OUTBOX_MISSING") };
  const queueIds = new Set(matching.map(event => event.queueJobId));
  if (queueIds.size !== 1) return { record: baseRecord(target, "AMBIGUOUS_SKIPPED", "CONFLICTING_QUEUE_IDENTITIES") };
  if (matching.some(event => event.status === "PENDING" || event.status === "PROCESSING")) return { record: baseRecord(target, "NOOP_OUTBOX_PENDING", "OUTBOX_DISPATCH_IN_PROGRESS") };
  if (matching.some(event => event.status !== "DISPATCHED" && event.status !== "FAILED")) return { record: baseRecord(target, "AMBIGUOUS_SKIPPED", "OUTBOX_STATUS_UNSUPPORTED") };
  const queueJobId = matching[0]!.queueJobId;
  if (matching.some(event => event.status === "DISPATCHED") && target.jobQueueId !== queueJobId) return { record: baseRecord(target, "AMBIGUOUS_SKIPPED", "DISPATCHED_QUEUE_ID_MISMATCH") };
  if (target.jobQueueId !== null && target.jobQueueId !== queueJobId) return { record: baseRecord(target, "STALE_GENERATION_IGNORED", "JOB_QUEUE_ID_IS_NOT_CURRENT") };
  return { queueJobId };
}

function validQueuePayload(target: ReconciliationTarget, payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  if (value[runIdFieldByDomain[target.domain]] !== target.runId) return false;
  try { return normalizeDispatchGeneration(value) === target.dispatchGeneration; } catch { return false; }
}

async function invokeExactRecovery(target: ReconciliationTarget, topic?: string): Promise<string> {
  const expected: ExpensiveOperationRecoveryTarget = { workspaceId: target.workspaceId, jobId: target.jobId, jobType: target.jobType };
  switch (target.domain) {
    case "BOOK_ANALYSIS": return await rearmBookAnalysisRunById(target.runId, target.dispatchGeneration, topic, expected);
    case "PODCAST_GENERATION": return await rearmPodcastGenerationRunById(target.runId, target.dispatchGeneration, topic, expected);
    case "SHORT_VIDEO_GENERATION": return await rearmShortVideoGenerationRunById(target.runId, target.dispatchGeneration, topic, expected);
    case "PODCAST_AUDIO_GENERATION": return await rearmPodcastAudioGenerationById(target.runId, target.dispatchGeneration, topic, expected);
  }
}

async function reconcileOne(candidate: Candidate, options: { queues: ReconciliationQueues; topics: ReconciliationTopics; hooks: ReconciliationHooks }): Promise<ReconciliationRecord> {
  if (candidate.identityError) return baseRecord(candidate, "AMBIGUOUS_SKIPPED", candidate.identityError);
  const { runId, generation, workspaceId } = candidate;
  if (!runId || generation === null || !workspaceId) return baseRecord(candidate, "AMBIGUOUS_SKIPPED", "DURABLE_RUN_IDENTITY_MISSING");
  const freshCandidate = { domain: candidate.domain, jobId: candidate.jobId, workspaceId, runId, generation };
  await options.hooks.afterCandidateDiscovered?.({ domain: candidate.domain, jobId: candidate.jobId, workspaceId, runId, dispatchGeneration: generation, jobType: jobTypeByDomain[candidate.domain], runStatus: "DISCOVERED", jobStatus: "DISCOVERED", jobQueueId: null });
  const assessed = await assessFreshCandidate(freshCandidate);
  if ("record" in assessed) return assessed.record;
  const target = assessed.target;
  const outbox = await inspectCurrentOutbox(target);
  if ("record" in outbox) return outbox.record;
  const queue = options.queues[target.domain];
  if (!queue) return baseRecord(target, "NOOP_QUEUE_DISABLED", "DOMAIN_QUEUE_UNAVAILABLE");

  let lostTransport = false;
  const queuedJob = await queue.getJob(outbox.queueJobId);
  if (queuedJob) {
    if (queuedJob.id !== outbox.queueJobId || !validQueuePayload(target, queuedJob.data)) return baseRecord(target, "AMBIGUOUS_SKIPPED", "QUEUE_JOB_IDENTITY_MISMATCH");
    const queueState = await queuedJob.getState();
    if (transportPresentStates.has(queueState)) return baseRecord(target, "NOOP_QUEUE_PRESENT", "CURRENT_QUEUE_JOB_PRESENT");
    if (!transportTerminalStates.has(queueState)) return baseRecord(target, "AMBIGUOUS_SKIPPED", "QUEUE_STATE_UNRECOGNIZED");
    lostTransport = true;
  } else {
    lostTransport = true;
  }
  if (!lostTransport) return baseRecord(target, "AMBIGUOUS_SKIPPED", "TRANSPORT_STATE_UNCLASSIFIED");
  await options.hooks.afterTransportInspected?.(target);
  const recovery = await invokeExactRecovery(target, options.topics[target.domain]);
  if (recovery === "REARMED") return baseRecord(target, "RECOVERED_TRANSPORT", "CURRENT_GENERATION_TRANSPORT_LOST");

  if (recovery === "SUPERSEDED" && target.domain === "PODCAST_AUDIO_GENERATION") {
    const convergence = await convergeSupersededPodcastAudioGenerationById(target.runId, target.dispatchGeneration, { workspaceId: target.workspaceId, jobId: target.jobId, jobType: target.jobType });
    if (convergence === "CONVERGED") return baseRecord(target, "CONVERGED_TERMINAL", "AUDIO_GENERATION_SUPERSEDED");
    if (convergence === "PAID_OUTCOME_QUARANTINED") return baseRecord(target, "AMBIGUOUS_SKIPPED", "AUDIO_PAID_OUTCOME_QUARANTINED");
    if (convergence === "RACE_LOST") return baseRecord(target, "STALE_GENERATION_IGNORED", "AUDIO_TARGET_GENERATION_CHANGED");
    const refreshed = await assessFreshCandidate(freshCandidate);
    if ("record" in refreshed) return refreshed.record;
    return baseRecord(refreshed.target, "AMBIGUOUS_SKIPPED", convergence === "SUPERSEDER_LOCKED" ? "AUDIO_SUPERSEDER_REVALIDATION_LOCKED" : "AUDIO_SUPERSEDED_PEER_NO_LONGER_LEGITIMATE");
  }

  const refreshed = await assessFreshCandidate(freshCandidate);
  if ("record" in refreshed) return refreshed.record;
  if (recovery === "PAID_OUTCOME_QUARANTINED") return baseRecord(refreshed.target, "AMBIGUOUS_SKIPPED", "AUDIO_PAID_OUTCOME_QUARANTINED");
  if (recovery === "CAPACITY_BLOCKED") return baseRecord(refreshed.target, "AMBIGUOUS_SKIPPED", "CAPACITY_RECHECK_BLOCKED");
  return baseRecord(refreshed.target, "AMBIGUOUS_SKIPPED", "EXACT_RECOVERY_REJECTED");
}

async function processCandidates(candidates: CandidateRow[], requested: number, settings: { queues: ReconciliationQueues; topics: ReconciliationTopics; hooks: ReconciliationHooks }): Promise<ReconciliationBatchResult> {
  const result: ReconciliationBatchResult = { discovered: candidates.length, processed: 0, converged: 0, recovered: 0, skipped: 0, nextCursor: candidates.length === requested ? { createdAt: candidates[candidates.length - 1]!.createdAt, id: candidates[candidates.length - 1]!.id } : null, decisions: [] };
  for (const row of candidates) {
    const candidate = makeCandidate(row);
    if (!candidate) continue;
    let outcome: ReconciliationRecord;
    try {
      outcome = await reconcileOne(candidate, settings);
    } catch {
      outcome = baseRecord(candidate, "INFRA_FAILURE", "CANDIDATE_RECONCILIATION_FAILED");
    }
    result.processed += 1;
    if (outcome.decision === "CONVERGED_TERMINAL") result.converged += 1;
    else if (outcome.decision === "RECOVERED_TRANSPORT") result.recovered += 1;
    else result.skipped += 1;
    result.decisions.push(outcome);
  }
  return result;
}

/** One stable keyset page; it does not replay providers and never scans without a bound. */
export async function reconcileDurableExpensiveOperationsBatch(options: {
  cursor?: ReconciliationCursor | null;
  batchSize?: number;
  /** Optional exact-ID restriction for deterministic callers and integration tests. */
  candidateJobIds?: readonly string[];
  queues?: ReconciliationQueues;
  topics?: ReconciliationTopics;
  hooks?: ReconciliationHooks;
} = {}): Promise<ReconciliationBatchResult> {
  const requested = options.batchSize ?? DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE) throw new Error("DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE_INVALID");
  const candidates = await discoverCandidates(requested, options.cursor ?? null, options.candidateJobIds);
  return processCandidates(candidates, requested, { queues: options.queues ?? {}, topics: options.topics ?? {}, hooks: options.hooks ?? {} });
}

/**
 * Runs one bounded lane per sweep. The forward keyset visits every row in
 * stable order; the revisit lane repeatedly scans only through a captured
 * active-row frontier. Alternating the lanes guarantees that arrivals cannot
 * extend a revisit epoch forever and that revisits cannot starve forward work.
 */
export async function reconcileDurableExpensiveOperationsSweep(options: {
  state?: ReconciliationSweepState;
  batchSize?: number;
  candidateJobIds?: readonly string[];
  queues?: ReconciliationQueues;
  topics?: ReconciliationTopics;
  hooks?: ReconciliationHooks;
} = {}): Promise<ReconciliationBatchResult & { lane: "FORWARD" | "REVISIT"; nextState: ReconciliationSweepState }> {
  const requested = options.batchSize ?? DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE) throw new Error("DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE_INVALID");
  const state = options.state ?? { nextLane: "FORWARD", forwardCursor: null, revisitCursor: null, revisitThrough: null };
  const lane = state.nextLane;
  const settings = { queues: options.queues ?? {}, topics: options.topics ?? {}, hooks: options.hooks ?? {} };
  if (lane === "FORWARD") {
    const result = await reconcileDurableExpensiveOperationsBatch({ ...settings, batchSize: requested, candidateJobIds: options.candidateJobIds, cursor: state.forwardCursor });
    return { ...result, lane, nextState: { ...state, forwardCursor: result.nextCursor, nextLane: "REVISIT" } };
  }

  const through = state.revisitThrough ?? await discoverActiveFrontier(options.candidateJobIds);
  if (!through) {
    const empty: ReconciliationBatchResult = { discovered: 0, processed: 0, converged: 0, recovered: 0, skipped: 0, nextCursor: null, decisions: [] };
    return { ...empty, lane, nextState: { ...state, revisitCursor: null, revisitThrough: null, nextLane: "FORWARD" } };
  }
  const candidates = await discoverCandidates(requested, state.revisitCursor, options.candidateJobIds, through);
  const result = await processCandidates(candidates, requested, settings);
  const epochComplete = candidates.length < requested;
  return {
    ...result,
    lane,
    nextState: {
      ...state,
      revisitCursor: epochComplete ? null : result.nextCursor,
      revisitThrough: epochComplete ? null : through,
      nextLane: "FORWARD",
    },
  };
}
