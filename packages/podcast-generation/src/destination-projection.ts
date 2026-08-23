/* eslint-disable @typescript-eslint/no-explicit-any */
import { estimateSpokenDurationMs } from "./duration.js";
const stableScore = (value: number) => Number(value.toPrecision(15));

/**
 * These projections are the durable consumer contract.  They intentionally
 * contain only deterministic fields: IDs/lineage and database state, never
 * creation timestamps or the value of `humanizedAt`.
 */
const evidence = (value: any) => ({
  sourceDocumentId: value.sourceDocumentId,
  extractionId: value.extractionId,
  chunkSetId: value.chunkSetId,
  analysisRunId: value.analysisRunId,
  memoryItemId: value.memoryItemId,
  sourceBlockId: value.sourceBlockId,
  startOffset: value.startOffset,
  endOffset: value.endOffset,
  quoteText: value.quoteText ?? null,
  quoteHash: value.quoteHash ?? null,
});

export const buildPlanningDestinationProjection = (run: any, plan: any, context: any[]) => ({
  owner: { workspaceId: run.workspaceId, podcastGenerationRunId: run.id, episodeId: run.episodeId },
  plan: { centralQuestion: plan.centralQuestion, listenerStartingPoint: plan.listenerStartingPoint, listenerTakeaway: plan.listenerTakeaway, coreThesis: plan.coreThesis, tensions: plan.tensions, surprisingIdeas: plan.surprisingIdeas, misconceptions: plan.misconceptions, keyConcepts: plan.keyConcepts, candidateStories: plan.candidateStories, candidateExamples: plan.candidateExamples, openQuestions: plan.openQuestions },
  context: context.map((item) => ({ sourceDocumentId: item.sourceDocumentId, extractionId: item.extractionId, chunkSetId: item.chunkSetId, analysisRunId: item.analysisRunId, memoryItemId: item.memoryItemId, artifactId: item.artifactId, chunkId: item.chunkId ?? null, score: stableScore(item.score), selectionReason: item.selectionReason, tokenEstimate: item.tokenEstimate, evidenceSpans: item.evidenceSpans ?? item.sourceBlockEvidenceSpans })).sort((a, b) => a.tokenEstimate - b.tokenEstimate || a.memoryItemId.localeCompare(b.memoryItemId)),
});

export const buildNarrativeDestinationProjection = (run: any, narrative: any) => ({
  owner: { workspaceId: run.workspaceId, podcastGenerationRunId: run.id, episodeId: run.episodeId },
  narrative: { arcType: narrative.arcType, intellectualProgression: narrative.intellectualProgression, openingMove: narrative.openingMove, closingMove: narrative.closingMove },
});

export const buildOutlineDestinationProjection = (run: any, segments: any[]) => ({
  owner: { workspaceId: run.workspaceId, podcastGenerationRunId: run.id, podcastProjectId: run.podcastProjectId, episodeId: run.episodeId },
  segments: segments.map((segment) => ({ workspaceId: segment.workspaceId ?? run.workspaceId, podcastGenerationRunId: segment.podcastGenerationRunId ?? run.id, podcastProjectId: segment.podcastProjectId ?? run.podcastProjectId, episodeId: segment.episodeId ?? run.episodeId, ordinal: segment.ordinal, purpose: segment.purpose, internalLabel: segment.internalLabel, targetDurationSeconds: segment.targetDurationSeconds, narrativeFunction: segment.narrativeFunction, keyQuestions: segment.keyQuestions, requiredMemoryIds: segment.requiredMemoryIds, optionalMemoryIds: segment.optionalMemoryIds, disagreementReason: segment.disagreementReason ?? null, status: segment.status ?? "PLANNED" })),
});

export const buildDraftDestinationProjection = (run: any, segment: any, utterances: any[]) => ({
  owner: { workspaceId: run.workspaceId, podcastGenerationRunId: run.id, podcastProjectId: run.podcastProjectId, episodeId: run.episodeId, segmentId: segment.id },
  segment: { ordinal: segment.ordinal, status: segment.status ?? "DRAFTED" },
  utterances: utterances.map((item) => ({ ordinal: item.ordinal, speakerHostId: item.speakerHostId, draftText: item.draftText ?? item.text, utteranceType: item.utteranceType, substantive: item.substantive, isDirectQuote: item.isDirectQuote, estimatedDurationMs: item.estimatedDurationMs ?? estimateSpokenDurationMs(item.draftText ?? item.text), evidence: (item.evidence ?? []).map(evidence) })),
});

export const buildHumanizationDestinationProjection = (run: any, segment: any, utterances: any[]) => ({
  owner: { workspaceId: run.workspaceId, podcastGenerationRunId: run.id, podcastProjectId: run.podcastProjectId, episodeId: run.episodeId, segmentId: segment.id },
  segment: { ordinal: segment.ordinal, status: segment.status ?? "HUMANIZED" },
  utterances: utterances.map((item) => ({ ordinal: item.ordinal, speakerHostId: item.speakerHostId, draftText: item.draftText, text: item.text, utteranceType: item.utteranceType, substantive: item.substantive, isDirectQuote: item.isDirectQuote, estimatedDurationMs: item.estimatedDurationMs, humanizedAtPresent: Boolean(item.humanizedAt), evidence: (item.evidence ?? []).map(evidence) })),
});

export const completeEvidenceProjection = (items: any[]) => items.map(evidence);
