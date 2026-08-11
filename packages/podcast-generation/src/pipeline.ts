/* Prisma rows are deliberately structurally typed at this orchestration boundary. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { buildBookContextForIntelligence, estimateAnalysisTokens, type EmbeddingProvider } from "@ai-cognitive/book-intelligence";
import { dispatchPendingOutbox } from "@ai-cognitive/ingestion";
import { logger } from "@ai-cognitive/shared";
import { estimateSpokenDurationMs } from "./duration.js";
import { evaluatePodcastScriptData } from "./evaluation.js";
import { advancePodcastStage, claimPodcastGenerationRun, failOwnedPodcastGeneration, PODCAST_GENERATION_OWNERSHIP_LOST, renewPodcastGenerationLease, withOwnedPodcastTransaction } from "./ownership.js";
import { dialogueSchema, episodePlanSchema, humanizationSchema, narrativeSchema, segmentOutlineSchema, type DialogueOutput, type EpisodePlanOutput, type NarrativeOutput, type PodcastContextItem, type PodcastGenerationProvider, type PodcastHostPersona, type SegmentOutlineOutput } from "./types.js";
import { PODCAST_GENERATION_JOB, PODCAST_GENERATION_TOPIC } from "./services.js";
import { assertPodcastProviderInputBudget, PODCAST_PROVIDER_INPUT_BUDGETS } from "./provider-budget.js";
import { podcastHostPersonaSchema, podcastStyleSchema } from "./types.js";

const PLANNING_CONTEXT_BUDGET = 4_000;
const SEGMENT_CONTEXT_BUDGET = 2_400;
type DurableStage = "EPISODE_PLANNING" | "NARRATIVE_DESIGN" | "SEGMENT_OUTLINE" | "SEGMENT_DRAFTING" | "HUMANIZATION" | "GROUNDING_VALIDATION" | "FINALIZING" | "COMPLETED";
type FaultPoint = "afterPlanning" | "afterNarrative" | "afterOutline" | "afterSegmentDraft" | "afterSegmentHumanization" | "afterSegmentGrounding" | "beforeFinalization";
export type PodcastFaultInjector = (point: FaultPoint, metadata: Record<string, unknown>) => Promise<void> | void;
export type ProcessPodcastDependencies = { provider: PodcastGenerationProvider; embeddingProvider: EmbeddingProvider; faultInjector?: PodcastFaultInjector; correlationId?: string };

const styleRecord = (style: any): Record<string, unknown> => podcastStyleSchema.parse({ language: style.language, tone: style.tone, depth: style.depth, pace: style.pace, hostCount: style.hostCount, targetDurationMinutes: style.targetDurationMinutes, targetAudience: style.targetAudience, formality: style.formality, humorLevel: style.humorLevel, debateLevel: style.debateLevel, storytellingLevel: style.storytellingLevel, interruptionLevel: style.interruptionLevel, disagreementLevel: style.disagreementLevel, technicalDepth: style.technicalDepth, summaryDensity: style.summaryDensity, exampleDensity: style.exampleDensity });
const persona = (host: any): PodcastHostPersona => podcastHostPersonaSchema.parse({ id: host.id, displayName: host.displayName, role: host.role, speakingStyle: host.speakingStyle, knowledgeStyle: host.knowledgeStyle, temperament: host.temperament, skepticism: host.skepticism, humor: host.humor, verbosity: host.verbosity, questionStyle: host.questionStyle, disagreementStyle: host.disagreementStyle, preferredSentenceLength: host.preferredSentenceLength, fillerPreference: host.fillerPreference });
const metadata = (run: any, stage: string, tokenBudget: number, segmentId?: string) => ({ stage, episodeId: run.episodeId, segmentId, provider: run.provider, model: run.model, correlationId: run.correlationId ?? run.id, tokenBudget });
const parseJsonArray = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

async function loadRun(runId: string) { return prisma.podcastGenerationRun.findUniqueOrThrow({ where: { id: runId }, include: { sources: true, styleProfile: true, episode: true, plan: true, narrative: true, segments: { orderBy: { ordinal: "asc" } } } }); }
async function loadHosts(run: any) { return prisma.podcastHost.findMany({ where: { podcastProjectId: run.podcastProjectId, workspaceId: run.workspaceId, configurationVersion: run.hostConfigurationVersion }, orderBy: { ordinal: "asc" } }); }

async function assertPinnedGenerationSources(run: any): Promise<void> {
  const exactRuns = await prisma.bookAnalysisRun.findMany({ where: { id: { in: run.sources.map((source: any) => source.analysisRunId) }, status: "SUCCEEDED" }, select: { id: true, workspaceId: true, sourceDocumentId: true, extractionId: true, chunkSetId: true } });
  if (exactRuns.length !== run.sources.length || run.sources.some((source: any) => !exactRuns.some((candidate) => candidate.id === source.analysisRunId && candidate.workspaceId === run.workspaceId && candidate.sourceDocumentId === source.sourceDocumentId && candidate.extractionId === source.extractionId && candidate.chunkSetId === source.chunkSetId))) throw new Error("PODCAST_GENERATION_SOURCE_LINEAGE_MISMATCH");
}

async function callProvider<T>(run: any, stage: keyof typeof PODCAST_PROVIDER_INPUT_BUDGETS, input: unknown, invoke: () => Promise<T>): Promise<T> {
  await assertPinnedGenerationSources(run);
  assertPodcastProviderInputBudget(input, PODCAST_PROVIDER_INPUT_BUDGETS[stage]);
  return invoke();
}

async function assertBoundedContext(run: any, context: PodcastContextItem[], tokenBudget: number) {
  const estimated = context.reduce((sum, item) => sum + item.tokenEstimate, 0);
  if (estimated > tokenBudget || context.some((item) => item.tokenEstimate !== estimateAnalysisTokens(item.content))) throw new Error("PODCAST_CONTEXT_BUDGET_VIOLATION");
  for (const source of run.sources) {
    const sourceItems = context.filter((item) => item.sourceDocumentId === source.sourceDocumentId);
    const selectedBlocks = new Set(sourceItems.flatMap((item) => item.sourceBlockEvidenceSpans.map((span) => span.sourceBlockId)));
    const totalBlocks = await prisma.sourceBlock.count({ where: { extractionId: source.extractionId } });
    if (totalBlocks > 1 && selectedBlocks.size >= totalBlocks) throw new Error("PODCAST_FULL_BOOK_CONTEXT_FORBIDDEN");
  }
}

async function retrieveContext(run: any, dependencies: ProcessPodcastDependencies, task: string, totalBudget: number): Promise<PodcastContextItem[]> {
  const perSource = Math.max(200, Math.floor(totalBudget / run.sources.length));
  const packs = [] as PodcastContextItem[][];
  for (const source of run.sources) {
    const pack = await buildBookContextForIntelligence({ workspaceId: run.workspaceId, sourceDocumentId: source.sourceDocumentId, extractionId: source.extractionId, chunkSetId: source.chunkSetId, analysisRunId: source.analysisRunId, task, tokenBudget: perSource, embeddingProvider: dependencies.embeddingProvider });
    if (pack.lineage.sourceDocumentId !== source.sourceDocumentId || pack.lineage.extractionId !== source.extractionId || pack.lineage.chunkSetId !== source.chunkSetId || pack.lineage.analysisRunId !== source.analysisRunId) throw new Error("PODCAST_GENERATION_SOURCE_LINEAGE_MISMATCH");
    packs.push(pack.items.map((item: any) => ({ sourceDocumentId: item.sourceDocumentId, extractionId: item.extractionId, chunkSetId: item.chunkSetId, analysisRunId: item.analysisRunId, memoryItemId: item.memoryItemId, artifactId: item.artifactId, chunkId: item.chunkId, type: item.type, content: item.content, score: item.score, selectionReason: item.selectionReason, tokenEstimate: item.tokenEstimate, sourceBlockEvidenceSpans: item.evidence.map((evidence: any) => ({ sourceBlockId: evidence.sourceBlockId, startOffset: evidence.startOffset, endOffset: evidence.endOffset, quoteText: evidence.quoteText })) })));
  }
  const result = packs.flat();
  await assertBoundedContext(run, result, totalBudget);
  return result;
}

async function runPlanning(run: any, token: string, dependencies: ProcessPodcastDependencies) {
  let plan = run.plan;
  if (!plan) {
    const context = await retrieveContext(run, dependencies, `Plan a cognitive episode titled ${run.episode.title}`, PLANNING_CONTEXT_BUDGET);
    await renewPodcastGenerationLease(run.id, token);
    const hosts = (await loadHosts(run)).map(persona);
    const input = { metadata: metadata(run, "EPISODE_PLANNING", PODCAST_PROVIDER_INPUT_BUDGETS.EPISODE_PLANNING), style: styleRecord(run.styleProfile), hosts, context };
    const output = episodePlanSchema.parse(await callProvider(run, "EPISODE_PLANNING", input, () => dependencies.provider.plan(input)));
    plan = await withOwnedPodcastTransaction(run.id, token, async (tx) => {
      await tx.podcastPlanContextItem.createMany({ data: context.map((item) => ({ podcastGenerationRunId: run.id, workspaceId: run.workspaceId, episodeId: run.episodeId, sourceDocumentId: item.sourceDocumentId, extractionId: item.extractionId, chunkSetId: item.chunkSetId, analysisRunId: item.analysisRunId, memoryItemId: item.memoryItemId, artifactId: item.artifactId, chunkId: item.chunkId, score: item.score, selectionReason: item.selectionReason, tokenEstimate: item.tokenEstimate, evidenceSpans: item.sourceBlockEvidenceSpans as any })), skipDuplicates: true });
      return tx.episodePlan.create({ data: { podcastGenerationRunId: run.id, workspaceId: run.workspaceId, episodeId: run.episodeId, ...output } });
    });
    await dependencies.faultInjector?.("afterPlanning", { podcastGenerationRunId: run.id });
  }
  await advancePodcastStage(run.id, token, "EPISODE_PLANNING", "NARRATIVE_DESIGN");
  return plan;
}

async function runNarrative(run: any, token: string, dependencies: ProcessPodcastDependencies) {
  let narrative = run.narrative;
  const plan = run.plan ?? await prisma.episodePlan.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } });
  if (!narrative) {
    await renewPodcastGenerationLease(run.id, token);
    const input = { metadata: metadata(run, "NARRATIVE_DESIGN", PODCAST_PROVIDER_INPUT_BUDGETS.NARRATIVE_DESIGN), style: styleRecord(run.styleProfile), hosts: (await loadHosts(run)).map(persona), plan: plan as EpisodePlanOutput };
    const output = narrativeSchema.parse(await callProvider(run, "NARRATIVE_DESIGN", input, () => dependencies.provider.designNarrative(input)));
    narrative = await withOwnedPodcastTransaction(run.id, token, (tx) => tx.episodeNarrative.create({ data: { podcastGenerationRunId: run.id, workspaceId: run.workspaceId, episodeId: run.episodeId, ...output } }));
    await dependencies.faultInjector?.("afterNarrative", { podcastGenerationRunId: run.id });
  }
  await advancePodcastStage(run.id, token, "NARRATIVE_DESIGN", "SEGMENT_OUTLINE");
  return narrative;
}

async function runOutline(run: any, token: string, dependencies: ProcessPodcastDependencies) {
  let segments = await prisma.episodeSegment.findMany({ where: { podcastGenerationRunId: run.id }, orderBy: { ordinal: "asc" } });
  if (!segments.length) {
    const [plan, narrative, allAvailable] = await Promise.all([prisma.episodePlan.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), prisma.episodeNarrative.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), prisma.podcastPlanContextItem.findMany({ where: { podcastGenerationRunId: run.id }, select: { memoryItemId: true, tokenEstimate: true }, orderBy: [{ tokenEstimate: "asc" }, { memoryItemId: "asc" }] })]);
    const available = allAvailable.filter((item) => item.tokenEstimate <= Math.floor(SEGMENT_CONTEXT_BUDGET / 2));
    if (!available.length) throw new Error("PODCAST_NO_SEGMENT_FEASIBLE_CONTEXT");
    await renewPodcastGenerationLease(run.id, token);
    const input = { metadata: metadata(run, "SEGMENT_OUTLINE", PODCAST_PROVIDER_INPUT_BUDGETS.SEGMENT_OUTLINE), style: styleRecord(run.styleProfile), hosts: (await loadHosts(run)).map(persona), plan: plan as EpisodePlanOutput, narrative: narrative as NarrativeOutput, availableMemoryIds: available.map((item) => item.memoryItemId) };
    const output = segmentOutlineSchema.parse(await callProvider(run, "SEGMENT_OUTLINE", input, () => dependencies.provider.outlineSegments(input)));
    if (new Set(output.segments.map((item) => item.ordinal)).size !== output.segments.length || output.segments.some((item, index) => item.ordinal !== index + 1)) throw new Error("PODCAST_SEGMENT_ORDINALS_INVALID");
    const allowed = new Set(available.map((item) => item.memoryItemId));
    if (output.segments.some((item) => [...item.requiredMemoryIds, ...item.optionalMemoryIds].some((id) => !allowed.has(id)))) throw new Error("PODCAST_SEGMENT_MEMORY_LINEAGE_INVALID");
    await withOwnedPodcastTransaction(run.id, token, (tx) => tx.episodeSegment.createMany({ data: output.segments.map((item) => ({ podcastGenerationRunId: run.id, workspaceId: run.workspaceId, podcastProjectId: run.podcastProjectId, episodeId: run.episodeId, ...item, disagreementReason: item.disagreementReason ?? null })) }));
    segments = await prisma.episodeSegment.findMany({ where: { podcastGenerationRunId: run.id }, orderBy: { ordinal: "asc" } });
    await dependencies.faultInjector?.("afterOutline", { podcastGenerationRunId: run.id, segmentCount: segments.length });
  }
  await advancePodcastStage(run.id, token, "SEGMENT_OUTLINE", "SEGMENT_DRAFTING");
  return segments;
}

function segmentOutput(segment: any): SegmentOutlineOutput["segments"][number] { return { ordinal: segment.ordinal, purpose: segment.purpose, internalLabel: segment.internalLabel, targetDurationSeconds: segment.targetDurationSeconds, narrativeFunction: segment.narrativeFunction, keyQuestions: parseJsonArray<string>(segment.keyQuestions), requiredMemoryIds: parseJsonArray<string>(segment.requiredMemoryIds), optionalMemoryIds: parseJsonArray<string>(segment.optionalMemoryIds), disagreementReason: segment.disagreementReason }; }

async function loadPersistedSegmentContext(segment: any): Promise<PodcastContextItem[]> {
  const rows = await prisma.podcastSegmentContextItem.findMany({ where: { segmentId: segment.id }, include: { memoryItem: true }, orderBy: [{ score: "desc" }, { memoryItemId: "asc" }] });
  return rows.map((row) => ({ sourceDocumentId: row.sourceDocumentId, extractionId: row.extractionId, chunkSetId: row.chunkSetId, analysisRunId: row.analysisRunId, memoryItemId: row.memoryItemId, artifactId: row.artifactId, chunkId: row.chunkId, type: row.memoryItem.type, content: row.memoryItem.content, score: row.score, selectionReason: row.selectionReason, tokenEstimate: row.tokenEstimate, sourceBlockEvidenceSpans: row.evidenceSpans as PodcastContextItem["sourceBlockEvidenceSpans"] }));
}

async function ensureSegmentContext(run: any, segment: any, token: string, dependencies: ProcessPodcastDependencies) {
  let context = await loadPersistedSegmentContext(segment);
  if (context.length) return context;
  context = await retrieveContext(run, dependencies, [segment.purpose, ...parseJsonArray<string>(segment.keyQuestions)].join("\n"), SEGMENT_CONTEXT_BUDGET);
  const required = new Set(parseJsonArray<string>(segment.requiredMemoryIds));
  const missing = [...required].filter((id) => !context.some((item) => item.memoryItemId === id));
  if (missing.length) {
    const planItems = await prisma.podcastPlanContextItem.findMany({ where: { podcastGenerationRunId: run.id, memoryItemId: { in: missing } }, include: { memoryItem: true } });
    for (const row of planItems) {
      const candidate: PodcastContextItem = { sourceDocumentId: row.sourceDocumentId, extractionId: row.extractionId, chunkSetId: row.chunkSetId, analysisRunId: row.analysisRunId, memoryItemId: row.memoryItemId, artifactId: row.artifactId, chunkId: row.chunkId, type: row.memoryItem.type, content: row.memoryItem.content, score: row.score, selectionReason: "required_by_segment_outline", tokenEstimate: row.tokenEstimate, sourceBlockEvidenceSpans: row.evidenceSpans as PodcastContextItem["sourceBlockEvidenceSpans"] };
      while (context.reduce((sum, item) => sum + item.tokenEstimate, 0) + candidate.tokenEstimate > SEGMENT_CONTEXT_BUDGET) { const removable = [...context].reverse().find((item) => !required.has(item.memoryItemId)); if (!removable) break; context.splice(context.indexOf(removable), 1); }
      if (context.reduce((sum, item) => sum + item.tokenEstimate, 0) + candidate.tokenEstimate <= SEGMENT_CONTEXT_BUDGET) context.push(candidate);
    }
  }
  if ([...required].some((id) => !context.some((item) => item.memoryItemId === id))) throw new Error("PODCAST_REQUIRED_CONTEXT_BUDGET_EXCEEDED");
  await assertBoundedContext(run, context, SEGMENT_CONTEXT_BUDGET);
  await withOwnedPodcastTransaction(run.id, token, (tx) => tx.podcastSegmentContextItem.createMany({ data: context.map((item) => ({ podcastGenerationRunId: run.id, segmentId: segment.id, workspaceId: run.workspaceId, episodeId: run.episodeId, sourceDocumentId: item.sourceDocumentId, extractionId: item.extractionId, chunkSetId: item.chunkSetId, analysisRunId: item.analysisRunId, memoryItemId: item.memoryItemId, artifactId: item.artifactId, chunkId: item.chunkId, score: item.score, selectionReason: item.selectionReason, tokenEstimate: item.tokenEstimate, evidenceSpans: item.sourceBlockEvidenceSpans as any })), skipDuplicates: true }));
  return context;
}

async function draftSegment(run: any, segment: any, token: string, dependencies: ProcessPodcastDependencies) {
  if (await prisma.podcastUtterance.count({ where: { segmentId: segment.id } })) return;
  const context = await ensureSegmentContext(run, segment, token, dependencies);
  const [plan, narrative, hosts] = await Promise.all([prisma.episodePlan.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), prisma.episodeNarrative.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), loadHosts(run)]);
  await renewPodcastGenerationLease(run.id, token);
  const input = { metadata: metadata(run, "SEGMENT_DRAFTING", PODCAST_PROVIDER_INPUT_BUDGETS.SEGMENT_DRAFTING, segment.id), style: styleRecord(run.styleProfile), hosts: hosts.map(persona), plan: plan as EpisodePlanOutput, narrative: narrative as NarrativeOutput, segment: segmentOutput(segment), context };
  const output = dialogueSchema.parse(await callProvider(run, "SEGMENT_DRAFTING", input, () => dependencies.provider.draftSegment(input)));
  const allowedHosts = new Set(hosts.map((host) => host.id)), allowedMemory = new Set(context.map((item) => item.memoryItemId));
  if (new Set(output.utterances.map((item) => item.ordinal)).size !== output.utterances.length || output.utterances.some((item, index) => item.ordinal !== index + 1) || output.utterances.some((item) => !allowedHosts.has(item.speakerHostId) || item.evidence.some((evidence) => !allowedMemory.has(evidence.memoryItemId)))) throw new Error("PODCAST_DIALOGUE_LINEAGE_INVALID");
  const memoryIds = [...new Set(output.utterances.flatMap((item) => item.evidence.map((evidence) => evidence.memoryItemId)))];
  const memory = await prisma.bookMemoryItem.findMany({ where: { id: { in: memoryIds } }, include: { evidence: true } });
  const memoryMap = new Map(memory.map((item) => [item.id, item]));
  await withOwnedPodcastTransaction(run.id, token, async (tx) => {
    await tx.episodeSegment.update({ where: { id: segment.id }, data: { generationAttemptCount: { increment: 1 } } });
    for (const item of output.utterances) {
      const utterance = await tx.podcastUtterance.create({ data: { segmentId: segment.id, podcastGenerationRunId: run.id, workspaceId: run.workspaceId, podcastProjectId: run.podcastProjectId, episodeId: run.episodeId, speakerHostId: item.speakerHostId, ordinal: item.ordinal, draftText: item.text, text: item.text, utteranceType: item.utteranceType, substantive: item.substantive, isDirectQuote: item.isDirectQuote, estimatedDurationMs: estimateSpokenDurationMs(item.text) } });
      for (const reference of item.evidence) {
        const source = context.find((candidate) => candidate.memoryItemId === reference.memoryItemId)!;
        const memoryItem = memoryMap.get(reference.memoryItemId);
        if (!memoryItem?.evidence.length) throw new Error("PODCAST_EVIDENCE_REQUIRED");
        const lineageEvidence = reference.sourceBlockId === undefined ? memoryItem.evidence : memoryItem.evidence.filter((evidence) => evidence.sourceBlockId === reference.sourceBlockId && evidence.startOffset === reference.startOffset && evidence.endOffset === reference.endOffset);
        if (!lineageEvidence.length) throw new Error("PODCAST_EVIDENCE_SPAN_LINEAGE_INVALID");
        const selectedEvidence = item.isDirectQuote ? lineageEvidence.filter((evidence) => Boolean(evidence.quoteText) && item.text.includes(evidence.quoteText!)) : lineageEvidence;
        if (!selectedEvidence.length) throw new Error(`PODCAST_DIRECT_QUOTE_LINEAGE_INVALID:textLength=${item.text.length}:quoteLengths=${lineageEvidence.map((evidence) => evidence.quoteText?.length ?? 0).join(",")}`);
        await tx.podcastUtteranceEvidence.createMany({ data: selectedEvidence.map((evidence) => ({ utteranceId: utterance.id, segmentId: segment.id, podcastGenerationRunId: run.id, workspaceId: run.workspaceId, sourceDocumentId: source.sourceDocumentId, extractionId: source.extractionId, chunkSetId: source.chunkSetId, analysisRunId: source.analysisRunId, memoryItemId: memoryItem.id, sourceBlockId: evidence.sourceBlockId, startOffset: evidence.startOffset, endOffset: evidence.endOffset, quoteText: evidence.quoteText, quoteHash: evidence.quoteHash })), skipDuplicates: true });
      }
    }
    await tx.episodeSegment.update({ where: { id: segment.id }, data: { status: "DRAFTED" } });
  });
  await dependencies.faultInjector?.("afterSegmentDraft", { podcastGenerationRunId: run.id, segmentId: segment.id });
}

async function runDrafting(run: any, token: string, dependencies: ProcessPodcastDependencies) {
  const segments = await prisma.episodeSegment.findMany({ where: { podcastGenerationRunId: run.id }, orderBy: { ordinal: "asc" } });
  for (const segment of segments) await draftSegment(run, segment, token, dependencies);
  await advancePodcastStage(run.id, token, "SEGMENT_DRAFTING", "HUMANIZATION");
}

async function humanizeSegment(run: any, segment: any, token: string, dependencies: ProcessPodcastDependencies) {
  const current = await prisma.episodeSegment.findUniqueOrThrow({ where: { id: segment.id } });
  if (current.status === "HUMANIZED" || current.status === "GROUNDED") return;
  const utterances = await prisma.podcastUtterance.findMany({ where: { segmentId: segment.id }, include: { evidence: true }, orderBy: { ordinal: "asc" } });
  const dialogue: DialogueOutput = { utterances: utterances.map((item) => ({ ordinal: item.ordinal, speakerHostId: item.speakerHostId, text: item.text, utteranceType: item.utteranceType, substantive: item.substantive, isDirectQuote: item.isDirectQuote, evidence: [...new Set(item.evidence.map((evidence) => evidence.memoryItemId))].map((memoryItemId) => ({ memoryItemId })) })) };
  await renewPodcastGenerationLease(run.id, token);
  const input = { metadata: metadata(run, "HUMANIZATION", PODCAST_PROVIDER_INPUT_BUDGETS.HUMANIZATION, segment.id), style: styleRecord(run.styleProfile), hosts: (await loadHosts(run)).map(persona), segment: segmentOutput(segment), dialogue };
  const output = humanizationSchema.parse(await callProvider(run, "HUMANIZATION", input, () => dependencies.provider.humanizeSegment(input)));
  if (output.utterances.length !== utterances.length || output.utterances.some((item, index) => item.ordinal !== utterances[index]!.ordinal)) throw new Error("PODCAST_HUMANIZATION_STRUCTURE_CHANGED");
  for (let index = 0; index < utterances.length; index++) {
    if (utterances[index]!.isDirectQuote && output.utterances[index]!.text !== utterances[index]!.text) throw new Error("PODCAST_HUMANIZATION_CHANGED_QUOTE");
    if ((utterances[index]!.substantive || utterances[index]!.evidence.length > 0) && output.utterances[index]!.text !== utterances[index]!.text) throw new Error("PODCAST_HUMANIZATION_CHANGED_SUBSTANTIVE_CLAIM");
  }
  await withOwnedPodcastTransaction(run.id, token, async (tx) => {
    for (let index = 0; index < utterances.length; index++) await tx.podcastUtterance.update({ where: { id: utterances[index]!.id }, data: { text: output.utterances[index]!.text, estimatedDurationMs: estimateSpokenDurationMs(output.utterances[index]!.text), humanizedAt: new Date() } });
    await tx.episodeSegment.update({ where: { id: segment.id }, data: { status: "HUMANIZED" } });
  });
  await dependencies.faultInjector?.("afterSegmentHumanization", { podcastGenerationRunId: run.id, segmentId: segment.id });
}

async function runHumanization(run: any, token: string, dependencies: ProcessPodcastDependencies) {
  const segments = await prisma.episodeSegment.findMany({ where: { podcastGenerationRunId: run.id }, orderBy: { ordinal: "asc" } });
  for (const segment of segments) await humanizeSegment(run, segment, token, dependencies);
  await advancePodcastStage(run.id, token, "HUMANIZATION", "GROUNDING_VALIDATION");
}

async function groundingErrors(segmentId: string): Promise<string[]> {
  const utterances = await prisma.podcastUtterance.findMany({ where: { segmentId }, include: { evidence: { include: { sourceBlock: true } } } });
  const errors: string[] = [];
  for (const utterance of utterances) {
    if (utterance.substantive && !utterance.evidence.length) errors.push(`UNSUPPORTED:${utterance.id}`);
    if (/我去年.{0,12}(创业|工作|经历)|我朋友.{0,12}(正好|曾经|就是)|I once worked at|when I worked at/iu.test(utterance.text)) errors.push(`FABRICATED_BIOGRAPHY:${utterance.id}`);
    const exactQuoteEvidence = utterance.evidence.filter((evidence) => Boolean(evidence.quoteText));
    if (utterance.isDirectQuote && !exactQuoteEvidence.length) errors.push(`QUOTE_EVIDENCE_TEXT_MISSING:${utterance.id}`);
    for (const evidence of utterance.evidence) {
      if (evidence.startOffset < 0 || evidence.endOffset <= evidence.startOffset || evidence.endOffset > evidence.sourceBlock.text.length) errors.push(`INVALID_OFFSETS:${evidence.id}`);
      const exact = evidence.sourceBlock.text.slice(evidence.startOffset, evidence.endOffset);
      if (evidence.quoteText !== null && exact !== evidence.quoteText) errors.push(`QUOTE_EVIDENCE_MISMATCH:${evidence.id}`);
      if (utterance.isDirectQuote && evidence.quoteText && !utterance.text.includes(evidence.quoteText)) errors.push(`QUOTE_NOT_EXACT:${utterance.id}`);
    }
  }
  return errors;
}

async function runGrounding(run: any, token: string, dependencies: ProcessPodcastDependencies) {
  const segments = await prisma.episodeSegment.findMany({ where: { podcastGenerationRunId: run.id }, orderBy: { ordinal: "asc" } });
  for (const segment of segments) {
    let current = await prisma.episodeSegment.findUniqueOrThrow({ where: { id: segment.id } });
    if (current.status === "GROUNDED") continue;
    let errors = await groundingErrors(segment.id);
    if (errors.length && current.generationAttemptCount < 2) {
      await withOwnedPodcastTransaction(run.id, token, async (tx) => { await tx.podcastUtterance.deleteMany({ where: { segmentId: segment.id } }); await tx.episodeSegment.update({ where: { id: segment.id }, data: { status: "PLANNED" } }); });
      await draftSegment(run, segment, token, dependencies);
      await humanizeSegment(run, segment, token, dependencies);
      errors = await groundingErrors(segment.id);
      current = await prisma.episodeSegment.findUniqueOrThrow({ where: { id: segment.id } });
    }
    if (errors.length) throw new Error(`PODCAST_GROUNDING_FAILED:${errors[0]}`);
    const duration = (await prisma.podcastUtterance.aggregate({ where: { segmentId: segment.id }, _sum: { estimatedDurationMs: true } }))._sum.estimatedDurationMs ?? 0;
    await withOwnedPodcastTransaction(run.id, token, (tx) => tx.episodeSegment.update({ where: { id: segment.id }, data: { status: "GROUNDED", estimatedDurationSeconds: Math.max(1, Math.ceil(duration / 1000)) } }));
    await dependencies.faultInjector?.("afterSegmentGrounding", { podcastGenerationRunId: run.id, segmentId: segment.id, attemptCount: current.generationAttemptCount });
  }
  await advancePodcastStage(run.id, token, "GROUNDING_VALIDATION", "FINALIZING");
}

async function runFinalization(run: any, token: string, dependencies: ProcessPodcastDependencies) {
  await dependencies.faultInjector?.("beforeFinalization", { podcastGenerationRunId: run.id });
  const [segments, hosts] = await Promise.all([prisma.episodeSegment.findMany({ where: { podcastGenerationRunId: run.id }, include: { utterances: { include: { evidence: true }, orderBy: { ordinal: "asc" } } }, orderBy: { ordinal: "asc" } }), loadHosts(run)]);
  if (!segments.length || segments.some((segment) => segment.status !== "GROUNDED")) throw new Error("PODCAST_SEGMENTS_NOT_GROUNDED");
  const utterances = segments.flatMap((segment) => segment.utterances.map((item) => ({ id: item.id, segmentId: segment.id, segmentOrdinal: segment.ordinal, speakerHostId: item.speakerHostId, ordinal: item.ordinal, text: item.text, utteranceType: item.utteranceType, substantive: item.substantive, estimatedDurationMs: item.estimatedDurationMs, evidenceCount: item.evidence.length, evidenceMemoryIds: [...new Set(item.evidence.map((evidence) => evidence.memoryItemId))], evidence: item.evidence })));
  const estimatedDurationSeconds = Math.max(1, Math.ceil(utterances.reduce((sum, item) => sum + item.estimatedDurationMs, 0) / 1000));
  const sourceTexts = (await prisma.sourceBlock.findMany({ where: { extractionId: { in: run.sources.map((source: any) => source.extractionId) } }, orderBy: [{ extractionId: "asc" }, { ordinal: "asc" }], select: { text: true } })).map((block) => block.text);
  const evaluation = evaluatePodcastScriptData(utterances, { contextWithinBudget: true, sourceTexts });
  if (evaluation.hardFailures.length) throw new Error(`PODCAST_FINAL_QUALITY_INVALID:${evaluation.hardFailures[0]}`);
  await withOwnedPodcastTransaction(run.id, token, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PodcastEpisode" WHERE "id" = ${run.episodeId} FOR UPDATE`;
    let revision = await tx.podcastScriptRevision.findUnique({ where: { generationRunId: run.id } });
    if (!revision) {
      const current = await tx.currentPodcastScript.findUnique({ where: { episodeId: run.episodeId }, include: { revision: true } });
      if (current) await tx.podcastScriptRevision.update({ where: { id: current.revisionId }, data: { status: "SUPERSEDED" } });
      revision = await tx.podcastScriptRevision.create({ data: { workspaceId: run.workspaceId, episodeId: run.episodeId, revisionNumber: (current?.revision.revisionNumber ?? 0) + 1, parentRevisionId: current?.revisionId, generationRunId: run.id, source: current ? "REGENERATED" : "GENERATED", status: "FINAL", estimatedDurationSeconds, scriptSnapshot: { episode: { id: run.episode.id, title: run.episode.title, language: run.episode.language }, hosts: hosts.map(persona), segments: segments.map((segment) => ({ id: segment.id, ordinal: segment.ordinal, purpose: segment.purpose, internalLabel: segment.internalLabel, estimatedDurationSeconds: segment.estimatedDurationSeconds })), utterances, generation: { runId: run.id, pipelineVersion: run.pipelineVersion, promptVersion: run.promptVersion, provider: run.provider, model: run.model, modelVersion: run.modelVersion } } as any } });
      await tx.currentPodcastScript.upsert({ where: { episodeId: run.episodeId }, create: { workspaceId: run.workspaceId, episodeId: run.episodeId, revisionId: revision.id }, update: { revisionId: revision.id } });
      const evaluationRun = await tx.podcastEvaluationRun.create({ data: { workspaceId: run.workspaceId, episodeId: run.episodeId, revisionId: revision.id, evaluatorVersion: "phase3-deterministic-v2", status: "SUCCEEDED", completedAt: new Date() } });
      await tx.podcastEvaluationResult.create({ data: { evaluationRunId: evaluationRun.id, ...evaluation } });
    }
    const completed = await tx.$executeRaw`UPDATE "PodcastGenerationRun" SET "status" = 'SUCCEEDED'::"PodcastGenerationStatus", "stage" = 'COMPLETED'::"PodcastGenerationStage", "completedAt" = NOW(), "errorCode" = NULL, "executionClaimToken" = NULL, "executionClaimedAt" = NULL, "executionLeaseUntil" = NULL WHERE "id" = ${run.id} AND "executionClaimToken" = ${token} AND "executionLeaseUntil" > NOW() AND "status" = 'RUNNING'::"PodcastGenerationStatus" AND "stage" = 'FINALIZING'::"PodcastGenerationStage"`;
    if (completed !== 1) throw new Error(PODCAST_GENERATION_OWNERSHIP_LOST);
    await tx.job.update({ where: { id: run.jobId }, data: { status: "SUCCEEDED", progress: 100, completedAt: new Date(), result: { podcastGenerationRunId: run.id, revisionId: revision.id } } });
    await tx.podcastEpisode.update({ where: { id: run.episodeId }, data: { status: "READY", estimatedDurationSeconds } });
  });
}

export async function processPodcastGenerationRun(runId: string, dependencies: ProcessPodcastDependencies) {
  let run = await loadRun(runId);
  if (run.status === "SUCCEEDED") return run;
  if (dependencies.provider.identity.provider !== run.provider || dependencies.provider.identity.model !== run.model || (dependencies.provider.identity.modelVersion ?? "") !== run.modelVersionKey) throw new Error("PODCAST_PROVIDER_IDENTITY_MISMATCH");
  const token = randomUUID();
  if (!await claimPodcastGenerationRun(run.id, token)) { run = await loadRun(run.id); if (run.status === "SUCCEEDED") return run; throw new Error("PODCAST_GENERATION_ALREADY_CLAIMED"); }
  try {
    while (true) {
      run = await loadRun(run.id);
      const stage = run.stage as DurableStage;
      if (stage === "EPISODE_PLANNING") await runPlanning(run, token, dependencies);
      else if (stage === "NARRATIVE_DESIGN") await runNarrative(run, token, dependencies);
      else if (stage === "SEGMENT_OUTLINE") await runOutline(run, token, dependencies);
      else if (stage === "SEGMENT_DRAFTING") await runDrafting(run, token, dependencies);
      else if (stage === "HUMANIZATION") await runHumanization(run, token, dependencies);
      else if (stage === "GROUNDING_VALIDATION") await runGrounding(run, token, dependencies);
      else if (stage === "FINALIZING") { await runFinalization(run, token, dependencies); break; }
      else if (stage === "COMPLETED") break;
      else throw new Error(`PODCAST_STAGE_INVALID:${stage}`);
    }
    logger.info("podcast.generation.completed", { podcastGenerationRunId: run.id, episodeId: run.episodeId, workspaceId: run.workspaceId, correlationId: dependencies.correlationId ?? run.correlationId ?? run.id });
    return loadRun(run.id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "PODCAST_GENERATION_FAILED";
    const errorCode = errorMessage.split(":")[0]!;
    if (errorCode !== PODCAST_GENERATION_OWNERSHIP_LOST) await failOwnedPodcastGeneration(run.id, run.jobId, run.episodeId, token, errorCode);
    logger.error("podcast.generation.failed", { podcastGenerationRunId: run.id, episodeId: run.episodeId, workspaceId: run.workspaceId, errorCode, errorMessage: errorMessage.slice(0, 500) });
    throw error;
  }
}

export async function dispatchPendingPodcastGeneration(queue: { add(name: string, payload: { podcastGenerationRunId: string }, options: { jobId: string }): Promise<unknown> }, aggregateIds?: string[]) {
  return dispatchPendingOutbox<{ podcastGenerationRunId: string }>({ topic: PODCAST_GENERATION_TOPIC, queue, jobName: PODCAST_GENERATION_JOB, parse: (payload: unknown) => { const value = payload as { podcastGenerationRunId?: unknown }; if (typeof value?.podcastGenerationRunId !== "string") throw new Error("PODCAST_OUTBOX_PAYLOAD_INVALID"); return { podcastGenerationRunId: value.podcastGenerationRunId }; }, jobId: (payload: { podcastGenerationRunId: string }) => payload.podcastGenerationRunId, aggregateIds, afterDispatch: async (tx, payload: { podcastGenerationRunId: string }, queueJobId: string) => { const run = await prisma.podcastGenerationRun.findUniqueOrThrow({ where: { id: payload.podcastGenerationRunId } }); await tx.job.update({ where: { id: run.jobId }, data: { queueJobId } }); } });
}
