import { prisma } from "@ai-cognitive/db";
import { DeterministicProviderHttpTransport, OpenAIEmbeddingAdapter, ProviderExecutionRepository, ProviderGatewayRepository, ProviderRegistry, WorkspaceMembershipExecutionAuthorizer, createProductionProviderGateway, testCipher, type GatewayRequest } from "@ai-cognitive/provider-gateway";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { materializeChunkSet } from "../src/persistence.js";
import { processBookAnalysisRun, requestBookAnalysis } from "../src/pipeline.js";
import type { AnalysisProvider, AnalysisResponse } from "../src/analysis.js";
import { embeddingConsumerFingerprint, materializeBookMemoryEmbeddings, materializeDocumentChunkEmbeddings } from "../src/gateway-materialization.js";
import { embeddingIdentityWithHash } from "../src/embeddings.js";

const owned: Array<{ workspaceId: string; userId: string }> = [];
const capability = { modelId: "phase8c-materialization", families: ["EMBEDDING"] as const, confidence: "VERIFIED" as const, embeddingDimensions: 3, maxEmbeddingInputs: 10, embeddingPurposes: ["DOCUMENT"] as const };
const vectors = [[1, 0, 0], [0, 1, 0]];

class Analysis implements AnalysisProvider {
  async generateStructured(request: Parameters<AnalysisProvider["generateStructured"]>[0]): Promise<AnalysisResponse> {
    if (request.stage === "BOOK") return { summary: "book", memory: [{ type: "SUMMARY", content: "memory one" }, { type: "CONCEPT", content: "memory two" }] };
    return { summary: "chunk" };
  }
}

