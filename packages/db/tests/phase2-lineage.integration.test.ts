import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/index.js";

const workspaceIds: string[] = [];

async function createLineage(workspaceId: string, suffix: string) {
  const source = await prisma.source.create({ data: { workspaceId, kind: "FILE", displayName: `${suffix}.txt` } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId, sha256: `sha-${suffix}`, sizeBytes: 1, mediaType: "text/plain", storageKey: `lineage/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: blob.sha256, sizeBytes: 1, mediaType: "text/plain", storageKey: blob.storageKey } });
  const ingestionJob = await prisma.job.create({ data: { workspaceId, type: "source.ingest", payload: {}, idempotencyKey: `ingest-${suffix}` } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId, sourceDocumentId: document.id, jobId: ingestionJob.id, parserVersion: "test", normalizationVersion: "test" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } });
  const block = await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal: 0, kind: "PARAGRAPH", text: suffix, contentHash: `block-${suffix}` } });
  const node = await prisma.documentStructureNode.create({ data: { extractionId: extraction.id, structureVersion: "v1", ordinal: 0, kind: "SECTION", title: suffix, startBlockOrdinal: 0, endBlockOrdinal: 0 } });
  const chunkSet = await prisma.chunkSet.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "v1", configuration: {}, configurationHash: `config-${suffix}`, status: "SUCCEEDED" } });
  const chunk = await prisma.documentChunk.create({ data: { workspaceId, chunkSetId: chunkSet.id, extractionId: extraction.id, structureNodeId: node.id, structureVersion: node.structureVersion, ordinal: 0, content: suffix, contentHash: `chunk-${suffix}`, characterCount: suffix.length, tokenEstimate: 1 } });
  const analysisJob = await prisma.job.create({ data: { workspaceId, type: "book.analysis", payload: {}, idempotencyKey: `analysis-job-${suffix}` } });
  const run = await prisma.bookAnalysisRun.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunkSet.id, jobId: analysisJob.id, pipelineVersion: "v1", promptVersion: "v1", provider: "test", model: "test", modelVersionKey: "", idempotencyKey: `analysis-${suffix}`, analysisIdentityHash: `identity-${suffix}` } });
  const artifact = await prisma.analysisArtifact.create({ data: { analysisRunId: run.id, workspaceId, chunkSetId: chunkSet.id, extractionId: extraction.id, chunkId: chunk.id, scope: "CHUNK", ordinal: 0, summary: suffix, structuredOutput: { summary: suffix } } });
  const memory = await prisma.bookMemoryItem.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, analysisRunId: run.id, sourceArtifactId: artifact.id, memoryKey: `memory-${suffix}`, type: "CLAIM", ordinal: 0, content: suffix, contentHash: `memory-hash-${suffix}` } });
  return { document, extraction, block, node, chunkSet, chunk, run, artifact, memory };
}

afterEach(async () => {
  for (const workspaceId of workspaceIds.splice(0)) {
    await prisma.bookAnalysisRun.deleteMany({ where: { workspaceId } });
    await prisma.chunkSet.deleteMany({ where: { workspaceId } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId } });
    await prisma.job.deleteMany({ where: { workspaceId } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId } });
    await prisma.source.deleteMany({ where: { workspaceId } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
});
afterAll(() => prisma.$disconnect());

describe("Phase 2 database lineage constraints", () => {
  it("rejects every cross-lineage graph claimed as database-enforced", async () => {
    const workspace = await prisma.workspace.create({ data: { name: `lineage-${crypto.randomUUID()}` } });
    workspaceIds.push(workspace.id);
    const a = await createLineage(workspace.id, `a-${crypto.randomUUID()}`), b = await createLineage(workspace.id, `b-${crypto.randomUUID()}`);

    await expect(prisma.documentStructureNode.create({ data: { extractionId: a.extraction.id, structureVersion: "v1", parentId: b.node.id, ordinal: 10, kind: "SECTION", startBlockOrdinal: 0, endBlockOrdinal: 0 } })).rejects.toMatchObject({ code: "P2003" });
    const versionTwo = await prisma.documentStructureNode.create({ data: { extractionId: a.extraction.id, structureVersion: "v2", ordinal: 11, kind: "ROOT", startBlockOrdinal: 0, endBlockOrdinal: 0 } });
    await expect(prisma.documentStructureNode.create({ data: { extractionId: a.extraction.id, structureVersion: "v1", parentId: versionTwo.id, ordinal: 12, kind: "SECTION", startBlockOrdinal: 0, endBlockOrdinal: 0 } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.documentChunk.create({ data: { workspaceId: workspace.id, chunkSetId: a.chunkSet.id, extractionId: a.extraction.id, structureNodeId: b.node.id, structureVersion: b.node.structureVersion, ordinal: 20, content: "bad", contentHash: "bad-structure", characterCount: 3, tokenEstimate: 1 } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.chunkSourceSpan.create({ data: { chunkId: a.chunk.id, sourceBlockId: b.block.id, extractionId: a.extraction.id, ordinal: 0, startOffset: 0, endOffset: 1 } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.analysisArtifact.create({ data: { analysisRunId: a.run.id, workspaceId: workspace.id, chunkSetId: a.chunkSet.id, extractionId: a.extraction.id, chunkId: b.chunk.id, scope: "CHUNK", ordinal: 20, structuredOutput: {} } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.analysisArtifact.create({ data: { analysisRunId: a.run.id, workspaceId: workspace.id, chunkSetId: a.chunkSet.id, extractionId: a.extraction.id, parentId: b.artifact.id, scope: "BOOK", ordinal: 30, structuredOutput: {} } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.analysisArtifact.create({ data: { analysisRunId: a.run.id, workspaceId: workspace.id, chunkSetId: a.chunkSet.id, extractionId: a.extraction.id, structureNodeId: b.node.id, structureVersion: b.node.structureVersion, scope: "SECTION", ordinal: 40, structuredOutput: {} } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.analysisArtifact.create({ data: { analysisRunId: a.run.id, workspaceId: workspace.id, chunkSetId: a.chunkSet.id, extractionId: a.extraction.id, structureNodeId: b.node.id, structureVersion: b.node.structureVersion, scope: "CHAPTER", ordinal: 41, structuredOutput: {} } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.bookMemoryItem.create({ data: { workspaceId: workspace.id, sourceDocumentId: a.document.id, extractionId: a.extraction.id, analysisRunId: a.run.id, sourceArtifactId: b.artifact.id, memoryKey: `wrong-source-${crypto.randomUUID()}`, type: "CLAIM", ordinal: 10, content: "bad", contentHash: "bad-source" } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.bookMemoryEvidence.create({ data: { memoryItemId: a.memory.id, sourceBlockId: b.block.id, extractionId: a.extraction.id, analysisRunId: a.run.id, workspaceId: workspace.id, startOffset: 0, endOffset: 1 } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.bookMemoryRelation.create({ data: { workspaceId: workspace.id, analysisRunId: a.run.id, fromMemoryItemId: a.memory.id, toMemoryItemId: b.memory.id, type: "SUPPORTS" } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.currentBookIntelligence.create({ data: { workspaceId: workspace.id, sourceDocumentId: a.document.id, extractionId: a.extraction.id, chunkSetId: a.chunkSet.id, analysisRunId: b.run.id } })).rejects.toMatchObject({ code: "P2003" });
  });
});
