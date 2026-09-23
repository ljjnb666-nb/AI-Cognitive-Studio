import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/src/index.js";
import { type Environment } from "@ai-cognitive/shared/server";
import { createBookAnalysisQueue, createBookAnalysisWorker } from "../../../apps/worker/src/book-analysis.js";
import {
  BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST,
  CHUNK_SET_OWNERSHIP_LOST,
  DeterministicFakeEmbeddingProvider,
  claimChunkSetMaterialization,
  buildBookContext,
  dispatchPendingBookAnalysis,
  estimateAnalysisTokens,
  materializeChunkSet,
  processBookAnalysisRun,
  rearmBookAnalysisRunById,
  requestBookAnalysis,
  retrieveBookKnowledge,
  withOwnedChunkSetTransaction,
  type AnalysisProvider,
  type AnalysisRequest,
  type AnalysisResponse,
  type EmbeddingProvider,
  type ProcessBookAnalysisDependencies,
} from "../src/index.js";
import { createBookAnalysisEmbeddingGatewayFixture } from "./helpers/book-analysis-embedding-gateway.js";

const workspaces: string[] = [];
const users: string[] = [];
async function fixture(blockTexts = ["# Chapter", ...Array.from({ length: 6 }, (_, index) => `Paragraph ${index} ${"evidence ".repeat(7)}`)], gatewayOptions: { pauseRemote?: boolean } = {}) {
  const suffix = crypto.randomUUID();
  const user = await prisma.user.create({ data: { email: `${suffix}@durability.test` } });
  users.push(user.id);
  const workspace = await prisma.workspace.create({ data: { name: `durability-${suffix}` } });
  workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "book.md" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: `test/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: blob.storageKey } });
  const job = await prisma.job.create({ data: { workspaceId: workspace.id, type: "source.ingest", payload: {}, idempotencyKey: `ingest:${suffix}` } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: job.id, parserVersion: "test", normalizationVersion: "test" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } });
  const blocks = [];
  for (const [ordinal, text] of blockTexts.entries()) blocks.push(await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal, kind: text.startsWith("#") ? "HEADING" : "PARAGRAPH", text, contentHash: `hash-${suffix}-${ordinal}` } }));
  await prisma.currentDocumentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id } });
  const chunkSet = await materializeChunkSet({ workspaceId: workspace.id, sourceDocumentId: document.id, configuration: { targetSize: 70, hardMax: 80 } });
  const requested = await requestBookAnalysis({ workspaceId: workspace.id, sourceDocumentId: document.id, pipelineVersion: suffix, promptVersion: "p1", provider: "test", model: "test", modelVersion: "1" });
  const gateway = await createBookAnalysisEmbeddingGatewayFixture({ workspaceId: workspace.id, userId: user.id, ...gatewayOptions });
  return { user, workspace, document, extraction, blocks, chunkSet, run: requested.run, job: requested.job, gateway };
}

class DurableProvider implements AnalysisProvider {
  readonly requests: AnalysisRequest[] = [];
  constructor(private readonly blocks: Array<{ id: string; text: string }> = [], private readonly inflated = false) {}
  async generateStructured(request: AnalysisRequest): Promise<AnalysisResponse> {
    this.requests.push(structuredClone(request));
    const markers = ["BEGIN_MARKER", "MIDDLE_MARKER", "END_MARKER"].filter((marker) => request.content.includes(marker));
    if (request.stage !== "CHUNK") return { summary: `${markers.join(" ")} reduced ${request.stage}`.trim(), memory: request.stage === "BOOK" ? [{ type: "SUMMARY", content: `book ${markers.join(" ")}` }, { type: "CONCEPT", content: "durable concept" }] : undefined, relations: request.stage === "BOOK" ? [{ fromOrdinal: 0, toOrdinal: 1, type: "DEVELOPS" }] : undefined };
    const block = this.blocks.find((candidate) => request.sourceBlockIds.includes(candidate.id) && candidate.text.includes(request.content));
    const offset = block?.text.indexOf(request.content) ?? -1;
    if (this.inflated) return { summary: `${request.content} ${"derived ".repeat(500)}` };
    const memory: AnalysisResponse["memory"] = [{ type: "CLAIM", content: `claim:${request.content}` }, { type: "EXAMPLE", content: `example:${request.content}` }];
    if (block && offset >= 0) memory.push({ type: "QUOTE", content: request.content, evidence: [{ sourceBlockId: block.id, startOffset: offset, endOffset: offset + request.content.length, quoteText: request.content }] });
    return { summary: `chunk:${request.content}`, memory, relations: [{ fromOrdinal: 0, toOrdinal: 1, type: "SUPPORTS" }] };
  }
}

class RecordingEmbeddingProvider extends DeterministicFakeEmbeddingProvider implements EmbeddingProvider {
  override readonly identity = { provider: "deterministic-test", model: "deterministic-vector-v1", embeddingVersion: "gateway", dimensions: 4 };
  readonly calls: string[][] = [];
  override async embed(input: { texts: string[] }): Promise<number[][]> { this.calls.push([...input.texts]); return super.embed(input); }
}

class BarrierProvider implements AnalysisProvider {
  readonly entered: Promise<void>;
  private enter!: () => void;
  private release!: () => void;
  private readonly released: Promise<void>;
  constructor(private readonly failure?: Error) {
    this.entered = new Promise((resolve) => { this.enter = resolve; });
    this.released = new Promise((resolve) => { this.release = resolve; });
  }
  unblock() { this.release(); }
  async generateStructured(): Promise<AnalysisResponse> { this.enter(); await this.released; if (this.failure) throw this.failure; return { summary: "STALE_A_RESPONSE" }; }
}

async function expireLease(runId: string) { await prisma.$executeRaw`UPDATE "BookAnalysisRun" SET "executionLeaseUntil" = NOW() - INTERVAL '1 second' WHERE "id" = ${runId}`; }

function deps(data: Awaited<ReturnType<typeof fixture>>, analysisProvider: AnalysisProvider, extras: Partial<ProcessBookAnalysisDependencies> = {}): ProcessBookAnalysisDependencies {
  return { analysisProvider, embeddingProvider: new DeterministicFakeEmbeddingProvider(), embeddingGateway: data.gateway.embeddingGateway, ...extras };
}

class DeterministicBarrier {
  readonly entered: Promise<void>;
  private markEntered!: () => void;
  private release!: () => void;
  private readonly released: Promise<void>;
  constructor() {
    this.entered = new Promise((resolve) => { this.markEntered = resolve; });
    this.released = new Promise((resolve) => { this.release = resolve; });
  }
  async wait() { this.markEntered(); await this.released; }
  unblock() { this.release(); }
}

async function createReplacementExtraction(data: Awaited<ReturnType<typeof fixture>>) {
  const suffix = crypto.randomUUID();
  const ingestionJob = await prisma.job.create({ data: { workspaceId: data.workspace.id, type: "source.ingest", payload: {}, idempotencyKey: `replacement-${suffix}` } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId: data.workspace.id, sourceDocumentId: data.document.id, jobId: ingestionJob.id, parserVersion: "test-b", normalizationVersion: "test-b" } });
  return prisma.documentExtraction.create({ data: { workspaceId: data.workspace.id, sourceDocumentId: data.document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test-b", normalizationVersion: "test-b" } });
}

async function waitForPostgresRowLock(backendPid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [state] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT cardinality(pg_blocking_pids(${backendPid}::int)) > 0 AS blocked`;
    if (state?.blocked) return;
  }
  throw new Error("EXPECTED_CURRENT_EXTRACTION_ROW_LOCK");
}

