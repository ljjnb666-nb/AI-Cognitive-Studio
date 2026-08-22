import { prisma } from "@ai-cognitive/db";
import { ProviderExecutionRepository, ProviderGatewayRepository, testCipher } from "@ai-cognitive/provider-gateway";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { materializeChunkSet } from "../src/persistence.js";
import { processBookAnalysisRun, requestBookAnalysisForUser, type ProcessBookAnalysisDependencies } from "../src/pipeline.js";
import type { AnalysisProvider, AnalysisResponse } from "../src/analysis.js";
import { DeterministicFakeEmbeddingProvider, embeddingIdentityWithHash } from "../src/embeddings.js";
import { materializeBookMemoryEmbeddings, materializeDocumentChunkEmbeddings } from "../src/gateway-materialization.js";
import { clearBookAnalysisEmbeddingGatewayFixtureState, createBookAnalysisEmbeddingGatewayFixture } from "./helpers/book-analysis-embedding-gateway.js";

/** The final Checkpoint 3A matrix deliberately uses real Prisma/Gateway rows. */
const owned: Array<{ workspaceId: string; userId: string }> = [];
const capability = { modelId: "checkpoint3a", families: ["EMBEDDING"] as const, confidence: "VERIFIED" as const, embeddingDimensions: 4, maxEmbeddingInputs: 1024, embeddingPurposes: ["DOCUMENT"] as const };

class Analysis implements AnalysisProvider {
  async generateStructured(input: Parameters<AnalysisProvider["generateStructured"]>[0]): Promise<AnalysisResponse> {
    if (input.stage === "BOOK") return { summary: "book", memory: [{ type: "SUMMARY", content: "matrix summary" }, { type: "CONCEPT", content: "matrix concept" }] };
    return { summary: `chunk:${input.content}`, memory: [{ type: "CLAIM", content: `claim:${input.content}` }] };
  }
}

