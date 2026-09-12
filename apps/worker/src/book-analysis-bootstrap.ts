import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { prisma } from "@ai-cognitive/db";
import { materializeChunkSet, requestBookAnalysisForUser, resolveBookAnalysisVersions, resolveBookProductExecution } from "@ai-cognitive/book-intelligence";
import { BOOK_ANALYSIS_BOOTSTRAP_TOPIC, dispatchPendingOutbox } from "@ai-cognitive/ingestion";
import { resolveCredentialKeyring } from "@ai-cognitive/provider-gateway";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export const BOOK_ANALYSIS_BOOTSTRAP_QUEUE = "book.analysis.bootstrap";
export const BOOK_ANALYSIS_BOOTSTRAP_JOB = "book.analysis.bootstrap";
export type BookAnalysisBootstrapPayload = { bootstrapId: string; dispatchGeneration: number };
export type BookAnalysisBootstrapQueueOptions = { prefix?: string; concurrency?: number; source?: NodeJS.ProcessEnv };
export type BookAnalysisBootstrapFaultPoint = "afterClaim" | "afterChunkSetMaterialization" | "afterBookAnalysisRequest";
export type ProcessBookAnalysisBootstrapOptions = { source?: NodeJS.ProcessEnv; faultInjector?: (point: BookAnalysisBootstrapFaultPoint, input: { bootstrapId: string; analysisRunId?: string }) => Promise<void> | void };
const readyErrors = new Set(["AI_PROVIDER_CONFIGURATION_REQUIRED", "BOOK_EMBEDDING_PROVIDER_NOT_CONFIGURED"]);
const errorCode = (error: unknown): string => error instanceof Error ? error.message.split(":")[0] ?? "BOOK_ANALYSIS_BOOTSTRAP_FAILED" : "BOOK_ANALYSIS_BOOTSTRAP_FAILED";
const assertGatewayRuntimeReady = (source: NodeJS.ProcessEnv = process.env) => { if (!resolveCredentialKeyring(source)) throw new Error("AI_PROVIDER_CONFIGURATION_REQUIRED"); };
const transient = (code: string) => code === "CHUNK_SET_MATERIALIZATION_IN_PROGRESS" || code === "BOOK_ANALYSIS_BOOTSTRAP_OWNERSHIP_LOST" || /(?:CONCURRENCY|TEMPORARY|TIMEOUT|CONNECTION|DATABASE|DB|WORKSPACE_EXPENSIVE)_/.test(code);

async function claimBootstrap(id: string, token: string): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE "BookAnalysisBootstrap"
    SET "status" = 'RUNNING'::"BookAnalysisBootstrapStatus", "startedAt" = COALESCE("startedAt", NOW()), "completedAt" = NULL,
        "errorCode" = NULL, "executionClaimToken" = ${token}, "executionClaimedAt" = NOW(), "executionLeaseUntil" = NOW() + INTERVAL '2 minutes'
    WHERE "id" = ${id} AND "status" IN ('PENDING'::"BookAnalysisBootstrapStatus", 'RUNNING'::"BookAnalysisBootstrapStatus")
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

/** PostgreSQL is the authority: BullMQ carries only this durable intent ID. */
export async function processBookAnalysisBootstrap(bootstrapId: string, options: ProcessBookAnalysisBootstrapOptions = {}) {
  const initial = await prisma.bookAnalysisBootstrap.findUnique({ where: { id: bootstrapId } });
  if (!initial || initial.status === "SUCCEEDED" || initial.status === "FAILED_TERMINAL") return;
  const token = randomUUID();
  if (!await claimBootstrap(bootstrapId, token)) return;
  try {
    await options.faultInjector?.("afterClaim", { bootstrapId });
    const bootstrap = await prisma.bookAnalysisBootstrap.findUniqueOrThrow({ where: { id: bootstrapId }, include: { ingestionRun: { include: { job: true } }, sourceDocument: true, extraction: true, requestedBy: true } });
    if (bootstrap.ingestionRun.status !== "SUCCEEDED" || bootstrap.ingestionRun.workspaceId !== bootstrap.workspaceId || bootstrap.ingestionRun.sourceDocumentId !== bootstrap.sourceDocumentId || bootstrap.extraction.ingestionRunId !== bootstrap.ingestionRunId || bootstrap.extraction.sourceDocumentId !== bootstrap.sourceDocumentId || bootstrap.requestedBy.workspaceId !== bootstrap.workspaceId || bootstrap.requestedBy.userId !== bootstrap.requestedByUserId) throw new Error("BOOK_ANALYSIS_BOOTSTRAP_LINEAGE_INVALID");
    const current = await prisma.currentDocumentExtraction.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: bootstrap.sourceDocumentId, workspaceId: bootstrap.workspaceId } } });
    if (!current || current.extractionId !== bootstrap.extractionId) throw new Error("BOOK_ANALYSIS_BOOTSTRAP_CURRENT_EXTRACTION_MISMATCH");
    assertGatewayRuntimeReady(options.source);
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
    if (transient(code)) { await owned(bootstrapId, token, { status: "PENDING", errorCode: code, retryCount: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 5_000), executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null }); return; }
    await owned(bootstrapId, token, { status: "FAILED_TERMINAL", errorCode: code, completedAt: new Date(), executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null });
    throw error;
  }
}