afterEach(async () => {
  for (const workspaceId of workspaces.splice(0)) {
    await prisma.providerEmbeddingResult.deleteMany({ where: { workspaceId } });
    await prisma.providerUsageEvent.deleteMany({ where: { workspaceId } });
    await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId } });
    await prisma.providerInvocation.deleteMany({ where: { workspaceId } });
    await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId } });
    await prisma.providerRouteBinding.deleteMany({ where: { workspaceId } });
    await prisma.providerCredentialVersion.deleteMany({ where: { workspaceId } });
    await prisma.providerConnection.deleteMany({ where: { workspaceId } });
    await prisma.currentBookIntelligence.deleteMany({ where: { workspaceId } });
    await prisma.bookAnalysisRun.deleteMany({ where: { workspaceId } });
    await prisma.chunkSet.deleteMany({ where: { workspaceId } });
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId } });
    await prisma.job.deleteMany({ where: { workspaceId } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId } });
    await prisma.source.deleteMany({ where: { workspaceId } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(() => prisma.$disconnect());

describe("durable Phase 2 orchestration", () => {
  it("accepts the largest safe transport generation but fences it against a persisted Book generation before provider resolution", async () => {
    const data = await fixture();
    const prefix = `a2-book-safe-integer-${crypto.randomUUID()}`;
    let provider = 0, embedding = 0;
    const environment = { REDIS_URL: process.env.REDIS_URL!, WORKER_BOOK_ANALYSIS_CONCURRENCY: 1 } as unknown as Environment;
    const worker = createBookAnalysisWorker(environment, { analysisProviderForRun: async () => { provider++; throw new Error("UNEXPECTED_PROVIDER"); }, embeddingGatewayForRun: () => { embedding++; throw new Error("UNEXPECTED_EMBEDDING"); } } as never, { prefix });
    const queue = createBookAnalysisQueue(environment, { prefix });
    try {
      await worker.waitUntilReady();
      const before = await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: data.job.id } }), prisma.providerInvocation.count()]);
      const delivered = await queue.add("a2-safe-integer", { analysisRunId: data.run.id, dispatchGeneration: Number.MAX_SAFE_INTEGER }, { jobId: `${data.run.id}-safe` });
      await expect.poll(async () => delivered.getState(), { timeout: 10_000 }).toBe("completed");
      expect([provider, embedding]).toEqual([0, 0]);
      expect(await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: data.job.id } }), prisma.providerInvocation.count()])).toEqual(before);
    } finally { await Promise.all([worker.close(), queue.obliterate({ force: true }), queue.close()]); }
  });
  it("dispatches distinct real BullMQ Book gen0 and gen1 jobs, then fences stale gen0 redelivery", async () => {
    const data = await fixture();
    const prefix = `a2-book-gen0-gen1-${crypto.randomUUID()}`;
    let provider = 0;
    const environment = { REDIS_URL: process.env.REDIS_URL!, WORKER_BOOK_ANALYSIS_CONCURRENCY: 1 } as unknown as Environment;
    const worker = createBookAnalysisWorker(environment, { analysisProviderForRun: async () => { provider++; throw new Error("A2_EXPECTED_PROVIDER_FAILURE"); }, embeddingGatewayForRun: () => { throw new Error("UNEXPECTED_EMBEDDING"); } } as never, { prefix });
    const queue = createBookAnalysisQueue(environment, { prefix });
    try {
      await worker.waitUntilReady();
      await dispatchPendingBookAnalysis(queue, { aggregateIds: [data.run.id] });
      const gen0 = await queue.getJob(data.job.id);
      expect(gen0).toBeTruthy();
      await expect.poll(async () => gen0!.getState(), { timeout: 10_000 }).toBe("failed");
      await expect(rearmBookAnalysisRunById(data.run.id, 0)).resolves.toBe("REARMED");
      await dispatchPendingBookAnalysis(queue, { aggregateIds: [data.run.id] });
      const gen1 = await queue.getJob(`${data.job.id}-g1`);
      expect(gen1).toBeTruthy();
      await expect.poll(async () => gen1!.getState(), { timeout: 10_000 }).toBe("failed");
      expect([gen0!.id, gen1!.id]).toEqual([data.job.id, `${data.job.id}-g1`]);
      const beforeStale = provider;
      const stale = await queue.add("a2-stale-redelivery", { analysisRunId: data.run.id, dispatchGeneration: 0 }, { jobId: `${data.job.id}-g0-redelivery` });
      await expect.poll(async () => stale.getState(), { timeout: 10_000 }).toBe("completed");
      expect(provider).toBe(beforeStale);
    } finally { await Promise.all([worker.close(), queue.obliterate({ force: true }), queue.close()]); }
  });
  it("keeps active capacity, reacquires terminal capacity, and rolls back when full", async () => { const prior = process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT; process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT = "2"; const expensive = { in: ["book.analysis", "podcast.generation", "short-video.generation"] }; try { const active = await fixture(); await prisma.job.update({ where: { id: active.job.id }, data: { status: "QUEUED" } }); await prisma.job.create({ data: { workspaceId: active.workspace.id, type: "podcast.generation", payload: {}, status: "QUEUED" } }); await expect(rearmBookAnalysisRunById(active.run.id, 0)).resolves.toBe("REARMED"); expect(await prisma.job.count({ where: { workspaceId: active.workspace.id, type: expensive, status: { in: ["QUEUED", "RUNNING"] } } })).toBe(2); const terminal = await fixture(); await prisma.$transaction([prisma.bookAnalysisRun.update({ where: { id: terminal.run.id }, data: { status: "FAILED" } }), prisma.job.update({ where: { id: terminal.job.id }, data: { status: "FAILED" } })]); await prisma.job.create({ data: { workspaceId: terminal.workspace.id, type: "podcast.generation", payload: {}, status: "QUEUED" } }); await expect(rearmBookAnalysisRunById(terminal.run.id, 0)).resolves.toBe("REARMED"); expect(await prisma.job.count({ where: { workspaceId: terminal.workspace.id, type: expensive, status: { in: ["QUEUED", "RUNNING"] } } })).toBe(2); const full = await fixture(); await prisma.$transaction([prisma.bookAnalysisRun.update({ where: { id: full.run.id }, data: { status: "FAILED" } }), prisma.job.update({ where: { id: full.job.id }, data: { status: "FAILED" } })]); await prisma.job.createMany({ data: ["a", "b"].map(id => ({ workspaceId: full.workspace.id, type: "podcast.generation", payload: {}, status: "QUEUED", idempotencyKey: `a2-book-full-${id}-${crypto.randomUUID()}` })) }); const before = await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: full.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: full.job.id } }), prisma.outboxEvent.count({ where: { aggregateId: full.run.id } })]); await expect(rearmBookAnalysisRunById(full.run.id, 0)).resolves.toBe("CAPACITY_BLOCKED"); expect(await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: full.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: full.job.id } }), prisma.outboxEvent.count({ where: { aggregateId: full.run.id } })])).toEqual(before); } finally { if (prior === undefined) delete process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT; else process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT = prior; } });
  it("does not rearm a Book run with a live execution lease", async () => { const data = await fixture(); await prisma.bookAnalysisRun.update({ where: { id: data.run.id }, data: { status: "RUNNING", executionLeaseUntil: new Date(Date.now() + 60_000) } }); const before = await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: data.job.id } }), prisma.outboxEvent.count({ where: { aggregateId: data.run.id } })]); await expect(rearmBookAnalysisRunById(data.run.id, 0)).resolves.toBe("NOT_ELIGIBLE"); expect(await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: data.job.id } }), prisma.outboxEvent.count({ where: { aggregateId: data.run.id } })])).toEqual(before); });
  it("allows exactly one concurrent max-minus-one rearm without persisted overflow", async () => { const data = await fixture(); await prisma.bookAnalysisRun.update({ where: { id: data.run.id }, data: { status: "FAILED", dispatchGeneration: 2_147_483_646 } }); await prisma.job.update({ where: { id: data.job.id }, data: { status: "FAILED" } }); const results = await Promise.all([rearmBookAnalysisRunById(data.run.id, 2_147_483_646, "a2.overflow.concurrent.book"), rearmBookAnalysisRunById(data.run.id, 2_147_483_646, "a2.overflow.concurrent.book")]); expect(results.filter(result => result === "REARMED")).toHaveLength(1); expect(results.every(result => result === "REARMED" || result === "RACE_LOST" || result === "NOT_ELIGIBLE")).toBe(true); expect((await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } })).dispatchGeneration).toBe(2_147_483_647); expect(await prisma.outboxEvent.count({ where: { aggregateId: data.run.id, topic: "a2.overflow.concurrent.book" } })).toBe(1); });
  it("fences a stale outbox finalizer after same-run rearm", async () => { const data = await fixture(); let reached!: () => void, release!: () => void; const reachedP = new Promise<void>(resolve => reached = resolve), releaseP = new Promise<void>(resolve => release = resolve); const stale = dispatchPendingBookAnalysis({ add: async () => ({}) }, { aggregateIds: [data.run.id], beforeFinalize: async () => { reached(); await releaseP; } }); await reachedP; await expect(rearmBookAnalysisRunById(data.run.id, 0)).resolves.toBe("REARMED"); release(); await stale; expect((await prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })).queueJobId).toBeNull(); const ids: string[] = []; await dispatchPendingBookAnalysis({ add: async (_name, _payload, options) => { ids.push(options.jobId); return {}; } }, { aggregateIds: [data.run.id] }); expect([ids, (await prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })).queueJobId]).toEqual([[`${data.job.id}-g1`], `${data.job.id}-g1`]); });
  it("advances max-minus-one once and refuses the persisted dispatch-generation maximum without mutation", async () => { const data = await fixture(); await prisma.bookAnalysisRun.update({ where: { id: data.run.id }, data: { status: "FAILED", dispatchGeneration: 2_147_483_646 } }); await prisma.job.update({ where: { id: data.job.id }, data: { status: "FAILED" } }); const before = await prisma.outboxEvent.count({ where: { aggregateId: data.run.id } }); await expect(rearmBookAnalysisRunById(data.run.id, 2_147_483_646, "a2.overflow.book")).resolves.toBe("REARMED"); expect((await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } })).dispatchGeneration).toBe(2_147_483_647); expect(await prisma.outboxEvent.count({ where: { aggregateId: data.run.id } })).toBe(before + 1); const snapshot = await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: data.job.id } }), prisma.outboxEvent.count({ where: { aggregateId: data.run.id } })]); await expect(rearmBookAnalysisRunById(data.run.id, 2_147_483_647, "a2.overflow.book")).resolves.toBe("NOT_ELIGIBLE"); expect(await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: data.job.id } }), prisma.outboxEvent.count({ where: { aggregateId: data.run.id } })])).toEqual(snapshot); });
  it("keeps the Book retry/rearm race on one generation, current job, and current transport authority", async () => {
    const data = await fixture();
    await prisma.$transaction([prisma.bookAnalysisRun.update({ where: { id: data.run.id }, data: { status: "FAILED" } }), prisma.job.update({ where: { id: data.job.id }, data: { status: "FAILED" } })]);
    await prisma.outboxEvent.updateMany({ where: { aggregateId: data.run.id }, data: { status: "DISPATCHED", dispatchedAt: new Date() } });
    const input = { workspaceId: data.workspace.id, sourceDocumentId: data.document.id, pipelineVersion: data.run.pipelineVersion, promptVersion: data.run.promptVersion, provider: data.run.provider, model: data.run.model, modelVersion: data.run.modelVersion ?? undefined };
    const [rearm, retry] = await Promise.all([rearmBookAnalysisRunById(data.run.id, 0), requestBookAnalysis(input)]);
    expect(["REARMED", "RACE_LOST", "NOT_ELIGIBLE"]).toContain(rearm);
    const current = await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id }, include: { job: true } });
    const generationOne = (await prisma.outboxEvent.findMany({ where: { aggregateId: data.run.id } })).filter(event => (event.payload as { dispatchGeneration?: unknown }).dispatchGeneration === 1);
    expect([current.dispatchGeneration, current.jobId, retry.job.id, generationOne.length]).toEqual([1, current.job.id, current.jobId, 1]);
    const ids: string[] = [];
    await dispatchPendingBookAnalysis({ add: async (_name, _payload, options) => { ids.push(options.jobId); return {}; } }, { aggregateIds: [data.run.id] });
    expect([ids, (await prisma.job.findUniqueOrThrow({ where: { id: current.jobId } })).queueJobId]).toEqual([[`${current.jobId}-g1`], `${current.jobId}-g1`]);
    const beforeStale = await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: current.jobId } })]);
    const staleProvider = new DurableProvider(data.blocks);
    await processBookAnalysisRun(data.run.id, deps(data, staleProvider), 0);
    expect([await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), await prisma.job.findUniqueOrThrow({ where: { id: current.jobId } })]).toEqual(beforeStale);
    expect(staleProvider.requests).toHaveLength(0);
  });
  it("applies workspace admission atomically to the actual failed-analysis retry path", async () => {
    const data = await fixture();
    await prisma.$transaction([prisma.bookAnalysisRun.update({ where: { id: data.run.id }, data: { status: "FAILED", completedAt: new Date(), errorCode: "TEST_FAILURE" } }), prisma.job.update({ where: { id: data.job.id }, data: { status: "FAILED", completedAt: new Date() } })]);
    const priorEnvironment = process.env.NODE_ENV, priorLimit = process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT;
    process.env.NODE_ENV = "production"; process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT = "2";
    try {
      await prisma.job.createMany({ data: ["one", "two"].map(marker => ({ workspaceId: data.workspace.id, type: "book.analysis", idempotencyKey: `phase18-active-${marker}-${crypto.randomUUID()}`, payload: {} })) });
      const before = await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), prisma.job.count({ where: { workspaceId: data.workspace.id, type: "book.analysis" } }), prisma.outboxEvent.count({ where: { aggregateId: data.run.id } })]);
      await expect(requestBookAnalysis({ workspaceId: data.workspace.id, sourceDocumentId: data.document.id, pipelineVersion: data.run.pipelineVersion, promptVersion: data.run.promptVersion, provider: data.run.provider, model: data.run.model, modelVersion: data.run.modelVersion ?? undefined })).rejects.toThrow("WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED");
      const after = await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), prisma.job.count({ where: { workspaceId: data.workspace.id, type: "book.analysis" } }), prisma.outboxEvent.count({ where: { aggregateId: data.run.id } })]);
      expect([after[0].status, after[0].jobId, after[1], after[2]]).toEqual(["FAILED", before[0].jobId, before[1], before[2]]);
      await prisma.job.updateMany({ where: { workspaceId: data.workspace.id, type: "book.analysis", status: "QUEUED" }, data: { status: "SUCCEEDED", completedAt: new Date() } });
      const retried = await requestBookAnalysis({ workspaceId: data.workspace.id, sourceDocumentId: data.document.id, pipelineVersion: data.run.pipelineVersion, promptVersion: data.run.promptVersion, provider: data.run.provider, model: data.run.model, modelVersion: data.run.modelVersion ?? undefined });
      expect([retried.run.status, retried.job.type, await prisma.outboxEvent.count({ where: { aggregateId: data.run.id } })]).toEqual(["QUEUED", "book.analysis", before[2] + 1]);
    } finally { process.env.NODE_ENV = priorEnvironment; if (priorLimit === undefined) delete process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT; else process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT = priorLimit; }
  });
  it("has one claim winner, permits stale reclaim, rejects stale persistence, and does not increment a claim loser", async () => {
    const data = await fixture();
    const barrier = new BarrierProvider();
    const a = processBookAnalysisRun(data.run.id, deps(data, barrier));
    await barrier.entered;
    const attemptsAfterA = (await prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })).attemptCount;
    await processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks)));
    expect((await prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })).attemptCount).toBe(attemptsAfterA);
    await expireLease(data.run.id);
    await processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks)));
    barrier.unblock();
    await expect(a).rejects.toThrow(BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST);
    expect(await prisma.analysisArtifact.count({ where: { analysisRunId: data.run.id, summary: "STALE_A_RESPONSE" } })).toBe(0);
    expect((await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } })).status).toBe("SUCCEEDED");
  });

  it("does not let a stale provider failure overwrite the reclaiming worker", async () => {
    const data = await fixture();
    const barrier = new BarrierProvider(new Error("STALE_PROVIDER_FAILED"));
    const a = processBookAnalysisRun(data.run.id, deps(data, barrier));
    await barrier.entered;
    await expireLease(data.run.id);
    await processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks)));
    barrier.unblock();
    await expect(a).rejects.toThrow("STALE_PROVIDER_FAILED");
    const [run, job] = await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })]);
    expect([run.status, job.status, run.analysisStage]).toEqual(["SUCCEEDED", "SUCCEEDED", "COMPLETED"]);
  });

  it("resumes chunks without recalling the provider for persisted artifacts", async () => {
    const data = await fixture();
    const provider = new DurableProvider(data.blocks);
    let persisted = 0;
    await expect(processBookAnalysisRun(data.run.id, deps(data, provider, { faultInjector: (point) => { if (point === "afterChunkPersist" && ++persisted === 2) throw new Error("CHUNK_CRASH"); } }))).rejects.toThrow("CHUNK_CRASH");
    expect(await prisma.analysisArtifact.count({ where: { analysisRunId: data.run.id, scope: "CHUNK" } })).toBe(2);
    const callsAfterCrash = provider.requests.filter((request) => request.stage === "CHUNK").length;
    await processBookAnalysisRun(data.run.id, deps(data, provider));
    const expected = await prisma.documentChunk.count({ where: { chunkSetId: data.chunkSet.id } });
    expect(provider.requests.filter((request) => request.stage === "CHUNK")).toHaveLength(expected);
    expect(callsAfterCrash).toBe(2);
    expect(await prisma.analysisArtifact.count({ where: { analysisRunId: data.run.id, scope: "CHUNK" } })).toBe(expected);
  });

  it("reuses persisted recursive reductions after a crash without losing marker paths", async () => {
    const texts = ["# Chapter One", `BEGIN_MARKER ${"a ".repeat(35).trimEnd()}`, "## Section One", `${"b ".repeat(35).trimEnd()}`, `${"c ".repeat(35).trimEnd()}`, "# Chapter Two", "## Section Two", `MIDDLE_MARKER ${"d ".repeat(35).trimEnd()}`, `${"e ".repeat(35).trimEnd()}`, `END_MARKER ${"f ".repeat(35).trimEnd()}`];
    const data = await fixture(texts);
    const provider = new DurableProvider(data.blocks, true);
    let reductions = 0;
    await expect(processBookAnalysisRun(data.run.id, deps(data, provider, { faultInjector: (point) => { if (point === "afterReductionPersist" && ++reductions === 2) throw new Error("REDUCTION_CRASH"); } }))).rejects.toThrow("REDUCTION_CRASH");
    expect(await prisma.analysisReductionResult.count({ where: { analysisRunId: data.run.id } })).toBe(2);
    await processBookAnalysisRun(data.run.id, deps(data, provider));
    const reductionInputs = provider.requests.filter((request) => request.stage !== "CHUNK").map((request) => `${request.stage}:${request.content}`);
    expect(new Set(reductionInputs).size).toBe(reductionInputs.length);
    const book = await prisma.analysisArtifact.findFirstOrThrow({ where: { analysisRunId: data.run.id, scope: "BOOK" } });
    expect(book.summary).toContain("BEGIN_MARKER");
    expect(book.summary).toContain("MIDDLE_MARKER");
    expect(book.summary).toContain("END_MARKER");
    expect(await prisma.analysisReductionResult.count({ where: { analysisRunId: data.run.id, level: { gte: 2 } } })).toBeGreaterThan(0);
  });

  it("resumes a partially persisted memory graph with stable keys, ordinals, evidence, and relations", async () => {
    const data = await fixture();
    const provider = new DurableProvider(data.blocks);
    let memories = 0;
    await expect(processBookAnalysisRun(data.run.id, deps(data, provider, { faultInjector: (point) => { if (point === "afterMemoryPersist" && ++memories === 3) throw new Error("MEMORY_CRASH"); } }))).rejects.toThrow("MEMORY_CRASH");
    const partial = await prisma.bookMemoryItem.findMany({ where: { analysisRunId: data.run.id }, orderBy: { ordinal: "asc" } });
    await processBookAnalysisRun(data.run.id, deps(data, provider));
    const [items, evidence, relations] = await Promise.all([prisma.bookMemoryItem.findMany({ where: { analysisRunId: data.run.id }, orderBy: { ordinal: "asc" } }), prisma.bookMemoryEvidence.findMany({ where: { analysisRunId: data.run.id } }), prisma.bookMemoryRelation.findMany({ where: { analysisRunId: data.run.id } })]);
    expect(items.slice(0, partial.length).map((item) => [item.memoryKey, item.ordinal])).toEqual(partial.map((item) => [item.memoryKey, item.ordinal]));
    expect(new Set(items.map((item) => item.memoryKey)).size).toBe(items.length);
    expect(new Set(evidence.map((item) => `${item.memoryItemId}:${item.sourceBlockId}:${item.startOffset}:${item.endOffset}:${item.quoteHash ?? ""}`)).size).toBe(evidence.length);
    expect(new Set(relations.map((item) => `${item.fromMemoryItemId}:${item.toMemoryItemId}:${item.type}`)).size).toBe(relations.length);
    expect(evidence.length).toBeGreaterThan(0);
    expect(relations.length).toBeGreaterThan(0);
  });

  it("reuses a durable gateway receipt after a crash before composite materialization", async () => {
    const data = await fixture();
    await expect(processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks), { faultInjector: (point) => { if (point === "afterEmbeddingGatewayPersist") throw new Error("EMBEDDING_RECEIPT_CRASH"); } }))).rejects.toThrow("EMBEDDING_RECEIPT_CRASH");
    expect(data.gateway.remoteCallCount()).toBe(1);
    const receipt = await prisma.providerEmbeddingResult.findFirstOrThrow({ where: { workspaceId: data.workspace.id } });
    expect(await prisma.providerInvocation.count({ where: { workspaceId: data.workspace.id } })).toBe(1);
    expect(await prisma.providerInvocationAttempt.count({ where: { workspaceId: data.workspace.id, status: "SUCCEEDED" } })).toBe(1);
    expect(await prisma.providerUsageEvent.count({ where: { workspaceId: data.workspace.id } })).toBe(1);
    expect([receipt.consumedAt, receipt.purgedAt]).toEqual([null, null]);
    expect([receipt.ciphertext, receipt.iv, receipt.authTag, receipt.keyVersion].every(Boolean)).toBe(true);
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(0);
    expect(await prisma.bookMemoryEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(0);
    await processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks)));
    expect(data.gateway.remoteCallCount()).toBe(1);
    expect(await prisma.providerInvocation.count({ where: { workspaceId: data.workspace.id } })).toBe(1);
    expect(await prisma.providerInvocationAttempt.count({ where: { workspaceId: data.workspace.id } })).toBe(1);
    expect(await prisma.providerUsageEvent.count({ where: { workspaceId: data.workspace.id } })).toBe(1);
    const consumed = await prisma.providerEmbeddingResult.findFirstOrThrow({ where: { workspaceId: data.workspace.id } });
    expect([consumed.consumedAt !== null, consumed.purgedAt !== null]).toEqual([true, true]);
    expect([consumed.ciphertext, consumed.iv, consumed.authTag, consumed.keyVersion]).toEqual([null, null, null, null]);
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(await prisma.documentChunk.count({ where: { chunkSetId: data.chunkSet.id } }));
    expect(await prisma.bookMemoryEmbedding.count({ where: { analysisRunId: data.run.id } })).toBe(await prisma.bookMemoryItem.count({ where: { analysisRunId: data.run.id } }));
    expect((await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } })).status).toBe("SUCCEEDED");
  });

  it("rejects vectors returned by an embedding call whose owner became stale", async () => {
    const data = await fixture(undefined, { pauseRemote: true });
    const a = processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks)));
    await data.gateway.remoteEntered;
    await expireLease(data.run.id);
    const b = processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks)));
    data.gateway.releaseRemote();
    await expect(a).rejects.toThrow(BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST);
    await b;
    expect(data.gateway.remoteCallCount()).toBe(1);
    expect(await prisma.providerInvocation.count({ where: { workspaceId: data.workspace.id } })).toBe(1);
    expect(await prisma.providerUsageEvent.count({ where: { workspaceId: data.workspace.id } })).toBe(1);
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(await prisma.documentChunk.count({ where: { chunkSetId: data.chunkSet.id } }));
    expect(await prisma.bookMemoryEmbedding.count({ where: { analysisRunId: data.run.id } })).toBe(await prisma.bookMemoryItem.count({ where: { analysisRunId: data.run.id } }));
  });

  it.each(["SECTION_ANALYSIS", "CHAPTER_ANALYSIS", "BOOK_SYNTHESIS", "MEMORY_FINALIZATION", "EMBEDDINGS", "FINALIZING"] as const)("resumes from %s without rerunning completed earlier provider work", async (stage) => {
    const data = await fixture();
    await processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks)));
    await prisma.bookAnalysisRun.update({ where: { id: data.run.id }, data: { status: "FAILED", analysisStage: stage, completedAt: null, executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null } });
    await prisma.job.update({ where: { id: data.job.id }, data: { status: "FAILED", completedAt: null } });
    const provider = new DurableProvider(data.blocks), gatewayCallsBefore = data.gateway.remoteCallCount();
    await processBookAnalysisRun(data.run.id, deps(data, provider));
    expect(provider.requests).toHaveLength(0);
    expect(data.gateway.remoteCallCount()).toBe(gatewayCallsBefore);
  });

  it("terminal redelivery is a strict no-op", async () => {
    const data = await fixture();
    await processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks)));
    const before = { attempts: (await prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })).attemptCount, artifacts: await prisma.analysisArtifact.count({ where: { analysisRunId: data.run.id } }), memories: await prisma.bookMemoryItem.count({ where: { analysisRunId: data.run.id } }), reductions: await prisma.analysisReductionResult.count({ where: { analysisRunId: data.run.id } }) };
    const provider = new DurableProvider(data.blocks), gatewayCallsBefore = data.gateway.remoteCallCount();
    await processBookAnalysisRun(data.run.id, deps(data, provider));
    const after = { attempts: (await prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })).attemptCount, artifacts: await prisma.analysisArtifact.count({ where: { analysisRunId: data.run.id } }), memories: await prisma.bookMemoryItem.count({ where: { analysisRunId: data.run.id } }), reductions: await prisma.analysisReductionResult.count({ where: { analysisRunId: data.run.id } }) };
    expect(after).toEqual(before);
    expect(provider.requests).toHaveLength(0);
    expect(data.gateway.remoteCallCount()).toBe(gatewayCallsBefore);
  });

  it("does not publish A when extraction B commits before finalization locks the current row", async () => {
    const data = await fixture();
    const barrier = new DeterministicBarrier();
    const finalization = processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks), { faultInjector: async (point) => { if (point === "beforeFinalization") await barrier.wait(); } }));
    await barrier.entered;
    try {
      const extractionB = await createReplacementExtraction(data);
      await prisma.currentDocumentExtraction.update({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: data.document.id, workspaceId: data.workspace.id } }, data: { extractionId: extractionB.id } });
    } finally {
      barrier.unblock();
    }
    await finalization;
    expect((await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } })).status).toBe("SUCCEEDED");
    expect(await prisma.currentBookIntelligence.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: data.document.id, workspaceId: data.workspace.id } } })).toBeNull();
  });

  it("serializes extraction B after a finalizer holding the current-row lock and rejects A as stale", async () => {
    const data = await fixture();
    const barrier = new DeterministicBarrier();
    const embeddings = new RecordingEmbeddingProvider();
    const finalization = processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks), { faultInjector: async (point) => { if (point === "afterCurrentExtractionLock") await barrier.wait(); } }));
    await barrier.entered;
    const extractionB = await createReplacementExtraction(data);
    let publishBackendPid!: (pid: number) => void;
    const backendPid = new Promise<number>((resolve) => { publishBackendPid = resolve; });
    const moveCurrent = prisma.$transaction(async (tx) => {
      const [session] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      publishBackendPid(session!.pid);
      await tx.currentDocumentExtraction.update({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: data.document.id, workspaceId: data.workspace.id } }, data: { extractionId: extractionB.id } });
    });
    try {
      await waitForPostgresRowLock(await backendPid);
    } finally {
      barrier.unblock();
    }
    await Promise.all([finalization, moveCurrent]);
    const intelligence = await prisma.currentBookIntelligence.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: data.document.id, workspaceId: data.workspace.id } } });
    expect(intelligence.extractionId).toBe(data.extraction.id);
    await expect(retrieveBookKnowledge({ workspaceId: data.workspace.id, sourceDocumentId: data.document.id, query: "evidence", limit: 5, embeddingProvider: embeddings })).rejects.toThrow("BOOK_INTELLIGENCE_STALE");
  });

  it("uses conservative English, Chinese, mixed-language, and emoji estimates in built context", async () => {
    const data = await fixture();
    const embeddings = new RecordingEmbeddingProvider();
    await processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks)));
    const memoryCount = await prisma.bookMemoryItem.count({ where: { analysisRunId: data.run.id } });
    const samples = [
      "A concise English sentence with several words.",
      "这是一个用于验证中文预算估算的确定性测试。",
      "中文 mixed English 12345",
      "😀🚀🧠✨😀🚀🧠✨",
    ];
    for (const content of samples) {
      await prisma.bookMemoryItem.updateMany({ where: { analysisRunId: data.run.id }, data: { content } });
      const context = await buildBookContext({ workspaceId: data.workspace.id, sourceDocumentId: data.document.id, task: "budget", tokenBudget: 1_000_000, embeddingProvider: embeddings });
      expect(context.items).toHaveLength(memoryCount);
      expect(context.estimatedTokens).toBe(context.items.reduce((sum, item) => sum + estimateAnalysisTokens(item.content), 0));
      expect(context.estimatedTokens).toBeLessThanOrEqual(1_000_000);
    }
    const chinese = "中文预算回归".repeat(12);
    const oldQuarterLengthBudget = Math.ceil(chinese.length / 4);
    expect(estimateAnalysisTokens(chinese)).toBeGreaterThan(oldQuarterLengthBudget);
    await prisma.bookMemoryItem.updateMany({ where: { analysisRunId: data.run.id }, data: { content: chinese } });
    const constrained = await buildBookContext({ workspaceId: data.workspace.id, sourceDocumentId: data.document.id, task: "budget", tokenBudget: oldQuarterLengthBudget, embeddingProvider: embeddings });
    expect(constrained.items).toHaveLength(0);
    expect(constrained.estimatedTokens).toBe(0);
    expect(constrained.estimatedTokens).toBeLessThanOrEqual(oldQuarterLengthBudget);
  });

  it("rejects stale current intelligence while preserving historical results and exposes complete context provenance", async () => {
    const data = await fixture();
    const embeddings = new RecordingEmbeddingProvider();
    await processBookAnalysisRun(data.run.id, deps(data, new DurableProvider(data.blocks)));
    const context = await buildBookContext({ workspaceId: data.workspace.id, sourceDocumentId: data.document.id, task: "evidence", tokenBudget: 1000, embeddingProvider: embeddings });
    expect(context.items.length).toBeGreaterThan(0);
    expect(context.items.every((item) => item.sourceDocumentId === data.document.id && item.extractionId === data.extraction.id && item.chunkSetId === data.chunkSet.id && item.analysisRunId === data.run.id && item.memoryItemId && item.type && item.embedding?.embeddingIdentityHash && item.selectionReason && item.tokenEstimate > 0 && Array.isArray(item.sourceBlockEvidenceSpans))).toBe(true);
    const extractionB = await createReplacementExtraction(data);
    await prisma.currentDocumentExtraction.update({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: data.document.id, workspaceId: data.workspace.id } }, data: { extractionId: extractionB.id } });
    await expect(retrieveBookKnowledge({ workspaceId: data.workspace.id, sourceDocumentId: data.document.id, query: "evidence", limit: 5, embeddingProvider: embeddings })).rejects.toThrow("BOOK_INTELLIGENCE_STALE");
    await expect(buildBookContext({ workspaceId: data.workspace.id, sourceDocumentId: data.document.id, task: "evidence", tokenBudget: 100, embeddingProvider: embeddings })).rejects.toThrow("BOOK_INTELLIGENCE_STALE");
    expect((await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } })).status).toBe("SUCCEEDED");
  });

  it("proves ChunkSet claim, reclaim, stale-owner rejection, and immutable success", async () => {
    const data = await fixture();
    expect(await claimChunkSetMaterialization(data.chunkSet.id, crypto.randomUUID())).toBeNull();
    const fresh = await prisma.chunkSet.create({ data: { workspaceId: data.workspace.id, sourceDocumentId: data.document.id, extractionId: data.extraction.id, chunkingVersion: "claim-test", configuration: {}, configurationHash: crypto.randomUUID() } });
    const tokenA = crypto.randomUUID(), loser = crypto.randomUUID(), tokenB = crypto.randomUUID();
    const a = await claimChunkSetMaterialization(fresh.id, tokenA);
    expect(a).toBe(tokenA);
    expect(await claimChunkSetMaterialization(fresh.id, loser)).toBeNull();
    const rollbackHash = `rollback-${crypto.randomUUID()}`;
    const structureNode = await prisma.documentStructureNode.findFirstOrThrow({ where: { extractionId: data.extraction.id } });
    await expect(withOwnedChunkSetTransaction(fresh.id, tokenA, async (tx) => { await tx.documentChunk.create({ data: { workspaceId: data.workspace.id, chunkSetId: fresh.id, extractionId: data.extraction.id, structureNodeId: structureNode.id, structureVersion: structureNode.structureVersion, ordinal: 99, content: "rollback", contentHash: rollbackHash, characterCount: 8, tokenEstimate: 2 } }); throw new Error("ROLLBACK"); })).rejects.toThrow("ROLLBACK");
    expect(await prisma.documentChunk.count({ where: { chunkSetId: fresh.id, contentHash: rollbackHash } })).toBe(0);
    await prisma.$executeRaw`UPDATE "ChunkSet" SET "materializationLeaseUntil" = NOW() - INTERVAL '1 second' WHERE "id" = ${fresh.id}`;
    expect(await claimChunkSetMaterialization(fresh.id, tokenB)).toBe(tokenB);
    await expect(withOwnedChunkSetTransaction(fresh.id, tokenA, (tx) => tx.chunkSet.update({ where: { id: fresh.id }, data: { status: "SUCCEEDED" } }))).rejects.toThrow(CHUNK_SET_OWNERSHIP_LOST);
    await withOwnedChunkSetTransaction(fresh.id, tokenB, (tx) => tx.chunkSet.update({ where: { id: fresh.id }, data: { status: "SUCCEEDED", materializationClaimToken: null, materializationLeaseUntil: null } }));
    expect(await claimChunkSetMaterialization(fresh.id, crypto.randomUUID())).toBeNull();
  });
});
