import { ProviderGatewayError, embeddingDimensions, type ProviderExecutionRepository } from "@ai-cognitive/provider-gateway";
import { sha256 } from "./chunking.js";
import { embeddingIdentityWithHash } from "./embeddings.js";

type Target = { id: string; extractionId: string; contentHash: string };
type DocumentInput = { workspaceId: string; invocationId: string; snapshotId: string; embeddingVersion: string; targets: readonly Target[] };
type MemoryTarget = Target & { analysisRunId: string };
type MemoryInput = { workspaceId: string; invocationId: string; snapshotId: string; embeddingVersion: string; targets: readonly MemoryTarget[] };
export type BookAnalysisEmbeddingTarget =
  | { kind: "DOCUMENT_CHUNK"; id: string; extractionId: string; contentHash: string; text: string }
  | { kind: "BOOK_MEMORY"; id: string; extractionId: string; analysisRunId: string; contentHash: string; text: string };
export type BookAnalysisEmbeddingInput = { workspaceId: string; analysisRunId: string; claimToken: string; invocationId: string; snapshotId: string; embeddingVersion: string; targets: readonly BookAnalysisEmbeddingTarget[] };
const canonical = (value: unknown) => JSON.stringify(value);
export function embeddingConsumerFingerprint(kind: string, input: { workspaceId: string; invocationId: string; snapshotId: string; embeddingVersion: string; targets: readonly (Target | MemoryTarget)[]; identity: { provider: string; model: string; modelVersion?: string; dimensions: number } }) {
  if (!input.embeddingVersion || !input.targets.length || new Set(input.targets.map(target => target.id)).size !== input.targets.length) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Invalid embedding materialization intent");
  return sha256(canonical({ workspaceId: input.workspaceId, invocationId: input.invocationId, snapshotId: input.snapshotId, kind, embeddingVersion: input.embeddingVersion, provider: input.identity.provider, model: input.identity.model, modelVersion: input.identity.modelVersion ?? "", dimensions: input.identity.dimensions, targetCount: input.targets.length, targets: input.targets.map(target => ({ id: target.id, extractionId: target.extractionId, contentHash: target.contentHash, ...("analysisRunId" in target ? { analysisRunId: target.analysisRunId } : {}) })) }));
}
function identity(snapshot: { providerKey: string; modelId: string }, embeddingVersion: string, dimensions: number) { return embeddingIdentityWithHash({ provider: snapshot.providerKey, model: snapshot.modelId, embeddingVersion, dimensions }); }
function same(a: unknown, b: unknown) { return canonical(a) === canonical(b); }

export async function materializeDocumentChunkEmbeddings(repository: ProviderExecutionRepository, input: DocumentInput) {
  const snapshot = await repository.loadExecutionSnapshot(input.workspaceId, input.snapshotId), consumerFingerprint = embeddingConsumerFingerprint("DOCUMENT_CHUNK", { ...input, identity: { provider: snapshot.providerKey, model: snapshot.modelId, dimensions: embeddingDimensions(snapshot.capability, snapshot.configuration) } }), consumerKey = input.targets.map(target => target.id).join(",");
  return repository.consumeEmbeddingResult({ ...input, consumerKind: "DOCUMENT_CHUNK", consumerKey, consumerFingerprint }, async ({ tx, vectors, snapshot, receipt }) => {
    if (vectors.length !== input.targets.length || receipt.vectorCount !== input.targets.length) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "VECTOR_COUNT_TARGET_COUNT_MISMATCH");
    const rows = await tx.documentChunk.findMany({ where: { id: { in: input.targets.map(target => target.id) }, workspaceId: input.workspaceId }, select: { id: true, workspaceId: true, extractionId: true, contentHash: true } });
    if (rows.length !== input.targets.length) throw new ProviderGatewayError("AUTHORIZATION_FAILED", "Embedding target does not belong to workspace");
    const byId = new Map(rows.map(row => [row.id, row])); const embedding = identity(snapshot, input.embeddingVersion, receipt.dimensions);
    for (const [index, target] of input.targets.entries()) {
      const row = byId.get(target.id); if (!row || row.extractionId !== target.extractionId || row.contentHash !== target.contentHash) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT", "Document chunk lineage changed");
      const vector = vectors[index]!, existing = await tx.documentChunkEmbedding.findUnique({ where: { chunkId_embeddingIdentityHash: { chunkId: target.id, embeddingIdentityHash: embedding.hash } } });
      if (existing) { if (existing.workspaceId !== input.workspaceId || existing.extractionId !== target.extractionId || existing.provider !== embedding.provider || existing.model !== embedding.model || existing.modelVersion !== null || existing.embeddingVersion !== embedding.embeddingVersion || existing.dimensions !== receipt.dimensions || !same(existing.vector, vector)) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT", "Conflicting document embedding exists"); }
      else await tx.documentChunkEmbedding.create({ data: { chunkId: target.id, workspaceId: input.workspaceId, extractionId: target.extractionId, provider: embedding.provider, model: embedding.model, embeddingVersion: embedding.embeddingVersion, embeddingIdentityHash: embedding.hash, dimensions: receipt.dimensions, vector: vector as never } });
    }
  });
}