async function fixture() {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { email: `${suffix}@checkpoint3a.test` } });
  const workspace = await prisma.workspace.create({ data: { name: `checkpoint3a-${suffix}` } });
  owned.push({ workspaceId: workspace.id, userId: user.id });
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "matrix.md" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: `checkpoint3a/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: blob.storageKey } });
  const ingestJob = await prisma.job.create({ data: { workspaceId: workspace.id, type: "source.ingest", payload: {}, idempotencyKey: `ingest:${suffix}` } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: ingestJob.id, parserVersion: "matrix", normalizationVersion: "matrix" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "matrix", parserVersion: "matrix", normalizationVersion: "matrix" } });
  for (const [ordinal, text] of ["# Matrix", "Alpha evidence paragraph with enough stable content for materialization.", "Beta evidence paragraph with enough stable content for materialization."].entries()) await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal, kind: ordinal === 0 ? "HEADING" : "PARAGRAPH", text, contentHash: `${suffix}:${ordinal}` } });
  await prisma.currentDocumentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id } });
  const chunkSet = await materializeChunkSet({ workspaceId: workspace.id, sourceDocumentId: document.id, configuration: { targetSize: 35, hardMax: 45 } });
  const requested = await requestBookAnalysisForUser({ workspaceId: workspace.id, userId: user.id }, { sourceDocumentId: document.id, pipelineVersion: `matrix-${suffix}`, promptVersion: "p", provider: "test", model: "test" });
  const gateway = await createBookAnalysisEmbeddingGatewayFixture({ workspaceId: workspace.id, userId: user.id });
  return { user, workspace, document, extraction, chunkSet, run: requested.run, job: requested.job, gateway };
}

function deps(data: Awaited<ReturnType<typeof fixture>>, extras: Partial<ProcessBookAnalysisDependencies> = {}): ProcessBookAnalysisDependencies {
  return { analysisProvider: new Analysis(), embeddingProvider: new DeterministicFakeEmbeddingProvider(), embeddingGateway: data.gateway.embeddingGateway, ...extras };
}
async function accounting(workspaceId: string) {
  const [snapshot, invocation, attempt, usage, result] = await Promise.all([prisma.providerExecutionSnapshot.count({ where: { workspaceId } }), prisma.providerInvocation.count({ where: { workspaceId } }), prisma.providerInvocationAttempt.count({ where: { workspaceId } }), prisma.providerUsageEvent.count({ where: { workspaceId } }), prisma.providerEmbeddingResult.count({ where: { workspaceId } })]);
  return { snapshot, invocation, attempt, usage, result };
}
async function receipt(workspaceId: string) { return prisma.providerEmbeddingResult.findFirstOrThrow({ where: { workspaceId } }); }
async function seedReceipt(workspaceId: string, count: number, dimensions = 4, receiptDimensions = dimensions) {
  const cipher = testCipher(), snapshotId = randomUUID(), invocationId = randomUUID(), attemptId = randomUUID();
  await prisma.providerExecutionSnapshot.create({ data: { id: snapshotId, workspaceId, routeSlot: "EMBEDDING", providerKey: "deterministic-test", protocol: "TEST", modelId: capability.modelId, capability: { ...capability, embeddingDimensions: dimensions }, configuration: {}, configurationHash: "matrix", adapterVersion: "matrix", correlationId: invocationId } });
  await prisma.providerInvocation.create({ data: { id: invocationId, workspaceId, snapshotId, providerKey: "deterministic-test", protocol: "TEST", modelId: capability.modelId, routeSlot: "EMBEDDING", idempotencyKey: invocationId, requestFingerprint: "a".repeat(64), correlationId: invocationId, status: "SUCCEEDED", completedAt: new Date() } });
  await prisma.providerInvocationAttempt.create({ data: { id: attemptId, workspaceId, invocationId, attemptNumber: 1, status: "SUCCEEDED", completedAt: new Date() } });
  const vectors = Array.from({ length: count }, (_, index) => Array.from({ length: receiptDimensions }, (_, dimension) => index === dimension ? 1 : 0));
  const encrypted = cipher.encryptEmbeddingResult(JSON.stringify({ vectors, dimensions: receiptDimensions }), { workspaceId, invocationId, attemptId, snapshotId, providerKey: "deterministic-test", modelId: capability.modelId });
  await prisma.providerEmbeddingResult.create({ data: { workspaceId, invocationId, attemptId, snapshotId, ...encrypted, vectorCount: count, dimensions: receiptDimensions } });
  return { repository: new ProviderExecutionRepository(prisma, cipher), invocationId, snapshotId };
}

afterEach(async () => {
  for (const { workspaceId, userId } of owned.splice(0)) {
    await clearBookAnalysisEmbeddingGatewayFixtureState(workspaceId);
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
    await prisma.user.delete({ where: { id: userId } });
  }
});

describe("Phase 8C Checkpoint 3A CASE01-16 acceptance matrix", () => {
  it("CASE01 happy composite execution", async () => {
    const data = await fixture(); await processBookAnalysisRun(data.run.id, deps(data));
    expect(data.gateway.remoteCallCount()).toBe(1); expect(await accounting(data.workspace.id)).toEqual({ snapshot: 1, invocation: 1, attempt: 1, usage: 1, result: 1 });
    const run = await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } });
    expect(run.analysisStage).toBe("COMPLETED"); expect(run.modelVersion).toBeNull();
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBeGreaterThan(0);
    expect(await prisma.bookMemoryEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBeGreaterThan(0);
    expect(await receipt(data.workspace.id)).toMatchObject({ consumerKind: "BOOK_ANALYSIS_EMBEDDINGS", consumerKey: data.run.id, ciphertext: null, iv: null, authTag: null, keyVersion: null, consumedAt: expect.any(Date), purgedAt: expect.any(Date) });
  });

  it("CASE02 exact target order and request identity", async () => {
    const data = await fixture(); await processBookAnalysisRun(data.run.id, deps(data));
    const chunks = await prisma.documentChunk.findMany({ where: { chunkSetId: data.chunkSet.id }, orderBy: [{ ordinal: "asc" }, { id: "asc" }] });
    const memories = await prisma.bookMemoryItem.findMany({ where: { analysisRunId: data.run.id }, orderBy: [{ ordinal: "asc" }, { id: "asc" }] });
    expect(data.gateway.remoteInputs()).toEqual([[...chunks.map((item) => item.content), ...memories.map((item) => item.content)]]);
    const invocation = await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: data.workspace.id } });
    expect(invocation.idempotencyKey).toBe(`book-analysis-embeddings:${data.run.id}`); expect(invocation.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("CASE03 crash after durable gateway success reuses encrypted receipt", async () => {
    const data = await fixture(); const crash = { faultInjector: (point: string) => { if (point === "afterEmbeddingGatewayPersist") throw new Error("CASE03"); } };
    await expect(processBookAnalysisRun(data.run.id, deps(data, crash))).rejects.toThrow("CASE03");
    expect(data.gateway.remoteCallCount()).toBe(1); expect(await receipt(data.workspace.id)).toMatchObject({ consumedAt: null, purgedAt: null, ciphertext: expect.any(String), iv: expect.any(String), authTag: expect.any(String), keyVersion: expect.any(String) });
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(0); await processBookAnalysisRun(data.run.id, deps(data));
    expect(data.gateway.remoteCallCount()).toBe(1); expect((await receipt(data.workspace.id)).consumedAt).not.toBeNull();
  });

  it("CASE04 crash after materialization before stage advance is idempotent", async () => {
    const data = await fixture(); const crash = { faultInjector: (point: string) => { if (point === "afterEmbeddingMaterialization") throw new Error("CASE04"); } };
    await expect(processBookAnalysisRun(data.run.id, deps(data, crash))).rejects.toThrow("CASE04");
    const before = await accounting(data.workspace.id); expect((await receipt(data.workspace.id)).consumedAt).not.toBeNull();
    await processBookAnalysisRun(data.run.id, deps(data)); expect(data.gateway.remoteCallCount()).toBe(1); expect(await accounting(data.workspace.id)).toEqual(before);
    expect((await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: data.run.id } })).analysisStage).toBe("COMPLETED");
  });

  it("CASE05 stale owner cannot consume and reclaimer uses same receipt", async () => {
    const data = await fixture();
    const a = processBookAnalysisRun(data.run.id, deps(data, { faultInjector: async (point) => { if (point === "afterEmbeddingGatewayPersist") { await prisma.$executeRaw`UPDATE "BookAnalysisRun" SET "executionLeaseUntil" = NOW() - INTERVAL '1 second' WHERE "id" = ${data.run.id}`; throw new Error("BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST"); } } }));
    await expect(a).rejects.toThrow("BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST"); expect(data.gateway.remoteCallCount()).toBe(1); expect((await receipt(data.workspace.id)).consumedAt).toBeNull();
    await processBookAnalysisRun(data.run.id, deps(data)); expect(data.gateway.remoteCallCount()).toBe(1); expect((await receipt(data.workspace.id)).consumedAt).not.toBeNull();
  });

  it("CASE06 document lineage mutation is atomic and leaves receipt recoverable", async () => {
    const data = await fixture();
    await expect(processBookAnalysisRun(data.run.id, deps(data, { faultInjector: async (point) => { if (point === "afterEmbeddingGatewayPersist") { const chunk = await prisma.documentChunk.findFirstOrThrow({ where: { chunkSetId: data.chunkSet.id } }); await prisma.documentChunk.update({ where: { id: chunk.id }, data: { contentHash: "mutated" } }); } } }))).rejects.toThrow("Document chunk lineage changed");
    expect(data.gateway.remoteCallCount()).toBe(1); expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(0); expect(await prisma.bookMemoryEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(0); expect((await receipt(data.workspace.id)).consumedAt).toBeNull();
  });

  it("CASE07 memory lineage mutation is atomic and leaves receipt recoverable", async () => {
    const data = await fixture();
    await expect(processBookAnalysisRun(data.run.id, deps(data, { faultInjector: async (point) => { if (point === "afterEmbeddingGatewayPersist") { const item = await prisma.bookMemoryItem.findFirstOrThrow({ where: { analysisRunId: data.run.id } }); await prisma.bookMemoryItem.update({ where: { id: item.id }, data: { contentHash: "mutated" } }); } } }))).rejects.toThrow("Book memory lineage changed");
    expect(data.gateway.remoteCallCount()).toBe(1); expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(0); expect(await prisma.bookMemoryEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(0); expect((await receipt(data.workspace.id)).consumedAt).toBeNull();
  });

  it("CASE08 cross-workspace materialization fails closed", async () => {
    const owner = await fixture(), foreign = await fixture(), seeded = await seedReceipt(owner.workspace.id, 1);
    const foreignChunk = await prisma.documentChunk.findFirstOrThrow({ where: { chunkSetId: foreign.chunkSet.id } });
    await expect(materializeDocumentChunkEmbeddings(seeded.repository, { workspaceId: owner.workspace.id, invocationId: seeded.invocationId, snapshotId: seeded.snapshotId, embeddingVersion: "gateway", targets: [{ id: foreignChunk.id, extractionId: foreign.extraction.id, contentHash: foreignChunk.contentHash }] })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: foreign.workspace.id } })).toBe(0); expect((await receipt(owner.workspace.id)).consumedAt).toBeNull();
  });

  it("CASE09 vector count mismatch has no partial writes", async () => {
    const data = await fixture(), seeded = await seedReceipt(data.workspace.id, 1), chunks = await prisma.documentChunk.findMany({ where: { chunkSetId: data.chunkSet.id }, take: 2 });
    await expect(materializeDocumentChunkEmbeddings(seeded.repository, { workspaceId: data.workspace.id, invocationId: seeded.invocationId, snapshotId: seeded.snapshotId, embeddingVersion: "gateway", targets: chunks.map((chunk) => ({ id: chunk.id, extractionId: data.extraction.id, contentHash: chunk.contentHash })) })).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(0); expect((await receipt(data.workspace.id)).consumedAt).toBeNull();
  });

  it("CASE10 vector dimension mismatch has no partial writes", async () => {
    const data = await fixture(), seeded = await seedReceipt(data.workspace.id, 1, 4, 3), chunk = await prisma.documentChunk.findFirstOrThrow({ where: { chunkSetId: data.chunkSet.id } });
    await expect(materializeDocumentChunkEmbeddings(seeded.repository, { workspaceId: data.workspace.id, invocationId: seeded.invocationId, snapshotId: seeded.snapshotId, embeddingVersion: "gateway", targets: [{ id: chunk.id, extractionId: data.extraction.id, contentHash: chunk.contentHash }] })).rejects.toMatchObject({ code: "INTERNAL_PROVIDER_ERROR" });
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(0); expect((await receipt(data.workspace.id)).consumedAt).toBeNull();
  });

  it("CASE11 identical existing destinations are accepted", async () => {
    const data = await fixture(); await processBookAnalysisRun(data.run.id, deps(data));
    const before = await accounting(data.workspace.id); await prisma.bookAnalysisRun.update({ where: { id: data.run.id }, data: { status: "FAILED", analysisStage: "EMBEDDINGS", completedAt: null } });
    await processBookAnalysisRun(data.run.id, deps(data)); expect(await accounting(data.workspace.id)).toEqual(before); expect(data.gateway.remoteCallCount()).toBe(1);
  });

  it("CASE12 conflicting document embedding leaves receipt unconsumed", async () => {
    const data = await fixture(), seeded = await seedReceipt(data.workspace.id, 1), chunk = await prisma.documentChunk.findFirstOrThrow({ where: { chunkSetId: data.chunkSet.id } });
    const identity = embeddingIdentityWithHash({ provider: "deterministic-test", model: capability.modelId, embeddingVersion: "gateway", dimensions: 4 });
    await prisma.documentChunkEmbedding.create({ data: { chunkId: chunk.id, workspaceId: data.workspace.id, extractionId: data.extraction.id, provider: "deterministic-test", model: capability.modelId, embeddingVersion: "gateway", embeddingIdentityHash: identity.hash, dimensions: 4, vector: [9, 9, 9, 9] } });
    await expect(materializeDocumentChunkEmbeddings(seeded.repository, { workspaceId: data.workspace.id, invocationId: seeded.invocationId, snapshotId: seeded.snapshotId, embeddingVersion: "gateway", targets: [{ id: chunk.id, extractionId: data.extraction.id, contentHash: chunk.contentHash }] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await prisma.providerEmbeddingResult.findUniqueOrThrow({ where: { invocationId: seeded.invocationId } })).consumedAt).toBeNull();
  });

  it("CASE13 conflicting memory embedding leaves receipt unconsumed", async () => {
    const data = await fixture(); await processBookAnalysisRun(data.run.id, deps(data));
    const item = await prisma.bookMemoryItem.findFirstOrThrow({ where: { analysisRunId: data.run.id } }); const seeded = await seedReceipt(data.workspace.id, 1);
    const identity = embeddingIdentityWithHash({ provider: "deterministic-test", model: capability.modelId, embeddingVersion: "gateway", dimensions: 4 });
    await prisma.bookMemoryEmbedding.create({ data: { memoryItemId: item.id, analysisRunId: data.run.id, workspaceId: data.workspace.id, extractionId: data.extraction.id, provider: "deterministic-test", model: capability.modelId, embeddingVersion: "gateway", embeddingIdentityHash: identity.hash, dimensions: 4, vector: [9, 9, 9, 9] } });
    await expect(materializeBookMemoryEmbeddings(seeded.repository, { workspaceId: data.workspace.id, invocationId: seeded.invocationId, snapshotId: seeded.snapshotId, embeddingVersion: "gateway", targets: [{ id: item.id, extractionId: data.extraction.id, analysisRunId: data.run.id, contentHash: item.contentHash }] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await prisma.providerEmbeddingResult.findUniqueOrThrow({ where: { invocationId: seeded.invocationId } })).consumedAt).toBeNull();
  });

  it("CASE14 consumed receipt redelivery has no accounting increase", async () => {
    const data = await fixture(); await processBookAnalysisRun(data.run.id, deps(data)); const before = await accounting(data.workspace.id);
    await processBookAnalysisRun(data.run.id, deps(data)); expect(await accounting(data.workspace.id)).toEqual(before); expect(data.gateway.remoteCallCount()).toBe(1);
  });

  it("CASE15 reconciliation required fails closed without a recall", async () => {
    const data = await fixture();
    await expect(processBookAnalysisRun(data.run.id, deps(data, { faultInjector: async (point) => { if (point === "afterEmbeddingGatewayPersist") { const row = await receipt(data.workspace.id); await prisma.providerEmbeddingResult.update({ where: { id: row.id }, data: { ciphertext: "corrupt" } }); } } }))).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(data.gateway.remoteCallCount()).toBe(1); expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(0);
  });

  it("CASE16 route change after durable success fails closed without Provider B execution", async () => {
    const data = await fixture();
    await expect(processBookAnalysisRun(data.run.id, deps(data, { faultInjector: (point) => { if (point === "afterEmbeddingGatewayPersist") throw new Error("CASE16"); } }))).rejects.toThrow("CASE16");
    const before = await accounting(data.workspace.id);
    const routes = new ProviderGatewayRepository(prisma, testCipher());
    const providerB = await routes.createConnection({ workspaceId: data.workspace.id, userId: data.user.id }, { providerKey: "deterministic-test", protocol: "TEST", displayName: "checkpoint3a-provider-b" });
    await routes.rotateCredential({ workspaceId: data.workspace.id, userId: data.user.id }, providerB.id, "checkpoint3a-provider-b-credential");
    await routes.setRoute({ workspaceId: data.workspace.id, userId: data.user.id }, { routeSlot: "EMBEDDING", connectionId: providerB.id, modelId: "deterministic-vector-v1" });
    await expect(processBookAnalysisRun(data.run.id, deps(data))).rejects.toThrow();
    expect(data.gateway.remoteCallCount()).toBe(1); expect(await accounting(data.workspace.id)).toEqual(before);
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(0); expect((await receipt(data.workspace.id)).consumedAt).toBeNull();
  });
});