export function createBookAnalysisBootstrapWorker(environment: Environment, options: BookAnalysisBootstrapQueueOptions = {}) {
  return new Worker<BookAnalysisBootstrapPayload>(BOOK_ANALYSIS_BOOTSTRAP_QUEUE, job => processBookAnalysisBootstrap(job.data.bootstrapId, { source: options.source }), { connection: createRedisConnection(environment.REDIS_URL), concurrency: options.concurrency ?? environment.WORKER_BOOK_ANALYSIS_CONCURRENCY ?? 1, ...(options.prefix ? { prefix: options.prefix } : {}) });
}
export function createBookAnalysisBootstrapQueue(environment: Environment, options: BookAnalysisBootstrapQueueOptions = {}) { return new Queue<BookAnalysisBootstrapPayload>(BOOK_ANALYSIS_BOOTSTRAP_QUEUE, { connection: createRedisConnection(environment.REDIS_URL), ...(options.prefix ? { prefix: options.prefix } : {}) }); }
export function dispatchBookAnalysisBootstrapWithQueue(queue: Queue<BookAnalysisBootstrapPayload>, options: { batchSize?: number; leaseMs?: number; maxAttempts?: number; dispatchConcurrency?: number; topic?: string } = {}) {
  const { topic = BOOK_ANALYSIS_BOOTSTRAP_TOPIC, ...rest } = options;
  return dispatchPendingOutbox<BookAnalysisBootstrapPayload>({ topic, queue, jobName: BOOK_ANALYSIS_BOOTSTRAP_JOB, parse: payload => payload as BookAnalysisBootstrapPayload, jobId: payload => `${payload.bootstrapId}:${payload.dispatchGeneration}`, ...rest });
}
/** A bounded, no-provider-call rearm pass. Readiness is checked by the normal processor. */
export async function reconcileWaitingBookAnalysisBootstraps(limit = 25, source: NodeJS.ProcessEnv = process.env) {
  const waiting = await prisma.bookAnalysisBootstrap.findMany({ where: { OR: [{ status: "WAITING_FOR_PROVIDER" }, { status: "PENDING", nextAttemptAt: { lte: new Date() } }, { status: "RUNNING", executionLeaseUntil: { lt: new Date() } }] }, orderBy: { updatedAt: "asc" }, take: limit, select: { id: true, status: true } });
  for (const row of waiting) {
    try {
      const bootstrap = await prisma.bookAnalysisBootstrap.findUniqueOrThrow({ where: { id: row.id }, select: { workspaceId: true } });
      assertGatewayRuntimeReady(source);
      await resolveBookProductExecution(bootstrap.workspaceId);
      await prisma.$transaction(async tx => {
        const changed = await tx.bookAnalysisBootstrap.updateMany({ where: { id: row.id, status: row.status }, data: { status: "PENDING", errorCode: null, nextAttemptAt: null, dispatchGeneration: { increment: 1 }, executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null } });
        if (changed.count === 1) { const current = await tx.bookAnalysisBootstrap.findUniqueOrThrow({ where: { id: row.id }, select: { dispatchGeneration: true } }); await tx.outboxEvent.create({ data: { topic: BOOK_ANALYSIS_BOOTSTRAP_TOPIC, aggregateId: row.id, payload: { bootstrapId: row.id, dispatchGeneration: current.dispatchGeneration } } }); }
      });
    } catch (error) { if (!readyErrors.has(errorCode(error))) throw error; }
  }
  return waiting.length;
}
