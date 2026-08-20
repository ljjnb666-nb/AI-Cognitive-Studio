import { ProviderGatewayError, embeddingDimensions, type ProviderExecutionRepository } from "@ai-cognitive/provider-gateway";
import { sha256 } from "./chunking.js";
import { embeddingIdentityWithHash } from "./embeddings.js";

type Target = { id: string; extractionId: string; contentHash: string };
type DocumentInput = { workspaceId: string; invocationId: string; snapshotId: string; embeddingVersion: string; targets: readonly Target[] };
type MemoryTarget = Target & { analysisRunId: string };
type MemoryInput = { workspaceId: string; invocationId: string; snapshotId: string; embeddingVersion: string; targets: readonly MemoryTarget[] };
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
