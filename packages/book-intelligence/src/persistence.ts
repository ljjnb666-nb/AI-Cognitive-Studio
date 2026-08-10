import { prisma } from "../../db/src/index.js";
import { logger } from "@ai-cognitive/shared";
import { CHUNKING_VERSION, buildStructure, chunkBlocks, sha256, validateEvidence, type ChunkingOptions, type SourceBlockInput } from "./chunking.js";

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const defaults: ChunkingOptions = { targetSize: 1200, hardMax: 1600 };
export type MaterializeChunkSetInput = { workspaceId: string; sourceDocumentId: string; configuration?: Partial<ChunkingOptions>; correlationId?: string };

export async function materializeChunkSet(input: MaterializeChunkSetInput) {
  const configuration = { ...defaults, ...input.configuration }, configurationHash = sha256(stable(configuration));
  const document = await prisma.sourceDocument.findFirstOrThrow({ where: { id: input.sourceDocumentId, workspaceId: input.workspaceId } });
  const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: input.workspaceId } }, include: { extraction: true } });
  if (current.extraction.status !== "SUCCEEDED") throw new Error("CURRENT_EXTRACTION_NOT_SUCCEEDED");
  let chunkSet = await prisma.chunkSet.findUnique({ where: { extractionId_chunkingVersion_configurationHash: { extractionId: current.extractionId, chunkingVersion: CHUNKING_VERSION, configurationHash } } });
  if (!chunkSet) {
    try { chunkSet = await prisma.chunkSet.create({ data: { workspaceId: input.workspaceId, sourceDocumentId: document.id, extractionId: current.extractionId, chunkingVersion: CHUNKING_VERSION, configuration, configurationHash, status: "QUEUED" } }); }
    catch { chunkSet = await prisma.chunkSet.findUniqueOrThrow({ where: { extractionId_chunkingVersion_configurationHash: { extractionId: current.extractionId, chunkingVersion: CHUNKING_VERSION, configurationHash } } }); }
  }
  if (chunkSet.status === "SUCCEEDED") return chunkSet;
  if (chunkSet.status === "RUNNING") throw new Error("CHUNK_SET_MATERIALIZATION_IN_PROGRESS");
  await prisma.chunkSet.update({ where: { id: chunkSet.id }, data: { status: "RUNNING", errorCode: null, completedAt: null } });
  const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: current.extractionId }, include: { sourcePage: true }, orderBy: { ordinal: "asc" } });
  const inputs: SourceBlockInput[] = blocks.map((b) => ({ id: b.id, ordinal: b.ordinal, text: b.text, kind: b.kind, pageOrdinal: b.sourcePage?.ordinal, metadata: b.metadata as { headingLevel?: unknown } | undefined }));
  try {
    const structure = buildStructure(inputs), chunks = chunkBlocks(inputs, configuration);
    if (blocks.length && !chunks.length) throw new Error("CHUNKING_EMPTY_SOURCE");
    for (const chunk of chunks) {
      if (!chunk.content || chunk.content.length > configuration.hardMax || chunk.contentHash !== sha256(chunk.content) || chunk.characterCount !== chunk.content.length || chunk.tokenEstimate !== Math.ceil(chunk.content.length / 4)) throw new Error("CHUNKING_INVARIANT_FAILED");
      const reconstructed = chunk.sourceSpans.map((span) => { const block = inputs.find((item) => item.id === span.sourceBlockId); if (!block || !validateEvidence(block, span)) throw new Error("INVALID_CHUNK_PROVENANCE"); return block.text.slice(span.startOffset, span.endOffset); }).join("\n\n");
      if (reconstructed !== chunk.content || chunk.sourceSpans.some((span, ordinal) => span.ordinal !== ordinal)) throw new Error("CHUNK_PROVENANCE_RECONSTRUCTION_FAILED");
    }
    await prisma.$transaction(async (tx) => {
      const existing = await tx.documentStructureNode.findMany({ where: { extractionId: current.extractionId }, orderBy: { ordinal: "asc" } });
      const nodeIds = new Map<number, string>();
      if (existing.length) existing.forEach((node) => nodeIds.set(node.ordinal, node.id));
      else for (const node of structure) { const parentId = node.parentOrdinal === undefined ? null : nodeIds.get(node.parentOrdinal) ?? null; const created = await tx.documentStructureNode.create({ data: { extractionId: current.extractionId, parentId, ordinal: node.ordinal, kind: node.kind, title: node.title, startBlockOrdinal: node.startBlockOrdinal, endBlockOrdinal: node.endBlockOrdinal, metadata: { effectiveDepth: node.effectiveDepth } } }); nodeIds.set(node.ordinal, created.id); }
      for (const chunk of chunks) {
        const spanBlocks = chunk.sourceSpans.map((span) => blocks.find((block) => block.id === span.sourceBlockId)!); const first = spanBlocks[0]!, last = spanBlocks.at(-1)!;
        const structureNode = structure.filter((node) => node.ordinal !== 0 && node.startBlockOrdinal <= first.ordinal && node.endBlockOrdinal >= last.ordinal).sort((a,b)=>b.effectiveDepth-a.effectiveDepth)[0];
        const headingPath = structure.filter((node) => node.ordinal !== 0 && node.startBlockOrdinal <= first.ordinal && node.endBlockOrdinal >= first.ordinal).sort((a,b)=>a.effectiveDepth-b.effectiveDepth).map((node)=>node.title).filter((title): title is string => typeof title === "string");
        const created = await tx.documentChunk.create({ data: { workspaceId: input.workspaceId, extractionId: current.extractionId, chunkSetId: chunkSet.id, structureNodeId: structureNode ? nodeIds.get(structureNode.ordinal) : undefined, ordinal: chunk.ordinal, content: chunk.content, contentHash: chunk.contentHash, characterCount: chunk.characterCount, tokenEstimate: chunk.tokenEstimate, metadata: { headingPath, pageRange: [first.sourcePage?.ordinal ?? null, last.sourcePage?.ordinal ?? null], blockOrdinalRange: [first.ordinal, last.ordinal] } } });
        await tx.chunkSourceSpan.createMany({ data: chunk.sourceSpans.map((span) => ({ chunkId: created.id, sourceBlockId: span.sourceBlockId, extractionId: current.extractionId, ordinal: span.ordinal, startOffset: span.startOffset, endOffset: span.endOffset })) });
      }
      await tx.chunkSet.update({ where: { id: chunkSet.id }, data: { status: "SUCCEEDED", completedAt: new Date(), errorCode: null } });
    });
    logger.info("book.chunk_set.materialized", { workspaceId: input.workspaceId, sourceDocumentId: input.sourceDocumentId, extractionId: current.extractionId, chunkSetId: chunkSet.id, correlationId: input.correlationId });
    return prisma.chunkSet.findUniqueOrThrow({ where: { id: chunkSet.id } });
  } catch (error) { const errorCode = error instanceof Error ? error.message.split(":")[0] : "CHUNK_SET_FAILED"; await prisma.chunkSet.update({ where: { id: chunkSet.id }, data: { status: "FAILED", errorCode, completedAt: new Date() } }); logger.error("book.chunk_set.failed", { workspaceId: input.workspaceId, sourceDocumentId: input.sourceDocumentId, chunkSetId: chunkSet.id, errorCode }); throw error; }
}