export async function materializeBookMemoryEmbeddings(repository: ProviderExecutionRepository, input: MemoryInput) {
  const snapshot = await repository.loadExecutionSnapshot(input.workspaceId, input.snapshotId), consumerFingerprint = embeddingConsumerFingerprint("BOOK_MEMORY", { ...input, identity: { provider: snapshot.providerKey, model: snapshot.modelId, dimensions: embeddingDimensions(snapshot.capability, snapshot.configuration) } }), consumerKey = input.targets.map(target => target.id).join(",");
  return repository.consumeEmbeddingResult({ ...input, consumerKind: "BOOK_MEMORY", consumerKey, consumerFingerprint }, async ({ tx, vectors, snapshot, receipt }) => {
    if (vectors.length !== input.targets.length || receipt.vectorCount !== input.targets.length) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "VECTOR_COUNT_TARGET_COUNT_MISMATCH");
    const rows = await tx.bookMemoryItem.findMany({ where: { id: { in: input.targets.map(target => target.id) }, workspaceId: input.workspaceId }, select: { id: true, workspaceId: true, extractionId: true, analysisRunId: true, contentHash: true } });
    if (rows.length !== input.targets.length) throw new ProviderGatewayError("AUTHORIZATION_FAILED", "Embedding target does not belong to workspace");
    const byId = new Map(rows.map(row => [row.id, row])); const embedding = identity(snapshot, input.embeddingVersion, receipt.dimensions);
    for (const [index, target] of input.targets.entries()) {
      const row = byId.get(target.id); if (!row || row.extractionId !== target.extractionId || row.analysisRunId !== target.analysisRunId || row.contentHash !== target.contentHash) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT", "Book memory lineage changed");
      const vector = vectors[index]!, existing = await tx.bookMemoryEmbedding.findUnique({ where: { memoryItemId_embeddingIdentityHash: { memoryItemId: target.id, embeddingIdentityHash: embedding.hash } } });
      if (existing) { if (existing.workspaceId !== input.workspaceId || existing.extractionId !== target.extractionId || existing.analysisRunId !== target.analysisRunId || existing.provider !== embedding.provider || existing.model !== embedding.model || existing.modelVersion !== null || existing.embeddingVersion !== embedding.embeddingVersion || existing.dimensions !== receipt.dimensions || !same(existing.vector, vector)) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT", "Conflicting memory embedding exists"); }
      else await tx.bookMemoryEmbedding.create({ data: { memoryItemId: target.id, analysisRunId: target.analysisRunId, workspaceId: input.workspaceId, extractionId: target.extractionId, provider: embedding.provider, model: embedding.model, embeddingVersion: embedding.embeddingVersion, embeddingIdentityHash: embedding.hash, dimensions: receipt.dimensions, vector: vector as never } });
    }
  });
}

/**
 * Consume one gateway receipt into both book-intelligence embedding tables.  This
 * stays above provider-gateway so that the gateway never depends on book schema
 * or BookAnalysisRun ownership rules.
 */
