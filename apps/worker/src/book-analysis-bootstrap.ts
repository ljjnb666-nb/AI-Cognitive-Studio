import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { prisma, workspaceExpensiveOperationCapacityAvailable } from "@ai-cognitive/db";
import { materializeChunkSet, requestBookAnalysisForUser, resolveBookAnalysisVersions, resolveBookProductExecution } from "@ai-cognitive/book-intelligence";
import { BOOK_ANALYSIS_BOOTSTRAP_TOPIC, dispatchPendingOutbox } from "@ai-cognitive/ingestion";
import { resolveCredentialKeyring } from "@ai-cognitive/provider-gateway";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export const BOOK_ANALYSIS_BOOTSTRAP_QUEUE = "book.analysis.bootstrap";
export const BOOK_ANALYSIS_BOOTSTRAP_JOB = "book.analysis.bootstrap";
export type BookAnalysisBootstrapPayload = { bootstrapId: string; dispatchGeneration: number };
export type BookAnalysisBootstrapBlockingReason = "NONE" | "CAPACITY_LIMIT" | "PROVIDER_NOT_READY" | "ACTIVE_LEASE" | "RECOVERY_REQUIRED";
export type BookAnalysisBootstrapQueueOptions = { prefix?: string; concurrency?: number; source?: NodeJS.ProcessEnv };
export type BookAnalysisBootstrapFaultPoint = "afterClaim" | "afterChunkSetMaterialization" | "afterBookAnalysisRequest";
export type ProcessBookAnalysisBootstrapOptions = { source?: NodeJS.ProcessEnv; expectedDispatchGeneration?: number; faultInjector?: (point: BookAnalysisBootstrapFaultPoint, input: { bootstrapId: string; analysisRunId?: string }) => Promise<void> | void };
/**
 * BullMQ forbids ':' in custom job IDs. Keep the durable bootstrap generation
 * in the identity so retries deduplicate while a rearmed generation is new.
 */
export function bookAnalysisBootstrapJobId(payload: BookAnalysisBootstrapPayload): string {
  return `book-analysis-bootstrap-${payload.bootstrapId}-g${payload.dispatchGeneration}`;
}
const readyErrors = new Set(["AI_PROVIDER_CONFIGURATION_REQUIRED", "BOOK_EMBEDDING_PROVIDER_NOT_CONFIGURED"]);
const capacityError = "WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED";
const errorCode = (error: unknown): string => error instanceof Error ? error.message.split(":")[0] ?? "BOOK_ANALYSIS_BOOTSTRAP_FAILED" : "BOOK_ANALYSIS_BOOTSTRAP_FAILED";
const assertGatewayRuntimeReady = (source: NodeJS.ProcessEnv = process.env) => { if (!resolveCredentialKeyring(source)) throw new Error("AI_PROVIDER_CONFIGURATION_REQUIRED"); };
const workspaceOperationLimit = (source: NodeJS.ProcessEnv = process.env) => Number(source.WORKSPACE_EXPENSIVE_OPERATION_LIMIT ?? "2");
const permanentCodes = new Set(["BOOK_ANALYSIS_BOOTSTRAP_LINEAGE_INVALID", "BOOK_ANALYSIS_BOOTSTRAP_CURRENT_EXTRACTION_MISMATCH", "INGESTION_INITIATOR_REQUIRED"]);
export function classifyBootstrapError(error: unknown): "PERMANENT" | "RECOVERABLE" { const code = errorCode(error); if (permanentCodes.has(code)) return "PERMANENT"; const structured = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : ""; if (["ECONNRESET", "ETIMEDOUT", "P1001", "P2024"].includes(structured)) return "RECOVERABLE"; return "RECOVERABLE"; }
export function bookAnalysisBootstrapBlockingReason(input: { status: string; errorCode?: string | null; executionLeaseUntil?: Date | null }, now = new Date()): BookAnalysisBootstrapBlockingReason {
  if (input.executionLeaseUntil && input.executionLeaseUntil > now) return "ACTIVE_LEASE";
  if (input.errorCode === capacityError) return "CAPACITY_LIMIT";
  if (input.status === "WAITING_FOR_PROVIDER") return "PROVIDER_NOT_READY";
  if (input.status === "RUNNING" && input.executionLeaseUntil && input.executionLeaseUntil <= now) return "RECOVERY_REQUIRED";
  return "NONE";
}