async function lineage() {
  const suffix = randomUUID(), user = await prisma.user.create({ data: { email: `${suffix}@phase8c.test` } }), workspace = await prisma.workspace.create({ data: { name: suffix } });
  owned.push({ workspaceId: workspace.id, userId: user.id });
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "book.md" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: `phase8c/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: blob.storageKey } });
  const job = await prisma.job.create({ data: { workspaceId: workspace.id, type: "source.ingest", payload: {}, idempotencyKey: `ingest:${suffix}` } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: job.id, parserVersion: "test", normalizationVersion: "test" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } });
  for (const [ordinal, text] of ["# Heading", "First durable paragraph with enough content for a chunk.", "Second durable paragraph with enough content for a chunk."].entries()) await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal, kind: ordinal === 0 ? "HEADING" : "PARAGRAPH", text, contentHash: `${suffix}-${ordinal}` } });
  await prisma.currentDocumentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id } });
  const chunkSet = await materializeChunkSet({ workspaceId: workspace.id, sourceDocumentId: document.id, configuration: { targetSize: 40, hardMax: 50 } });
  const chunks = await prisma.documentChunk.findMany({ where: { chunkSetId: chunkSet.id }, orderBy: { ordinal: "asc" } });
  const request = await requestBookAnalysis({ workspaceId: workspace.id, sourceDocumentId: document.id, pipelineVersion: `phase8c-${suffix}`, promptVersion: "p", provider: "test", model: "test" });
  await processBookAnalysisRun(request.run.id, { analysisProvider: new Analysis(), embeddingProvider: { identity: { provider: "seed", model: "seed", embeddingVersion: "seed", dimensions: 3 }, embed: async input => input.texts.map(() => [0, 0, 1]) } });
  const artifact = await prisma.analysisArtifact.findFirstOrThrow({ where: { analysisRunId: request.run.id }, orderBy: { createdAt: "asc" } });
  const existingMemoryCount = await prisma.bookMemoryItem.count({ where: { analysisRunId: request.run.id } });
  for (const ordinal of [existingMemoryCount, existingMemoryCount + 1]) await prisma.bookMemoryItem.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id, analysisRunId: request.run.id, type: "SUMMARY", ordinal, content: `handoff memory ${ordinal}`, contentHash: `${suffix}-memory-${ordinal}`, sourceArtifactId: artifact.id, memoryKey: `${suffix}-memory-key-${ordinal}` } });
  const memories = await prisma.bookMemoryItem.findMany({ where: { analysisRunId: request.run.id }, orderBy: { ordinal: "asc" } });
  return { workspace, extraction, chunks: chunks.slice(0, 2), run: request.run, memories: memories.slice(0, 2) };
}

async function receipt(workspaceId: string, count: number) {
  const cipher = testCipher(), snapshotId = randomUUID(), invocationId = randomUUID(), attemptId = randomUUID();
  await prisma.providerExecutionSnapshot.create({ data: { id: snapshotId, workspaceId, routeSlot: "EMBEDDING", providerKey: "openai", protocol: "OPENAI_EMBEDDINGS", modelId: capability.modelId, capability, configuration: {}, configurationHash: "phase8c", adapterVersion: "phase8c", correlationId: invocationId } });
  await prisma.providerInvocation.create({ data: { id: invocationId, workspaceId, snapshotId, providerKey: "openai", protocol: "OPENAI_EMBEDDINGS", modelId: capability.modelId, routeSlot: "EMBEDDING", idempotencyKey: invocationId, requestFingerprint: "a".repeat(64), correlationId: invocationId, status: "SUCCEEDED", completedAt: new Date() } });
  await prisma.providerInvocationAttempt.create({ data: { id: attemptId, workspaceId, invocationId, attemptNumber: 1, status: "SUCCEEDED", completedAt: new Date() } });
  const encrypted = cipher.encryptEmbeddingResult(JSON.stringify({ vectors: vectors.slice(0, count), dimensions: 3 }), { workspaceId, invocationId, attemptId, snapshotId, providerKey: "openai", modelId: capability.modelId });
  await prisma.providerEmbeddingResult.create({ data: { workspaceId, invocationId, attemptId, snapshotId, ...encrypted, vectorCount: count, dimensions: 3 } });
  return { repository: new ProviderExecutionRepository(prisma, cipher), invocationId, snapshotId };
}

async function gatewayReceipt(workspaceId: string, userId: string) {
  const cipher = testCipher(), store = new ProviderGatewayRepository(prisma, cipher), transport = new DeterministicProviderHttpTransport(() => ({ status: 200, headers: {}, body: JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })), usage: { prompt_tokens: 7 } }) }));
  const connection = await store.createConnection({ workspaceId, userId }, { providerKey: "openai", protocol: "OPENAI_EMBEDDINGS", displayName: "phase8c" }); await store.rotateCredential({ workspaceId, userId }, connection.id, "phase8c-credential"); await store.setRoute({ workspaceId, userId }, { routeSlot: "EMBEDDING", connectionId: connection.id, modelId: capability.modelId });
  const registry = new ProviderRegistry(); registry.register({ providerKey: "openai", displayName: "openai", protocol: "OPENAI_EMBEDDINGS", adapterVersion: "phase8c", models: [capability] });
  const make = () => createProductionProviderGateway(registry, { resolveWorkspaceRoute: value => store.resolveWorkspaceRoute(value) }, { resolve: async () => undefined }, () => new OpenAIEmbeddingAdapter(transport), { authorize: (principal, value) => new WorkspaceMembershipExecutionAuthorizer(prisma).authorizeExecution(principal, value.workspaceId), assertRouteUsable: async () => undefined, validateEndpoint: async () => undefined, assertBudget: () => undefined, repository: new ProviderExecutionRepository(prisma, cipher), circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async key => ({ key, token: "lease" }), release: async () => true }, maxAttempts: 1 });
  const key = randomUUID(); await make().execute({ workspaceId, routeSlot: "EMBEDDING", correlationId: key, idempotencyKey: key, inputHash: "b".repeat(64), capability: { family: "EMBEDDING" }, embedding: { texts: ["one", "two"], purpose: "DOCUMENT" } satisfies GatewayRequest["embedding"] }, { userId });
  const invocation = await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId } }); return { repository: new ProviderExecutionRepository(prisma, cipher), invocationId: invocation.id, snapshotId: invocation.snapshotId, transport, make };
}

afterEach(async () => { for (const { workspaceId, userId } of owned.splice(0)) { await prisma.providerEmbeddingResult.deleteMany({ where: { workspaceId } }); await prisma.providerUsageEvent.deleteMany({ where: { workspaceId } }); await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId } }); await prisma.providerInvocation.deleteMany({ where: { workspaceId } }); await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId } }); await prisma.providerRouteBinding.deleteMany({ where: { workspaceId } }); await prisma.providerCredentialVersion.deleteMany({ where: { workspaceId } }); await prisma.providerConnection.deleteMany({ where: { workspaceId } }); await prisma.currentBookIntelligence.deleteMany({ where: { workspaceId } }); await prisma.bookAnalysisRun.deleteMany({ where: { workspaceId } }); await prisma.chunkSet.deleteMany({ where: { workspaceId } }); await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId } }); await prisma.documentExtraction.deleteMany({ where: { workspaceId } }); await prisma.ingestionRun.deleteMany({ where: { workspaceId } }); await prisma.job.deleteMany({ where: { workspaceId } }); await prisma.sourceDocument.deleteMany({ where: { workspaceId } }); await prisma.source.deleteMany({ where: { workspaceId } }); await prisma.sourceBlob.deleteMany({ where: { workspaceId } }); await prisma.workspaceMember.deleteMany({ where: { workspaceId } }); await prisma.workspace.delete({ where: { id: workspaceId } }); await prisma.user.delete({ where: { id: userId } }); } });

describe("Phase 8C Checkpoint 2B permanent materialization acceptance", () => {
  it("FINGERPRINT_ACCEPTANCE binds every semantic materialization field", () => {
    const input = { workspaceId: "workspace", invocationId: "invocation", snapshotId: "snapshot", embeddingVersion: "v1", identity: { provider: "openai", model: "model", modelVersion: "slot", dimensions: 3 }, targets: [{ id: "a", extractionId: "e", contentHash: "h1" }, { id: "b", extractionId: "e", contentHash: "h2" }] };
    const baseline = embeddingConsumerFingerprint("DOCUMENT_CHUNK", input);
    expect(embeddingConsumerFingerprint("DOCUMENT_CHUNK", input)).toBe(baseline);
    const changes = [
      { ...input, workspaceId: "other" }, { ...input, invocationId: "other" }, { ...input, snapshotId: "other" }, { ...input, embeddingVersion: "v2" },
      { ...input, identity: { ...input.identity, provider: "other" } }, { ...input, identity: { ...input.identity, model: "other" } }, { ...input, identity: { ...input.identity, modelVersion: "other" } }, { ...input, identity: { ...input.identity, dimensions: 4 } },
      { ...input, targets: [{ ...input.targets[0]!, id: "other" }, input.targets[1]!] }, { ...input, targets: [input.targets[1]!, input.targets[0]!] }, { ...input, targets: [{ ...input.targets[0]!, contentHash: "other" }, input.targets[1]!] }, { ...input, targets: [input.targets[0]!] },
    ];
    for (const changed of changes) expect(embeddingConsumerFingerprint("DOCUMENT_CHUNK", changed)).not.toBe(baseline);
    expect(embeddingConsumerFingerprint("BOOK_MEMORY", input)).not.toBe(baseline);
  });

  it("DOCUMENT_CHUNK_MATERIALIZER persists ordered canonical vectors and atomically tombstones its receipt", async () => {
    const data = await lineage(), handoff = await receipt(data.workspace.id, 2);
    const targets = data.chunks.map(chunk => ({ id: chunk.id, extractionId: data.extraction.id, contentHash: chunk.contentHash }));
    await expect(materializeDocumentChunkEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "v1", targets })).resolves.toMatchObject({ status: "CONSUMED" });
    const identity = embeddingIdentityWithHash({ provider: "openai", model: capability.modelId, embeddingVersion: "v1", dimensions: 3 });
    const rows = await prisma.documentChunkEmbedding.findMany({ where: { chunkId: { in: targets.map(target => target.id) }, provider: "openai", embeddingVersion: "v1" }, orderBy: { chunkId: "asc" } });
    expect(rows).toHaveLength(2); expect(rows.map(row => row.embeddingIdentityHash)).toEqual([identity.hash, identity.hash]);
    for (const [index, target] of targets.entries()) expect((await prisma.documentChunkEmbedding.findFirstOrThrow({ where: { chunkId: target.id, embeddingIdentityHash: identity.hash } })).vector).toEqual(vectors[index]);
    const consumed = await prisma.providerEmbeddingResult.findUniqueOrThrow({ where: { invocationId: handoff.invocationId } });
    expect(consumed).toMatchObject({ consumedAt: expect.any(Date), consumerKind: "DOCUMENT_CHUNK", ciphertext: null, iv: null, authTag: null, keyVersion: null });
    await expect(materializeDocumentChunkEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "v1", targets })).resolves.toMatchObject({ status: "ALREADY_CONSUMED" });
  });

  it("BOOK_MEMORY_MATERIALIZER rejects changed lineage without writes and preserves the unconsumed receipt", async () => {
    const data = await lineage(), handoff = await receipt(data.workspace.id, 2);
    const targets = data.memories.map(item => ({ id: item.id, extractionId: data.extraction.id, analysisRunId: data.run.id, contentHash: item.contentHash }));
    const before = await prisma.bookMemoryEmbedding.count({ where: { workspaceId: data.workspace.id } });
    await expect(materializeBookMemoryEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "v1", targets: [{ ...targets[0]!, contentHash: "wrong" }, targets[1]!] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await prisma.bookMemoryEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(before);
    expect((await prisma.providerEmbeddingResult.findUniqueOrThrow({ where: { invocationId: handoff.invocationId } })).consumedAt).toBeNull();
    await expect(materializeBookMemoryEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "v1", targets })).resolves.toMatchObject({ status: "CONSUMED" });
    expect(await prisma.bookMemoryEmbedding.count({ where: { workspaceId: data.workspace.id, provider: "openai", embeddingVersion: "v1" } })).toBe(2);
  });

  it("SEC06 CROSS WORKSPACE DOCUMENT CHUNK uses the real materializer and writes no application row", async () => {
    const owner = await lineage(), foreign = await lineage(), handoff = await receipt(owner.workspace.id, 2);
    const targets = foreign.chunks.map(chunk => ({ id: chunk.id, extractionId: foreign.extraction.id, contentHash: chunk.contentHash }));
    const before = await prisma.documentChunkEmbedding.count({ where: { chunkId: { in: targets.map(target => target.id) } } });
    await expect(materializeDocumentChunkEmbeddings(handoff.repository, { workspaceId: owner.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "v1", targets })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(await prisma.documentChunkEmbedding.count({ where: { chunkId: { in: targets.map(target => target.id) } } })).toBe(before);
  });

  it("SEC07 CROSS WORKSPACE BOOK MEMORY uses the real materializer and writes no application row", async () => {
    const owner = await lineage(), foreign = await lineage(), handoff = await receipt(owner.workspace.id, 2);
    const targets = foreign.memories.map(item => ({ id: item.id, extractionId: foreign.extraction.id, analysisRunId: foreign.run.id, contentHash: item.contentHash }));
    const before = await prisma.bookMemoryEmbedding.count({ where: { memoryItemId: { in: targets.map(target => target.id) } } });
    await expect(materializeBookMemoryEmbeddings(handoff.repository, { workspaceId: owner.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "v1", targets })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(await prisma.bookMemoryEmbedding.count({ where: { memoryItemId: { in: targets.map(target => target.id) } } })).toBe(before);
  });

  it("SEC08 and SEC12 reject incorrect document extraction or content hash without a write", async () => {
    const data = await lineage(), handoff = await receipt(data.workspace.id, 2), targets = data.chunks.map(chunk => ({ id: chunk.id, extractionId: data.extraction.id, contentHash: chunk.contentHash }));
    const before = await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } });
    await expect(materializeDocumentChunkEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "v1", targets: [{ ...targets[0]!, extractionId: randomUUID() }, targets[1]!] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(before);
    await expect(materializeDocumentChunkEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "v1", targets: [{ ...targets[0]!, contentHash: "wrong" }, targets[1]!] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("SEC09 and SEC10 reject incorrect BookMemory analysis run or extraction without a write", async () => {
    const data = await lineage(), handoff = await receipt(data.workspace.id, 2), targets = data.memories.map(item => ({ id: item.id, extractionId: data.extraction.id, analysisRunId: data.run.id, contentHash: item.contentHash }));
    const before = await prisma.bookMemoryEmbedding.count({ where: { workspaceId: data.workspace.id } });
    await expect(materializeBookMemoryEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "v1", targets: [{ ...targets[0]!, analysisRunId: randomUUID() }, targets[1]!] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await prisma.bookMemoryEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(before);
    await expect(materializeBookMemoryEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "v1", targets: [{ ...targets[0]!, extractionId: randomUUID() }, targets[1]!] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("SEC13 target count mismatch is rejected by the real document materializer before any row is written", async () => {
    const data = await lineage(), handoff = await receipt(data.workspace.id, 2), target = data.chunks[0]!;
    const before = await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } });
    await expect(materializeDocumentChunkEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "v1", targets: [{ id: target.id, extractionId: data.extraction.id, contentHash: target.contentHash }] })).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    expect(await prisma.documentChunkEmbedding.count({ where: { workspaceId: data.workspace.id } })).toBe(before);
  });

  it("SEC11 changed target order conflicts with the consumed document intent and preserves ordered rows", async () => {
    const data = await lineage(), handoff = await receipt(data.workspace.id, 2), targets = data.chunks.map(chunk => ({ id: chunk.id, extractionId: data.extraction.id, contentHash: chunk.contentHash }));
    await expect(materializeDocumentChunkEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "order-v1", targets })).resolves.toMatchObject({ status: "CONSUMED" });
    await expect(materializeDocumentChunkEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "order-v1", targets: [targets[1]!, targets[0]!] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const identity = embeddingIdentityWithHash({ provider: "openai", model: capability.modelId, embeddingVersion: "order-v1", dimensions: 3 });
    await expect(Promise.all(targets.map(target => prisma.documentChunkEmbedding.findUniqueOrThrow({ where: { chunkId_embeddingIdentityHash: { chunkId: target.id, embeddingIdentityHash: identity.hash } } })))).resolves.toMatchObject([{ vector: vectors[0] }, { vector: vectors[1] }]);
  });

  it("SEC24 conflicting existing DocumentChunkEmbedding fails closed and preserves the winner", async () => {
    const data = await lineage(), handoff = await receipt(data.workspace.id, 2), targets = data.chunks.map(chunk => ({ id: chunk.id, extractionId: data.extraction.id, contentHash: chunk.contentHash }));
    const identity = embeddingIdentityWithHash({ provider: "openai", model: capability.modelId, embeddingVersion: "conflict-v1", dimensions: 3 });
    const existing = await prisma.documentChunkEmbedding.create({ data: { chunkId: targets[0]!.id, workspaceId: data.workspace.id, extractionId: data.extraction.id, provider: "openai", model: capability.modelId, embeddingVersion: "conflict-v1", embeddingIdentityHash: identity.hash, dimensions: 3, vector: [9, 9, 9] } });
    await expect(materializeDocumentChunkEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "conflict-v1", targets })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await prisma.documentChunkEmbedding.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ vector: [9, 9, 9], extractionId: data.extraction.id, embeddingIdentityHash: identity.hash });
  });

  it("SEC25 conflicting existing BookMemoryEmbedding fails closed and preserves the winner", async () => {
    const data = await lineage(), handoff = await receipt(data.workspace.id, 2), targets = data.memories.map(item => ({ id: item.id, extractionId: data.extraction.id, analysisRunId: data.run.id, contentHash: item.contentHash }));
    const identity = embeddingIdentityWithHash({ provider: "openai", model: capability.modelId, embeddingVersion: "conflict-memory-v1", dimensions: 3 });
    const existing = await prisma.bookMemoryEmbedding.create({ data: { memoryItemId: targets[0]!.id, analysisRunId: data.run.id, workspaceId: data.workspace.id, extractionId: data.extraction.id, provider: "openai", model: capability.modelId, embeddingVersion: "conflict-memory-v1", embeddingIdentityHash: identity.hash, dimensions: 3, vector: [9, 9, 9] } });
    await expect(materializeBookMemoryEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "conflict-memory-v1", targets })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await prisma.bookMemoryEmbedding.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ vector: [9, 9, 9], analysisRunId: data.run.id, embeddingIdentityHash: identity.hash });
  });

  it("DOCUMENT_CHUNK_PRODUCTION_SHAPED_E2E and NO_DOUBLE_CHARGE_GATEWAY_MATERIALIZER preserve one paid receipt across ten retries and restart", async () => {
    const data = await lineage(), handoff = await gatewayReceipt(data.workspace.id, (await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId: data.workspace.id } })).userId), targets = data.chunks.map(chunk => ({ id: chunk.id, extractionId: data.extraction.id, contentHash: chunk.contentHash }));
    expect(handoff.transport.calls).toHaveLength(1); expect(await prisma.providerUsageEvent.count({ where: { workspaceId: data.workspace.id } })).toBe(1); expect(await prisma.documentChunkEmbedding.count({ where: { chunkId: { in: targets.map(target => target.id) }, provider: "openai" } })).toBe(0);
    await expect(materializeDocumentChunkEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "paid-v1", targets })).resolves.toMatchObject({ status: "CONSUMED" });
    for (let retry = 0; retry < 10; retry++) await expect(materializeDocumentChunkEmbeddings(new ProviderExecutionRepository(prisma, testCipher()), { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "paid-v1", targets })).resolves.toMatchObject({ status: "ALREADY_CONSUMED" });
    expect(await prisma.documentChunkEmbedding.count({ where: { chunkId: { in: targets.map(target => target.id) }, embeddingVersion: "paid-v1" } })).toBe(2); expect(handoff.transport.calls).toHaveLength(1); expect(await prisma.providerInvocation.count({ where: { workspaceId: data.workspace.id } })).toBe(1); expect(await prisma.providerInvocationAttempt.count({ where: { workspaceId: data.workspace.id } })).toBe(1); expect(await prisma.providerUsageEvent.count({ where: { workspaceId: data.workspace.id } })).toBe(1);
  });

  it("SEC16 embeddingVersion conflict preserves the consumed BookMemory materialization winner", async () => {
    const data = await lineage(), handoff = await gatewayReceipt(data.workspace.id, (await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId: data.workspace.id } })).userId), targets = data.memories.map(item => ({ id: item.id, extractionId: data.extraction.id, analysisRunId: data.run.id, contentHash: item.contentHash }));
    expect(await prisma.bookMemoryEmbedding.count({ where: { memoryItemId: { in: targets.map(target => target.id) }, provider: "openai" } })).toBe(0); await expect(materializeBookMemoryEmbeddings(handoff.repository, { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "paid-memory-v1", targets })).resolves.toMatchObject({ status: "CONSUMED" });
    await expect(materializeBookMemoryEmbeddings(new ProviderExecutionRepository(prisma, testCipher()), { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "paid-memory-v1", targets })).resolves.toMatchObject({ status: "ALREADY_CONSUMED" });
    await expect(materializeBookMemoryEmbeddings(new ProviderExecutionRepository(prisma, testCipher()), { workspaceId: data.workspace.id, invocationId: handoff.invocationId, snapshotId: handoff.snapshotId, embeddingVersion: "other", targets })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await prisma.bookMemoryEmbedding.count({ where: { memoryItemId: { in: targets.map(target => target.id) }, embeddingVersion: "paid-memory-v1" } })).toBe(2); expect(handoff.transport.calls).toHaveLength(1); expect(await prisma.providerUsageEvent.count({ where: { workspaceId: data.workspace.id } })).toBe(1);
  });
});
