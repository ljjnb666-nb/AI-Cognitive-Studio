import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { prisma } from "@ai-cognitive/db";
import { materializeChunkSet, requestBookAnalysisForUser, resolveBookProductExecution } from "@ai-cognitive/book-intelligence";
import { BOOK_ANALYSIS_BOOTSTRAP_TOPIC, dispatchPendingOutbox } from "@ai-cognitive/ingestion";
import { resolveCredentialKeyring } from "@ai-cognitive/provider-gateway";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export const BOOK_ANALYSIS_BOOTSTRAP_QUEUE = "book.analysis.bootstrap";
export const BOOK_ANALYSIS_BOOTSTRAP_JOB = "book.analysis.bootstrap";
export type BookAnalysisBootstrapPayload = { bootstrapId: string };
export type BookAnalysisBootstrapQueueOptions = { prefix?: string; concurrency?: number };
const readyErrors = new Set(["AI_PROVIDER_CONFIGURATION_REQUIRED", "BOOK_EMBEDDING_PROVIDER_NOT_CONFIGURED"]);
const errorCode = (error: unknown): string => error instanceof Error ? error.message.split(":")[0] ?? "BOOK_ANALYSIS_BOOTSTRAP_FAILED" : "BOOK_ANALYSIS_BOOTSTRAP_FAILED";
const assertGatewayRuntimeReady = () => { if (!resolveCredentialKeyring(process.env)) throw new Error("AI_PROVIDER_CONFIGURATION_REQUIRED"); };

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
async function waitForProvider(id: string, token: string, code: string) {
  await owned(id, token, { status: "WAITING_FOR_PROVIDER", errorCode: code, executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null });
}

/** PostgreSQL is the authority: BullMQ carries only this durable intent ID. */
export async function processBookAnalysisBootstrap(bootstrapId: string) {
  const initial = await prisma.bookAnalysisBootstrap.findUnique({ where: { id: bootstrapId } });
  if (!initial || initial.status === "SUCCEEDED" || initial.status === "FAILED_TERMINAL") return;
  const token = randomUUID();
  if (!await claimBootstrap(bootstrapId, token)) return;
  try {
    const bootstrap = await prisma.bookAnalysisBootstrap.findUniqueOrThrow({ where: { id: bootstrapId }, include: { ingestionRun: { include: { job: true } }, sourceDocument: true, extraction: true, requestedBy: true } });
    if (bootstrap.ingestionRun.status !== "SUCCEEDED" || bootstrap.ingestionRun.workspaceId !== bootstrap.workspaceId || bootstrap.ingestionRun.sourceDocumentId !== bootstrap.sourceDocumentId || bootstrap.extraction.ingestionRunId !== bootstrap.ingestionRunId || bootstrap.extraction.sourceDocumentId !== bootstrap.sourceDocumentId || bootstrap.requestedBy.workspaceId !== bootstrap.workspaceId || bootstrap.requestedBy.userId !== bootstrap.requestedByUserId) throw new Error("BOOK_ANALYSIS_BOOTSTRAP_LINEAGE_INVALID");
    const current = await prisma.currentDocumentExtraction.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: bootstrap.sourceDocumentId, workspaceId: bootstrap.workspaceId } } });
    if (!current || current.extractionId !== bootstrap.extractionId) throw new Error("BOOK_ANALYSIS_BOOTSTRAP_CURRENT_EXTRACTION_MISMATCH");
    assertGatewayRuntimeReady();
    const chunkSet = await materializeChunkSet({ workspaceId: bootstrap.workspaceId, sourceDocumentId: bootstrap.sourceDocumentId, correlationId: bootstrap.id });
    const execution = await resolveBookProductExecution(bootstrap.workspaceId);
    const requested = await requestBookAnalysisForUser({ workspaceId: bootstrap.workspaceId, userId: bootstrap.requestedByUserId }, { sourceDocumentId: bootstrap.sourceDocumentId, chunkSetId: chunkSet.id, pipelineVersion: "phase18.2", promptVersion: "phase18.2", provider: execution.provider, model: execution.model, modelVersion: execution.modelVersion, routePlan: execution.routePlan, correlationId: bootstrap.id });
    await owned(bootstrap.id, token, { status: "SUCCEEDED", analysisRunId: requested.run.id, errorCode: null, completedAt: new Date(), executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null });
  } catch (error) {
    const code = errorCode(error);
    if (readyErrors.has(code)) { await waitForProvider(bootstrapId, token, code); return; }
    if (code === "BOOK_ANALYSIS_BOOTSTRAP_OWNERSHIP_LOST") throw error;
    await owned(bootstrapId, token, { status: "FAILED_TERMINAL", errorCode: code, completedAt: new Date(), executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null });
    throw error;
  }
}

export function createBookAnalysisBootstrapWorker(environment: Environment, options: BookAnalysisBootstrapQueueOptions = {}) {
  return new Worker<BookAnalysisBootstrapPayload>(BOOK_ANALYSIS_BOOTSTRAP_QUEUE, job => processBookAnalysisBootstrap(job.data.bootstrapId), { connection: createRedisConnection(environment.REDIS_URL), concurrency: options.concurrency ?? environment.WORKER_BOOK_ANALYSIS_CONCURRENCY ?? 1, ...(options.prefix ? { prefix: options.prefix } : {}) });
}
export function createBookAnalysisBootstrapQueue(environment: Environment, options: BookAnalysisBootstrapQueueOptions = {}) { return new Queue<BookAnalysisBootstrapPayload>(BOOK_ANALYSIS_BOOTSTRAP_QUEUE, { connection: createRedisConnection(environment.REDIS_URL), ...(options.prefix ? { prefix: options.prefix } : {}) }); }
export function dispatchBookAnalysisBootstrapWithQueue(queue: Queue<BookAnalysisBootstrapPayload>, options: { batchSize?: number; leaseMs?: number; maxAttempts?: number; dispatchConcurrency?: number; topic?: string } = {}) {
  const { topic = BOOK_ANALYSIS_BOOTSTRAP_TOPIC, ...rest } = options;
  return dispatchPendingOutbox<BookAnalysisBootstrapPayload>({ topic, queue, jobName: BOOK_ANALYSIS_BOOTSTRAP_JOB, parse: payload => payload as BookAnalysisBootstrapPayload, jobId: payload => payload.bootstrapId, ...rest });
}
/** A bounded, no-provider-call rearm pass. Readiness is checked by the normal processor. */
export async function reconcileWaitingBookAnalysisBootstraps(limit = 25) {
  const waiting = await prisma.bookAnalysisBootstrap.findMany({ where: { status: "WAITING_FOR_PROVIDER" }, orderBy: { updatedAt: "asc" }, take: limit, select: { id: true } });
  for (const row of waiting) {
    try {
      const bootstrap = await prisma.bookAnalysisBootstrap.findUniqueOrThrow({ where: { id: row.id }, select: { workspaceId: true } });
      assertGatewayRuntimeReady();
      await resolveBookProductExecution(bootstrap.workspaceId);
      await prisma.$transaction(async tx => {
        const changed = await tx.bookAnalysisBootstrap.updateMany({ where: { id: row.id, status: "WAITING_FOR_PROVIDER" }, data: { status: "PENDING", errorCode: null } });
        if (changed.count === 1) await tx.outboxEvent.create({ data: { topic: BOOK_ANALYSIS_BOOTSTRAP_TOPIC, aggregateId: row.id, payload: { bootstrapId: row.id } } });
      });
    } catch (error) { if (!readyErrors.has(errorCode(error))) throw error; }
  }
  return waiting.length;
}