async function claimBootstrap(id: string, expectedGeneration: number, token: string): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE "BookAnalysisBootstrap"
    SET "status" = 'RUNNING'::"BookAnalysisBootstrapStatus", "startedAt" = COALESCE("startedAt", NOW()), "completedAt" = NULL,
        "errorCode" = NULL, "executionClaimToken" = ${token}, "executionClaimedAt" = NOW(), "executionLeaseUntil" = NOW() + INTERVAL '2 minutes'
    WHERE "id" = ${id} AND "dispatchGeneration" = ${expectedGeneration} AND "status" IN ('PENDING'::"BookAnalysisBootstrapStatus", 'RUNNING'::"BookAnalysisBootstrapStatus")
      AND ("executionClaimToken" IS NULL OR "executionLeaseUntil" < NOW())`;
  return changed === 1;
}
async function owned(id: string, token: string, data: Record<string, unknown>) {
  const changed = await prisma.bookAnalysisBootstrap.updateMany({ where: { id, executionClaimToken: token, status: "RUNNING", executionLeaseUntil: { gt: new Date() } }, data });
  if (changed.count !== 1) throw new Error("BOOK_ANALYSIS_BOOTSTRAP_OWNERSHIP_LOST");
}
export async function renewBookAnalysisBootstrapLease(id: string, token: string, leaseMs = 120_000): Promise<void> {
  const changed = await prisma.$executeRaw`
    UPDATE "BookAnalysisBootstrap" SET "executionLeaseUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond')
    WHERE "id" = ${id} AND "status" = 'RUNNING'::"BookAnalysisBootstrapStatus"
      AND "executionClaimToken" = ${token} AND "executionLeaseUntil" > NOW()`;
  if (changed !== 1) throw new Error("BOOK_ANALYSIS_BOOTSTRAP_OWNERSHIP_LOST");
}
async function waitForProvider(id: string, token: string, code: string) {
  await owned(id, token, { status: "WAITING_FOR_PROVIDER", errorCode: code, executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null });
}
async function deferForCapacity(id: string, token: string) {
  // Backpressure is not an execution retry: retain its normal retry budget and
  // let the reconciler rediscover this explicit blocking reason.
  await owned(id, token, { status: "PENDING", errorCode: capacityError, nextAttemptAt: null, executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null });
}
async function capacityAvailable(workspaceId: string, source: NodeJS.ProcessEnv = process.env) {
  return prisma.$transaction(tx => workspaceExpensiveOperationCapacityAvailable(tx, workspaceId, workspaceOperationLimit(source)));
}

/** PostgreSQL is the authority: BullMQ carries only this durable intent ID. */
export async function processBookAnalysisBootstrap(bootstrapId: string, options: ProcessBookAnalysisBootstrapOptions = {}) {
  const initial = await prisma.bookAnalysisBootstrap.findUnique({ where: { id: bootstrapId } });
  if (!initial || initial.status === "SUCCEEDED" || initial.status === "FAILED_TERMINAL") return;
  const expectedGeneration = options.expectedDispatchGeneration;
  if (typeof expectedGeneration !== "number" || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) return;
  const token = randomUUID();
  if (!await claimBootstrap(bootstrapId, expectedGeneration, token)) return;
  try {
    await options.faultInjector?.("afterClaim", { bootstrapId });
    const bootstrap = await prisma.bookAnalysisBootstrap.findUniqueOrThrow({ where: { id: bootstrapId }, include: { ingestionRun: { include: { job: true } }, sourceDocument: true, extraction: true, requestedBy: true } });
    if (bootstrap.ingestionRun.status !== "SUCCEEDED" || bootstrap.ingestionRun.workspaceId !== bootstrap.workspaceId || bootstrap.ingestionRun.sourceDocumentId !== bootstrap.sourceDocumentId || bootstrap.extraction.ingestionRunId !== bootstrap.ingestionRunId || bootstrap.extraction.sourceDocumentId !== bootstrap.sourceDocumentId || bootstrap.requestedBy.workspaceId !== bootstrap.workspaceId || bootstrap.requestedBy.userId !== bootstrap.requestedByUserId) throw new Error("BOOK_ANALYSIS_BOOTSTRAP_LINEAGE_INVALID");
    const current = await prisma.currentDocumentExtraction.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: bootstrap.sourceDocumentId, workspaceId: bootstrap.workspaceId } } });
    if (!current || current.extractionId !== bootstrap.extractionId) throw new Error("BOOK_ANALYSIS_BOOTSTRAP_CURRENT_EXTRACTION_MISMATCH");
    assertGatewayRuntimeReady(options.source);
    if (!await capacityAvailable(bootstrap.workspaceId, options.source)) { await deferForCapacity(bootstrapId, token); return; }
    const chunkSet = await materializeChunkSet({ workspaceId: bootstrap.workspaceId, sourceDocumentId: bootstrap.sourceDocumentId, correlationId: bootstrap.id });
    await renewBookAnalysisBootstrapLease(bootstrap.id, token);
    await options.faultInjector?.("afterChunkSetMaterialization", { bootstrapId: bootstrap.id });
    const execution = await resolveBookProductExecution(bootstrap.workspaceId);
    await renewBookAnalysisBootstrapLease(bootstrap.id, token);
    const requested = await requestBookAnalysisForUser({ workspaceId: bootstrap.workspaceId, userId: bootstrap.requestedByUserId }, { sourceDocumentId: bootstrap.sourceDocumentId, chunkSetId: chunkSet.id, ...resolveBookAnalysisVersions(options.source), provider: execution.provider, model: execution.model, modelVersion: execution.modelVersion, routePlan: execution.routePlan, correlationId: bootstrap.id });
    await options.faultInjector?.("afterBookAnalysisRequest", { bootstrapId: bootstrap.id, analysisRunId: requested.run.id });
    await owned(bootstrap.id, token, { status: "SUCCEEDED", analysisRunId: requested.run.id, errorCode: null, completedAt: new Date(), executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null });
  } catch (error) {
    const code = errorCode(error);
    // Test-only crash seams deliberately preserve the durable RUNNING claim.
    // A real process crash has the same shape: the lease expires and BullMQ's
    // stalled-job recovery can safely redeliver the deterministic bootstrap ID.
    if (code === "BOOK_ANALYSIS_BOOTSTRAP_SIMULATED_CRASH") throw error;
    if (readyErrors.has(code)) { await waitForProvider(bootstrapId, token, code); return; }
    if (code === capacityError) { await deferForCapacity(bootstrapId, token); return; }
    if (classifyBootstrapError(error) === "RECOVERABLE") { const retryCount = Number((initial as { retryCount?: number }).retryCount ?? 0) + 1, delay = Math.min(300_000, 5_000 * 2 ** Math.min(retryCount, 6)); await owned(bootstrapId, token, { status: "PENDING", errorCode: code, retryCount, nextAttemptAt: new Date(Date.now() + delay), executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null }); return; }
    await owned(bootstrapId, token, { status: "FAILED_TERMINAL", errorCode: code, completedAt: new Date(), executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null });
    throw error;
  }
}

export function createBookAnalysisBootstrapWorker(environment: Environment, options: BookAnalysisBootstrapQueueOptions = {}) {
  return new Worker<BookAnalysisBootstrapPayload>(BOOK_ANALYSIS_BOOTSTRAP_QUEUE, job => processBookAnalysisBootstrap(job.data.bootstrapId, { source: options.source, expectedDispatchGeneration: job.data.dispatchGeneration }), { connection: createRedisConnection(environment.REDIS_URL), concurrency: options.concurrency ?? environment.WORKER_BOOK_ANALYSIS_CONCURRENCY ?? 1, ...(options.prefix ? { prefix: options.prefix } : {}) });
}
export function createBookAnalysisBootstrapQueue(environment: Environment, options: BookAnalysisBootstrapQueueOptions = {}) { return new Queue<BookAnalysisBootstrapPayload>(BOOK_ANALYSIS_BOOTSTRAP_QUEUE, { connection: createRedisConnection(environment.REDIS_URL), ...(options.prefix ? { prefix: options.prefix } : {}) }); }
export function dispatchBookAnalysisBootstrapWithQueue(queue: Queue<BookAnalysisBootstrapPayload>, options: { batchSize?: number; leaseMs?: number; maxAttempts?: number; dispatchConcurrency?: number; aggregateIds?: string[]; topic?: string } = {}) {
  const { topic = BOOK_ANALYSIS_BOOTSTRAP_TOPIC, ...rest } = options;
  return dispatchPendingOutbox<BookAnalysisBootstrapPayload>({ topic, queue, jobName: BOOK_ANALYSIS_BOOTSTRAP_JOB, parse: payload => payload as BookAnalysisBootstrapPayload, jobId: bookAnalysisBootstrapJobId, ...rest });
}

export type HistoricalBookAnalysisBootstrapAdoption = "ADOPTED" | "ALREADY_ADOPTED" | "NOT_FOUND" | "NOT_ELIGIBLE";

/**
 * Adopts one immutable, successful ingestion lineage into a durable bootstrap.
 * This intentionally performs no Provider work or queue dispatch; those belong
 * to the ordinary outbox dispatcher and bootstrap worker respectively.
 */
export async function adoptHistoricalBookAnalysisBootstrapForIngestionRun(ingestionRunId: string): Promise<HistoricalBookAnalysisBootstrapAdoption> {
  return prisma.$transaction(async tx => {
    // Serializing on the immutable ingestion row makes direct callers and the
    // batch reconciler duplicate-safe without selecting another ingestion run.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "IngestionRun" WHERE "id" = ${ingestionRunId} FOR UPDATE`;
    if (locked.length !== 1) return "NOT_FOUND";
    const run = await tx.ingestionRun.findUniqueOrThrow({ where: { id: ingestionRunId }, include: { job: { select: { userId: true } }, extraction: { select: { id: true } } } });
    if (run.status !== "SUCCEEDED" || !run.extraction || !run.job.userId) return "NOT_ELIGIBLE";
    const current = await tx.currentDocumentExtraction.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: run.sourceDocumentId, workspaceId: run.workspaceId } } });
    if (!current || current.extractionId !== run.extraction.id) return "NOT_ELIGIBLE";
    const existing = await tx.bookAnalysisBootstrap.findUnique({ where: { ingestionRunId: run.id }, select: { id: true } });
    if (existing) return "ALREADY_ADOPTED";
    const bootstrap = await tx.bookAnalysisBootstrap.create({ data: { workspaceId: run.workspaceId, sourceDocumentId: run.sourceDocumentId, ingestionRunId: run.id, extractionId: run.extraction.id, requestedByUserId: run.job.userId } });
    await tx.outboxEvent.create({ data: { topic: BOOK_ANALYSIS_BOOTSTRAP_TOPIC, aggregateId: bootstrap.id, payload: { bootstrapId: bootstrap.id, dispatchGeneration: bootstrap.dispatchGeneration } } });
    return "ADOPTED";
  });
}

