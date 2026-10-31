import { createHash } from "node:crypto";
import { prisma, type Prisma } from "@ai-cognitive/db";
import { z } from "zod";
import { canonicalJson } from "./consumer-fingerprint.js";
import { estimateSpokenDurationMs } from "./duration.js";
import { evaluatePodcastScriptData } from "./evaluation.js";
import { utteranceTypeSchema } from "./types.js";
import type { TrustedRequestContext } from "./services.js";

const nonEmpty = z.string().min(1).max(256);
const editSchema = z.object({ episodeId: nonEmpty, expectedRevisionId: nonEmpty, edits: z.array(z.object({
  utteranceId: nonEmpty, text: z.string().min(1).max(4000).refine(text => Boolean(text.trim())),
  evidenceMemoryIds: z.array(nonEmpty).max(20),
}).strict()).min(2).max(200) }).strict();
const snapshotSchema = z.object({
  episode: z.object({ id: nonEmpty }).passthrough(), generation: z.object({ runId: nonEmpty }).passthrough(),
  utterances: z.array(z.object({ id: nonEmpty, segmentId: nonEmpty, speakerHostId: nonEmpty, ordinal: z.number().int().positive(), text: z.string(), utteranceType: utteranceTypeSchema, substantive: z.boolean(), evidenceMemoryIds: z.array(nonEmpty).optional() }).passthrough()).min(2).max(200),
  segments: z.array(z.object({ id: nonEmpty }).passthrough()),
}).passthrough();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Creates an attributed editorial child. Provider receipts and generated rows stay immutable. */
export async function createEditedPodcastScriptRevision(context: TrustedRequestContext, rawInput: z.input<typeof editSchema>) {
  const parsed = editSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error("PODCAST_USER_EDIT_INVALID");
  const input = { ...parsed.data, edits: parsed.data.edits.map(edit => ({ ...edit, evidenceMemoryIds: [...edit.evidenceMemoryIds].sort() })) };
  if (new Set(input.edits.map(edit => edit.utteranceId)).size !== input.edits.length || input.edits.some(edit => new Set(edit.evidenceMemoryIds).size !== edit.evidenceMemoryIds.length)) throw new Error("PODCAST_USER_EDIT_INVALID");
  const requestHash = sha(canonicalJson({ parent: input.expectedRevisionId, edits: [...input.edits].sort((a, b) => a.utteranceId.localeCompare(b.utteranceId)) }));
  return prisma.$transaction(async tx => {
    const members = await tx.$queryRaw<Array<{ role: string }>>`SELECT "role" FROM "WorkspaceMember" WHERE "workspaceId" = ${context.workspaceId} AND "userId" = ${context.userId} FOR SHARE`;
    if (members.length !== 1 || !["OWNER", "EDITOR"].includes(members[0]!.role)) throw new Error("WORKSPACE_ACCESS_DENIED");
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "PodcastEpisode" WHERE "id" = ${input.episodeId} AND "workspaceId" = ${context.workspaceId} FOR UPDATE`;
    if (locked.length !== 1) throw new Error("PODCAST_EPISODE_ACCESS_DENIED");
    const current = await tx.currentPodcastScript.findFirstOrThrow({ where: { episodeId: input.episodeId, workspaceId: context.workspaceId }, include: { revision: true } });
    if (current.revisionId !== input.expectedRevisionId) {
      const existing = current.revision.scriptSnapshot as { editorialEdit?: { requestHash?: string } };
      if (current.revision.source === "USER_EDIT" && current.revision.parentRevisionId === input.expectedRevisionId && existing.editorialEdit?.requestHash === requestHash) return { revision: current.revision, created: false };
      throw new Error("PODCAST_SCRIPT_REVISION_STALE");
    }
    const parent = snapshotSchema.safeParse(current.revision.scriptSnapshot);
    if (!parent.success || parent.data.episode.id !== input.episodeId || parent.data.utterances.length !== input.edits.length) throw new Error("PODCAST_USER_EDIT_PARENT_INVALID");
    const edits = new Map(input.edits.map(edit => [edit.utteranceId, edit]));
    if (parent.data.utterances.some(utterance => !edits.has(utterance.id))) throw new Error("PODCAST_USER_EDIT_INVALID");

    let origin = current.revision;
    const visited = new Set<string>();
    while (origin.source === "USER_EDIT") {
      if (!origin.parentRevisionId || visited.has(origin.id) || visited.size >= 64) throw new Error("PODCAST_USER_EDIT_PARENT_INVALID");
      visited.add(origin.id);
      origin = await tx.podcastScriptRevision.findFirstOrThrow({ where: { id: origin.parentRevisionId, workspaceId: context.workspaceId, episodeId: input.episodeId } });
    }
    if (!origin.generationRunId || parent.data.generation.runId !== origin.generationRunId) throw new Error("PODCAST_USER_EDIT_PARENT_INVALID");
    const run = await tx.podcastGenerationRun.findFirstOrThrow({ where: { id: origin.generationRunId, workspaceId: context.workspaceId, episodeId: input.episodeId, status: "SUCCEEDED" }, include: { sources: true, styleProfile: true } });
    const originals = await tx.podcastUtterance.findMany({ where: { id: { in: parent.data.utterances.map(item => item.id) }, podcastGenerationRunId: run.id }, select: { id: true, isDirectQuote: true } });
    if (originals.length !== parent.data.utterances.length) throw new Error("PODCAST_USER_EDIT_PARENT_INVALID");
    const quoteFlags = new Map(originals.map(item => [item.id, item.isDirectQuote]));
    const memoryIds = [...new Set(input.edits.flatMap(edit => edit.evidenceMemoryIds))];
    const memories = await tx.bookMemoryItem.findMany({ where: { id: { in: memoryIds }, workspaceId: context.workspaceId, analysisRunId: { in: run.sources.map(source => source.analysisRunId) } }, include: { analysisRun: { select: { chunkSetId: true, status: true } }, evidence: { orderBy: { id: "asc" }, include: { sourceBlock: true } } } });
    if (memories.length !== memoryIds.length) throw new Error("PODCAST_USER_EDIT_EVIDENCE_INVALID");
    const memoryById = new Map(memories.map(memory => [memory.id, memory]));
    const utterances = parent.data.utterances.map(utterance => {
      const edit = edits.get(utterance.id)!;
      if (utterance.substantive && !edit.evidenceMemoryIds.length) throw new Error("PODCAST_EVIDENCE_REQUIRED");
      const isDirectQuote = quoteFlags.get(utterance.id)!;
      const evidence = edit.evidenceMemoryIds.flatMap(id => {
        const memory = memoryById.get(id)!;
        const source = run.sources.find(source => source.sourceDocumentId === memory.sourceDocumentId && source.extractionId === memory.extractionId && source.chunkSetId === memory.analysisRun.chunkSetId && source.analysisRunId === memory.analysisRunId);
        if (!source || memory.analysisRun.status !== "SUCCEEDED" || !memory.evidence.length) throw new Error("PODCAST_USER_EDIT_EVIDENCE_INVALID");
        const selected = isDirectQuote ? memory.evidence.filter(item => item.quoteText && edit.text.includes(item.quoteText)) : memory.evidence;
        if (!selected.length) throw new Error("PODCAST_DIRECT_QUOTE_LINEAGE_INVALID");
        return selected.map(item => {
          const exact = item.sourceBlock.text.slice(item.startOffset, item.endOffset);
          if (item.sourceBlock.extractionId !== memory.extractionId || item.startOffset < 0 || item.endOffset <= item.startOffset || item.endOffset > item.sourceBlock.text.length || item.quoteText !== null && item.quoteText !== exact || item.quoteText !== null && item.quoteHash !== null && item.quoteHash !== sha(exact)) throw new Error("PODCAST_EVIDENCE_SPAN_LINEAGE_INVALID");
          return { provenanceKind: "STORED_BOOK_MEMORY_EVIDENCE", bookMemoryEvidenceId: item.id, memoryItemId: memory.id, sourceDocumentId: memory.sourceDocumentId, extractionId: memory.extractionId, chunkSetId: source.chunkSetId, analysisRunId: memory.analysisRunId, sourceBlockId: item.sourceBlockId, startOffset: item.startOffset, endOffset: item.endOffset, quoteText: item.quoteText, quoteHash: item.quoteHash };
        });
      });
      return { ...utterance, text: edit.text, isDirectQuote, estimatedDurationMs: estimateSpokenDurationMs(edit.text), evidence, evidenceCount: evidence.length, evidenceMemoryIds: edit.evidenceMemoryIds };
    });
    const sourceTexts = (await tx.sourceBlock.findMany({ where: { extractionId: { in: run.sources.map(source => source.extractionId) } }, select: { text: true } })).map(block => block.text);
    const evaluation = evaluatePodcastScriptData(utterances, { sourceTexts, contextWithinBudget: true, style: run.styleProfile });
    if (evaluation.hardFailures.length) throw new Error("PODCAST_USER_EDIT_QUALITY_INVALID");
    if (parent.data.utterances.every(utterance => {
      const edit = edits.get(utterance.id)!;
      return utterance.text === edit.text && canonicalJson([...(utterance.evidenceMemoryIds ?? [])].sort()) === canonicalJson(edit.evidenceMemoryIds);
    })) return { revision: current.revision, created: false };
    const estimatedDurationSeconds = Math.max(1, Math.ceil(utterances.reduce((sum, utterance) => sum + utterance.estimatedDurationMs, 0) / 1000));
    const snapshot = { ...parent.data, utterances, segments: parent.data.segments.map(segment => ({ ...segment, estimatedDurationSeconds: Math.max(1, Math.ceil(utterances.filter(utterance => utterance.segmentId === segment.id).reduce((sum, utterance) => sum + utterance.estimatedDurationMs, 0) / 1000)) })), editorialEdit: { source: "USER_EDIT", parentRevisionId: current.revisionId, editedByUserId: context.userId, requestHash, policyVersion: "grounded-user-edit-v1" } };
    const maximum = await tx.podcastScriptRevision.aggregate({ where: { episodeId: input.episodeId }, _max: { revisionNumber: true } });
    const revision = await tx.podcastScriptRevision.create({ data: { workspaceId: context.workspaceId, episodeId: input.episodeId, revisionNumber: (maximum._max.revisionNumber ?? 0) + 1, parentRevisionId: current.revisionId, source: "USER_EDIT", status: "FINAL", createdByUserId: context.userId, estimatedDurationSeconds, scriptSnapshot: snapshot as Prisma.InputJsonValue } });
    const evaluationRun = await tx.podcastEvaluationRun.create({ data: { workspaceId: context.workspaceId, episodeId: input.episodeId, revisionId: revision.id, evaluatorVersion: "user-edit-grounding-v1", status: "SUCCEEDED", completedAt: new Date() } });
    await tx.podcastEvaluationResult.create({ data: { evaluationRunId: evaluationRun.id, ...evaluation } });
    await tx.podcastScriptRevision.update({ where: { id: current.revisionId }, data: { status: "SUPERSEDED" } });
    await tx.currentPodcastScript.update({ where: { episodeId: input.episodeId }, data: { revisionId: revision.id } });
    return { revision, created: true };
  });
}