export async function materializeBookAnalysisEmbeddings(repository: ProviderExecutionRepository, input: BookAnalysisEmbeddingInput) {
  const snapshot = await repository.loadExecutionSnapshot(input.workspaceId, input.snapshotId);
  const dimensions = embeddingDimensions(snapshot.capability, snapshot.configuration);
  const consumerFingerprint = embeddingConsumerFingerprint("BOOK_ANALYSIS_EMBEDDINGS", {
    workspaceId: input.workspaceId, invocationId: input.invocationId, snapshotId: input.snapshotId, embeddingVersion: input.embeddingVersion,
    targets: input.targets.map(target => ({ id: target.id, extractionId: target.extractionId, contentHash: target.contentHash, ...(target.kind === "BOOK_MEMORY" ? { analysisRunId: target.analysisRunId } : {}) })),
    identity: { provider: snapshot.providerKey, model: snapshot.modelId, dimensions },
  });
  return repository.consumeEmbeddingResult({ workspaceId: input.workspaceId, invocationId: input.invocationId, snapshotId: input.snapshotId, consumerKind: "BOOK_ANALYSIS_EMBEDDINGS", consumerKey: input.analysisRunId, consumerFingerprint }, async ({ tx, vectors, snapshot: pinned, receipt }) => {
    if (vectors.length !== input.targets.length || receipt.vectorCount !== input.targets.length) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "VECTOR_COUNT_TARGET_COUNT_MISMATCH");
    const owners = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "BookAnalysisRun" WHERE "id" = ${input.analysisRunId} AND "workspaceId" = ${input.workspaceId} AND "executionClaimToken" = ${input.claimToken} AND "executionLeaseUntil" > NOW() AND "status" = 'RUNNING'::"AnalysisRunStatus" AND "analysisStage" = 'EMBEDDINGS'::"AnalysisRunStage" FOR UPDATE`;
    if (owners.length !== 1) throw new Error("BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST");
    const chunkTargets = input.targets.filter((target): target is Extract<BookAnalysisEmbeddingTarget, { kind: "DOCUMENT_CHUNK" }> => target.kind === "DOCUMENT_CHUNK");
    const memoryTargets = input.targets.filter((target): target is Extract<BookAnalysisEmbeddingTarget, { kind: "BOOK_MEMORY" }> => target.kind === "BOOK_MEMORY");
    const [chunks, memories] = await Promise.all([
      tx.documentChunk.findMany({ where: { id: { in: chunkTargets.map(target => target.id) }, workspaceId: input.workspaceId }, select: { id: true, extractionId: true, contentHash: true } }),
      tx.bookMemoryItem.findMany({ where: { id: { in: memoryTargets.map(target => target.id) }, workspaceId: input.workspaceId }, select: { id: true, extractionId: true, analysisRunId: true, contentHash: true } }),
    ]);
    if (chunks.length !== chunkTargets.length || memories.length !== memoryTargets.length) throw new ProviderGatewayError("AUTHORIZATION_FAILED", "Embedding target does not belong to workspace");
    const byChunk = new Map(chunks.map(row => [row.id, row])); const byMemory = new Map(memories.map(row => [row.id, row])); const embedded = identity(pinned, input.embeddingVersion, receipt.dimensions);
    for (const [index, target] of input.targets.entries()) {
      const vector = vectors[index]!;
      if (target.kind === "DOCUMENT_CHUNK") {
        const row = byChunk.get(target.id); if (!row || row.extractionId !== target.extractionId || row.contentHash !== target.contentHash) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT", "Document chunk lineage changed");
        const existing = await tx.documentChunkEmbedding.findUnique({ where: { chunkId_embeddingIdentityHash: { chunkId: target.id, embeddingIdentityHash: embedded.hash } } });
        if (existing) { if (existing.workspaceId !== input.workspaceId || existing.extractionId !== target.extractionId || existing.provider !== embedded.provider || existing.model !== embedded.model || existing.modelVersion !== null || existing.embeddingVersion !== embedded.embeddingVersion || existing.dimensions !== receipt.dimensions || !same(existing.vector, vector)) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT", "Conflicting document embedding exists"); }
        else await tx.documentChunkEmbedding.create({ data: { chunkId: target.id, workspaceId: input.workspaceId, extractionId: target.extractionId, provider: embedded.provider, model: embedded.model, embeddingVersion: embedded.embeddingVersion, embeddingIdentityHash: embedded.hash, dimensions: receipt.dimensions, vector: vector as never } });
      } else {
        const row = byMemory.get(target.id); if (!row || row.extractionId !== target.extractionId || row.analysisRunId !== input.analysisRunId || row.contentHash !== target.contentHash || target.analysisRunId !== input.analysisRunId) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT", "Book memory lineage changed");
        const existing = await tx.bookMemoryEmbedding.findUnique({ where: { memoryItemId_embeddingIdentityHash: { memoryItemId: target.id, embeddingIdentityHash: embedded.hash } } });
        if (existing) { if (existing.workspaceId !== input.workspaceId || existing.extractionId !== target.extractionId || existing.analysisRunId !== input.analysisRunId || existing.provider !== embedded.provider || existing.model !== embedded.model || existing.modelVersion !== null || existing.embeddingVersion !== embedded.embeddingVersion || existing.dimensions !== receipt.dimensions || !same(existing.vector, vector)) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT", "Conflicting memory embedding exists"); }
        else await tx.bookMemoryEmbedding.create({ data: { memoryItemId: target.id, analysisRunId: input.analysisRunId, workspaceId: input.workspaceId, extractionId: target.extractionId, provider: embedded.provider, model: embedded.model, embeddingVersion: embedded.embeddingVersion, embeddingIdentityHash: embedded.hash, dimensions: receipt.dimensions, vector: vector as never } });
      }
    }
  });
}
