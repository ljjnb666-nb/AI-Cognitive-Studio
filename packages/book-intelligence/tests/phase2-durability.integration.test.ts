import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/src/index.js";
import {
  BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST,
  CHUNK_SET_OWNERSHIP_LOST,
  DeterministicFakeEmbeddingProvider,
  claimChunkSetMaterialization,
  buildBookContext,
  estimateAnalysisTokens,
  materializeChunkSet,
  processBookAnalysisRun,
  requestBookAnalysis,
  retrieveBookKnowledge,
  withOwnedChunkSetTransaction,
  type AnalysisProvider,
  type AnalysisRequest,
  type AnalysisResponse,
  type EmbeddingProvider,
} from "../src/index.js";

const workspaces: string[] = [];
const users: string[] = [];
async function fixture(blockTexts = ["# Chapter", ...Array.from({ length: 6 }, (_, index) => `Paragraph ${index} ${"evidence ".repeat(7)}`)]) {
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
  return { workspace, document, extraction, blocks, chunkSet, run: requested.run, job: requested.job };
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
  readonly calls: string[][] = [];
  override async embed(input: { texts: string[] }): Promise<number[][]> { this.calls.push([...input.texts]); return super.embed(input); }
}

class BarrierEmbeddingProvider implements EmbeddingProvider {
  readonly identity = { provider: "stale-a", model: "stale-a", embeddingVersion: "stale-a", dimensions: 4 };
  readonly entered: Promise<void>;
  private enter!: () => void;
  private release!: () => void;
  private readonly released: Promise<void>;
  constructor() { this.entered = new Promise((resolve) => { this.enter = resolve; }); this.released = new Promise((resolve) => { this.release = resolve; }); }
  unblock() { this.release(); }
  async embed(input: { texts: string[] }): Promise<number[][]> { this.enter(); await this.released; return input.texts.map(() => [1, 0, 0, 0]); }
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
  it("has one claim winner, permits stale reclaim, rejects stale persistence, and does not increment a claim loser", async () => {
    const data = await fixture();
    const barrier = new BarrierProvider();
    const a = processBookAnalysisRun(data.run.id, { analysisProvider: barrier, embeddingProvider: new RecordingEmbeddingProvider() });
    await barrier.entered;
    const attemptsAfterA = (await prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })).attemptCount;
    await processBookAnalysisRun(data.run.id, { analysisProvider: new DurableProvider(data.blocks), embeddingProvider: new RecordingEmbeddingProvider() });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })).attemptCount).toBe(attemptsAfterA);
    await expireLease(data.run.id);
    await processBookAnalysisRun(data.run.id, { analysisProvider: new DurableProvider(data.blocks), embeddingProvider: new RecordingEmbeddingProvider() });
    barrier.unblock();
    await expect(a).rejects.toThrow(BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST);
    expect(await prisma.analysisArtifact.count({ where: { analysisRunId: data.run.id, summary: "STALE_A_RESPONSE" } })).toBe(0);
    expect((await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } })).status).toBe("SUCCEEDED");
  });

  it("does not let a stale provider failure overwrite the reclaiming worker", async () => {
    const data = await fixture();
    const barrier = new BarrierProvider(new Error("STALE_PROVIDER_FAILED"));
    const a = processBookAnalysisRun(data.run.id, { analysisProvider: barrier, embeddingProvider: new RecordingEmbeddingProvider() });
    await barrier.entered;
    await expireLease(data.run.id);
    await processBookAnalysisRun(data.run.id, { analysisProvider: new DurableProvider(data.blocks), embeddingProvider: new RecordingEmbeddingProvider() });
    barrier.unblock();
    await expect(a).rejects.toThrow("STALE_PROVIDER_FAILED");
    const [run, job] = await Promise.all([prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })]);
    expect([run.status, job.status, run.analysisStage]).toEqual(["SUCCEEDED", "SUCCEEDED", "COMPLETED"]);
  });

  it("resumes chunks without recalling the provider for persisted artifacts", async () => {
    const data = await fixture();
    const provider = new DurableProvider(data.blocks);
    let persisted = 0;
    await expect(processBookAnalysisRun(data.run.id, { analysisProvider: provider, embeddingProvider: new RecordingEmbeddingProvider(), faultInjector: (point) => { if (point === "afterChunkPersist" && ++persisted === 2) throw new Error("CHUNK_CRASH"); } })).rejects.toThrow("CHUNK_CRASH");
    expect(await prisma.analysisArtifact.count({ where: { analysisRunId: data.run.id, scope: "CHUNK" } })).toBe(2);
    const callsAfterCrash = provider.requests.filter((request) => request.stage === "CHUNK").length;
    await processBookAnalysisRun(data.run.id, { analysisProvider: provider, embeddingProvider: new RecordingEmbeddingProvider() });
    const expected = await prisma.documentChunk.count({ where: { chunkSetId: data.chunkSet.id } });
    expect(provider.requests.filter((request) => request.stage === "CHUNK")).toHaveLength(expected);
    expect(callsAfterCrash).toBe(2);
    expect(await prisma.analysisArtifact.count({ where: { analysisRunId: data.run.id, scope: "CHUNK" } })).toBe(expected);
  });

  it("reuses persisted recursive reductions after a crash without losing marker paths", async () => {
    const texts = ["# Chapter One", `BEGIN_MARKER ${"a ".repeat(35)}`, "## Section One", `${"b ".repeat(35)}`, `${"c ".repeat(35)}`, "# Chapter Two", "## Section Two", `MIDDLE_MARKER ${"d ".repeat(35)}`, `${"e ".repeat(35)}`, `END_MARKER ${"f ".repeat(35)}`];
    const data = await fixture(texts);
    const provider = new DurableProvider(data.blocks, true);
    let reductions = 0;
    await expect(processBookAnalysisRun(data.run.id, { analysisProvider: provider, embeddingProvider: new RecordingEmbeddingProvider(), faultInjector: (point) => { if (point === "afterReductionPersist" && ++reductions === 2) throw new Error("REDUCTION_CRASH"); } })).rejects.toThrow("REDUCTION_CRASH");
    expect(await prisma.analysisReductionResult.count({ where: { analysisRunId: data.run.id } })).toBe(2);
    await processBookAnalysisRun(data.run.id, { analysisProvider: provider, embeddingProvider: new RecordingEmbeddingProvider() });
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
    await expect(processBookAnalysisRun(data.run.id, { analysisProvider: provider, embeddingProvider: new RecordingEmbeddingProvider(), faultInjector: (point) => { if (point === "afterMemoryPersist" && ++memories === 3) throw new Error("MEMORY_CRASH"); } })).rejects.toThrow("MEMORY_CRASH");
    const partial = await prisma.bookMemoryItem.findMany({ where: { analysisRunId: data.run.id }, orderBy: { ordinal: "asc" } });
    await processBookAnalysisRun(data.run.id, { analysisProvider: provider, embeddingProvider: new RecordingEmbeddingProvider() });
    const [items, evidence, relations] = await Promise.all([prisma.bookMemoryItem.findMany({ where: { analysisRunId: data.run.id }, orderBy: { ordinal: "asc" } }), prisma.bookMemoryEvidence.findMany({ where: { analysisRunId: data.run.id } }), prisma.bookMemoryRelation.findMany({ where: { analysisRunId: data.run.id } })]);
    expect(items.slice(0, partial.length).map((item) => [item.memoryKey, item.ordinal])).toEqual(partial.map((item) => [item.memoryKey, item.ordinal]));
    expect(new Set(items.map((item) => item.memoryKey)).size).toBe(items.length);
    expect(new Set(evidence.map((item) => `${item.memoryItemId}:${item.sourceBlockId}:${item.startOffset}:${item.endOffset}:${item.quoteHash ?? ""}`)).size).toBe(evidence.length);
    expect(new Set(relations.map((item) => `${item.fromMemoryItemId}:${item.toMemoryItemId}:${item.type}`)).size).toBe(relations.length);
    expect(evidence.length).toBeGreaterThan(0);
    expect(relations.length).toBeGreaterThan(0);
  });

  it("embeds only missing targets after a partial embedding crash", async () => {
    const data = await fixture();
    const embeddings = new RecordingEmbeddingProvider();
    let persisted = 0;
    await expect(processBookAnalysisRun(data.run.id, { analysisProvider: new DurableProvider(data.blocks), embeddingProvider: embeddings, faultInjector: (point) => { if (point === "afterEmbeddingPersist" && ++persisted === 2) throw new Error("EMBEDDING_CRASH"); } })).rejects.toThrow("EMBEDDING_CRASH");
    const firstTargets = embeddings.calls[0]!;
    await processBookAnalysisRun(data.run.id, { analysisProvider: new DurableProvider(data.blocks), embeddingProvider: embeddings });
    expect(embeddings.calls[1]).toHaveLength(firstTargets.length - 2);
    expect(embeddings.calls[1]).toEqual(firstTargets.slice(2));
  });

  it("rejects vectors returned by an embedding call whose owner became stale", async () => {
    const data = await fixture();
    const staleEmbeddings = new BarrierEmbeddingProvider();
    const a = processBookAnalysisRun(data.run.id, { analysisProvider: new DurableProvider(data.blocks), embeddingProvider: staleEmbeddings });
    await staleEmbeddings.entered;
    await expireLease(data.run.id);
    await processBookAnalysisRun(data.run.id, { analysisProvider: new DurableProvider(data.blocks), embeddingProvider: new RecordingEmbeddingProvider() });
    staleEmbeddings.unblock();
    await expect(a).rejects.toThrow(BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST);
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id, provider: "stale-a" } })).toBe(0);
    expect(await prisma.bookMemoryEmbedding.count({ where: { workspaceId: data.workspace.id, provider: "stale-a" } })).toBe(0);
  });

  it.each(["SECTION_ANALYSIS", "CHAPTER_ANALYSIS", "BOOK_SYNTHESIS", "MEMORY_FINALIZATION", "EMBEDDINGS", "FINALIZING"] as const)("resumes from %s without rerunning completed earlier provider work", async (stage) => {
    const data = await fixture();
    await processBookAnalysisRun(data.run.id, { analysisProvider: new DurableProvider(data.blocks), embeddingProvider: new RecordingEmbeddingProvider() });
    await prisma.bookAnalysisRun.update({ where: { id: data.run.id }, data: { status: "FAILED", analysisStage: stage, completedAt: null, executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null } });
    await prisma.job.update({ where: { id: data.job.id }, data: { status: "FAILED", completedAt: null } });
    const provider = new DurableProvider(data.blocks), embeddings = new RecordingEmbeddingProvider();
    await processBookAnalysisRun(data.run.id, { analysisProvider: provider, embeddingProvider: embeddings });
    expect(provider.requests).toHaveLength(0);
    expect(embeddings.calls).toHaveLength(0);
  });

  it("terminal redelivery is a strict no-op", async () => {
    const data = await fixture();
    await processBookAnalysisRun(data.run.id, { analysisProvider: new DurableProvider(data.blocks), embeddingProvider: new RecordingEmbeddingProvider() });
    const before = { attempts: (await prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })).attemptCount, artifacts: await prisma.analysisArtifact.count({ where: { analysisRunId: data.run.id } }), memories: await prisma.bookMemoryItem.count({ where: { analysisRunId: data.run.id } }), reductions: await prisma.analysisReductionResult.count({ where: { analysisRunId: data.run.id } }) };
    const provider = new DurableProvider(data.blocks), embeddings = new RecordingEmbeddingProvider();
    await processBookAnalysisRun(data.run.id, { analysisProvider: provider, embeddingProvider: embeddings });
    const after = { attempts: (await prisma.job.findUniqueOrThrow({ where: { id: data.job.id } })).attemptCount, artifacts: await prisma.analysisArtifact.count({ where: { analysisRunId: data.run.id } }), memories: await prisma.bookMemoryItem.count({ where: { analysisRunId: data.run.id } }), reductions: await prisma.analysisReductionResult.count({ where: { analysisRunId: data.run.id } }) };
    expect(after).toEqual(before);
    expect(provider.requests).toHaveLength(0);
    expect(embeddings.calls).toHaveLength(0);
  });

  it("does not publish A when extraction B commits before finalization locks the current row", async () => {
    const data = await fixture();
    const barrier = new DeterministicBarrier();
    const finalization = processBookAnalysisRun(data.run.id, {
      analysisProvider: new DurableProvider(data.blocks),
      embeddingProvider: new RecordingEmbeddingProvider(),
      faultInjector: async (point) => { if (point === "beforeFinalization") await barrier.wait(); },
    });
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
    const finalization = processBookAnalysisRun(data.run.id, {
      analysisProvider: new DurableProvider(data.blocks),
      embeddingProvider: embeddings,
      faultInjector: async (point) => { if (point === "afterCurrentExtractionLock") await barrier.wait(); },
    });
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
    await processBookAnalysisRun(data.run.id, { analysisProvider: new DurableProvider(data.blocks), embeddingProvider: embeddings });
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
    await processBookAnalysisRun(data.run.id, { analysisProvider: new DurableProvider(data.blocks), embeddingProvider: embeddings });
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