/** Discovers historical candidates; exact adoption and its transaction live above. */
export async function reconcileHistoricalBookAnalysisBootstraps(limit = 25) {
  const candidates = await prisma.ingestionRun.findMany({
    where: { status: "SUCCEEDED", bookAnalysisBootstrap: null, extraction: { isNot: null }, sourceDocument: { currentExtraction: { isNot: null } } },
    orderBy: { completedAt: "asc" }, take: limit,
    select: { id: true },
  });
  let adopted = 0;
  for (const candidate of candidates) {
    if (await adoptHistoricalBookAnalysisBootstrapForIngestionRun(candidate.id) === "ADOPTED") adopted += 1;
  }
  return adopted;
}
export type BookAnalysisBootstrapRearm = "REARMED" | "NOT_FOUND" | "NOT_ELIGIBLE" | "NOT_READY" | "CAPACITY_DEFERRED";

/** Rearms exactly one durable bootstrap; readiness always precedes mutation. */
export async function rearmBookAnalysisBootstrapById(bootstrapId: string, source: NodeJS.ProcessEnv = process.env): Promise<BookAnalysisBootstrapRearm> {
  const bootstrap = await prisma.bookAnalysisBootstrap.findUnique({ where: { id: bootstrapId }, select: { id: true, status: true, workspaceId: true, nextAttemptAt: true, executionLeaseUntil: true, errorCode: true, analysisRunId: true } });
  if (!bootstrap) return "NOT_FOUND";
  const now = new Date();
  const capacityBlocked = bootstrap.status === "PENDING" && bootstrap.errorCode === capacityError && !bootstrap.analysisRunId && !bootstrap.executionLeaseUntil;
  const eligible = bootstrap.status === "WAITING_FOR_PROVIDER" || capacityBlocked || (bootstrap.status === "PENDING" && !!bootstrap.nextAttemptAt && bootstrap.nextAttemptAt <= now) || (bootstrap.status === "RUNNING" && !!bootstrap.executionLeaseUntil && bootstrap.executionLeaseUntil < now);
  if (!eligible) return "NOT_ELIGIBLE";
  try { assertGatewayRuntimeReady(source); await resolveBookProductExecution(bootstrap.workspaceId); }
  catch (error) { if (readyErrors.has(errorCode(error))) return "NOT_READY"; throw error; }
  const result = await prisma.$transaction(async tx => {
    if (!await workspaceExpensiveOperationCapacityAvailable(tx, bootstrap.workspaceId, workspaceOperationLimit(source))) return "CAPACITY_DEFERRED" as const;
    const changed = bootstrap.status === "RUNNING"
      ? await tx.$queryRaw<Array<{ dispatchGeneration: number }>>`UPDATE "BookAnalysisBootstrap" SET "status" = 'PENDING'::"BookAnalysisBootstrapStatus", "errorCode" = NULL, "nextAttemptAt" = NULL, "dispatchGeneration" = "dispatchGeneration" + 1, "executionClaimToken" = NULL, "executionClaimedAt" = NULL, "executionLeaseUntil" = NULL WHERE "id" = ${bootstrap.id} AND "status" = 'RUNNING'::"BookAnalysisBootstrapStatus" AND "executionLeaseUntil" < NOW() RETURNING "dispatchGeneration"`
      : await tx.bookAnalysisBootstrap.updateMany({ where: { id: bootstrap.id, status: bootstrap.status, analysisRunId: null, ...(capacityBlocked ? { errorCode: capacityError, executionLeaseUntil: null } : bootstrap.status === "PENDING" ? { nextAttemptAt: { lte: now } } : {}) }, data: { status: "PENDING", errorCode: null, nextAttemptAt: null, dispatchGeneration: { increment: 1 }, executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null } }).then(async updated => updated.count ? [await tx.bookAnalysisBootstrap.findUniqueOrThrow({ where: { id: bootstrap.id }, select: { dispatchGeneration: true } })] : []);
    if (changed.length !== 1) return "NOT_ELIGIBLE" as const;
    await tx.outboxEvent.create({ data: { topic: BOOK_ANALYSIS_BOOTSTRAP_TOPIC, aggregateId: bootstrap.id, payload: { bootstrapId: bootstrap.id, dispatchGeneration: changed[0]!.dispatchGeneration } } });
    return "REARMED" as const;
  });
  return result;
}

/** Bounded discovery delegates every candidate to the exact-target rearm core. */
export async function reconcileWaitingBookAnalysisBootstraps(limit = 25, source: NodeJS.ProcessEnv = process.env) {
  const waiting = await prisma.bookAnalysisBootstrap.findMany({ where: { OR: [{ status: "WAITING_FOR_PROVIDER" }, { status: "PENDING", nextAttemptAt: { lte: new Date() } }, { status: "PENDING", errorCode: capacityError, analysisRunId: null, executionLeaseUntil: null }, { status: "RUNNING", executionLeaseUntil: { lt: new Date() } }] }, orderBy: { updatedAt: "asc" }, take: limit, select: { id: true } });
  for (const row of waiting) await rearmBookAnalysisBootstrapById(row.id, source);
  return waiting.length;
}
