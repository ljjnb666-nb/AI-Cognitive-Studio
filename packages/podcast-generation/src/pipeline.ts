/* Prisma rows are deliberately structurally typed at this orchestration boundary. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { buildBookContextForIntelligence, estimateAnalysisTokens, type EmbeddingProvider } from "@ai-cognitive/book-intelligence";
import { dispatchPendingOutbox } from "@ai-cognitive/ingestion";
import { logger } from "@ai-cognitive/shared";
import { estimateSpokenDurationMs } from "./duration.js";
import { evaluatePodcastScriptData } from "./evaluation.js";
import { advancePodcastStage, assertOwnedPodcastRunInTransaction, claimPodcastGenerationRun, failOwnedPodcastGeneration, PODCAST_GENERATION_OWNERSHIP_LOST, renewPodcastGenerationLease, withOwnedPodcastTransaction } from "./ownership.js";
import { dialogueSchema, episodePlanSchema, humanizationSchema, narrativeSchema, segmentOutlineSchema, type DialogueOutput, type DurablePodcastGenerationProvider, type EpisodePlanOutput, type HumanizationOutput, type NarrativeOutput, type PodcastContextItem, type PodcastGenerationProvider, type PodcastHostPersona, type SegmentOutlineOutput } from "./types.js";
import { PODCAST_GENERATION_JOB, PODCAST_GENERATION_TOPIC } from "./services.js";
import { assertPodcastProviderInputBudget, PODCAST_PROVIDER_INPUT_BUDGETS } from "./provider-budget.js";
import { podcastHostPersonaSchema, podcastStyleSchema } from "./types.js";
import { podcastConsumerFingerprint } from "./consumer-fingerprint.js";
import { buildDraftDestinationProjection, buildHumanizationDestinationProjection, buildNarrativeDestinationProjection, buildOutlineDestinationProjection, buildPlanningDestinationProjection } from "./destination-projection.js";

const PLANNING_CONTEXT_BUDGET = 4_000;
const SEGMENT_CONTEXT_BUDGET = 2_400;
type DurableStage = "EPISODE_PLANNING" | "NARRATIVE_DESIGN" | "SEGMENT_OUTLINE" | "SEGMENT_DRAFTING" | "HUMANIZATION" | "GROUNDING_VALIDATION" | "FINALIZING" | "COMPLETED";
type FaultPoint = "afterPlanningRetrieval" | "afterTextReceipt" | "afterPlanning" | "afterNarrative" | "afterOutline" | "afterSegmentDraft" | "afterSegmentHumanization" | "afterSegmentGrounding" | "beforeFinalization";
export type PodcastFaultInjector = (point: FaultPoint, metadata: Record<string, unknown>) => Promise<void> | void;
export type ProcessPodcastDependencies = { provider?: PodcastGenerationProvider; providerForRun?: (input: { workspaceId: string; podcastGenerationRunId: string; provider: string; model: string }) => Promise<DurablePodcastGenerationProvider>; embeddingProvider?: EmbeddingProvider; embeddingProviderForRun?: (input: { workspaceId: string; podcastGenerationRunId: string }) => Promise<EmbeddingProvider>; faultInjector?: PodcastFaultInjector; correlationId?: string };
const isDurable = (provider: PodcastGenerationProvider): provider is DurablePodcastGenerationProvider => "consumeTextResult" in provider && "verifyConsumedTextResult" in provider;
const operationKey = (run: any, stage: string, segmentId?: string) => `${run.id}:${stage}${segmentId ? `:${segmentId}` : ""}`;
const consumerFingerprint = (run: any, stage: string, destination: string, input: unknown, output: unknown) => podcastConsumerFingerprint({ run, stage, destination, input, output });

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
async function invokeText<T>(run: any, token: string, dependencies: ProcessPodcastDependencies, stage: keyof typeof PODCAST_PROVIDER_INPUT_BUDGETS, segmentId: string | undefined, input: unknown, invoke: () => Promise<unknown>, parse: (value: unknown) => T, destination: string, materialize: (tx: any, output: T) => Promise<void>, projection: (output: T) => unknown): Promise<{ output: T; consumed: boolean }> {
  const output = parse(await callProvider(run, stage, input, invoke));
  // Test-only fault seam: a paid result is now durable, but no application row
  // has been materialized. It makes the ownership handoff boundary observable.
  await dependencies.faultInjector?.("afterTextReceipt", { podcastGenerationRunId: run.id, stage, segmentId: segmentId ?? null });
  if (!dependencies.provider || !isDurable(dependencies.provider)) return { output, consumed: false };
  await dependencies.provider.consumeTextResult<T>(operationKey(run, stage, segmentId), { consumerKind: `PODCAST_${destination}`, consumerKey: segmentId ?? run.id, consumerFingerprint: consumerFingerprint(run, stage, destination, input, projection(output)) }, async ({ tx, output: raw }) => {
    await assertOwnedPodcastRunInTransaction(tx as never, run.id, token, stage);
    await materialize(tx, parse(raw));
  });
  return { output, consumed: true };
}

async function verifyConsumedDestination(run: any, provider: PodcastGenerationProvider, stage: keyof typeof PODCAST_PROVIDER_INPUT_BUDGETS, segmentId: string | undefined, destination: string, input: unknown, output: unknown): Promise<void> {
  if (!isDurable(provider)) return;
  const state = await provider.verifyConsumedTextResult(operationKey(run, stage, segmentId), { consumerKind: `PODCAST_${destination}`, consumerKey: segmentId ?? run.id, consumerFingerprint: consumerFingerprint(run, stage, destination, input, output) });
  // A materialized destination is only safe to advance when it matches the
  // consumed, purged receipt exactly.  Treat an absent tombstone as unsafe too:
  // recreating/re-calling here could charge the same durable operation twice.
  if (state !== "EXACT") throw new Error("PODCAST_TEXT_RECONCILIATION_REQUIRED");
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

const stableScore = (value: number) => Number(value.toPrecision(15));
function canonicalContextItem(item: any): PodcastContextItem {
  return { sourceDocumentId: item.sourceDocumentId, extractionId: item.extractionId, chunkSetId: item.chunkSetId, analysisRunId: item.analysisRunId, memoryItemId: item.memoryItemId, artifactId: item.artifactId, chunkId: item.chunkId ?? null, type: item.type ?? item.memoryItem?.type ?? null, content: item.content ?? item.memoryItem?.content ?? "", score: stableScore(item.score), selectionReason: item.selectionReason, tokenEstimate: item.tokenEstimate, sourceBlockEvidenceSpans: (item.sourceBlockEvidenceSpans ?? item.evidenceSpans ?? []).map((evidence: any) => ({ sourceBlockId: evidence.sourceBlockId, startOffset: evidence.startOffset, endOffset: evidence.endOffset, quoteText: evidence.quoteText ?? null })) } as PodcastContextItem;
}
function contextFromRows(rows: any[]): PodcastContextItem[] {
  return rows.map(canonicalContextItem);
}
async function loadPersistedPlanContext(run: any): Promise<PodcastContextItem[]> {
  return contextFromRows(await prisma.podcastPlanContextItem.findMany({ where: { podcastGenerationRunId: run.id, workspaceId: run.workspaceId, episodeId: run.episodeId }, include: { memoryItem: true }, orderBy: [{ tokenEstimate: "asc" }, { memoryItemId: "asc" }] }));
}
function planOutput(plan: any): EpisodePlanOutput { return episodePlanSchema.parse({ centralQuestion: plan.centralQuestion, listenerStartingPoint: plan.listenerStartingPoint, listenerTakeaway: plan.listenerTakeaway, coreThesis: plan.coreThesis, tensions: plan.tensions, surprisingIdeas: plan.surprisingIdeas, misconceptions: plan.misconceptions, keyConcepts: plan.keyConcepts, candidateStories: plan.candidateStories, candidateExamples: plan.candidateExamples, openQuestions: plan.openQuestions }); }
function narrativeOutput(narrative: any): NarrativeOutput { return narrativeSchema.parse({ arcType: narrative.arcType, intellectualProgression: narrative.intellectualProgression, openingMove: narrative.openingMove, closingMove: narrative.closingMove }); }

async function retrieveContext(run: any, dependencies: ProcessPodcastDependencies, task: string, totalBudget: number, retrievalOperationKey: string): Promise<PodcastContextItem[]> {
  const perSource = Math.max(200, Math.floor(totalBudget / run.sources.length));
  const packs = [] as PodcastContextItem[][];
  for (const source of run.sources) {
    const pack = await buildBookContextForIntelligence({ workspaceId: run.workspaceId, sourceDocumentId: source.sourceDocumentId, extractionId: source.extractionId, chunkSetId: source.chunkSetId, analysisRunId: source.analysisRunId, task, tokenBudget: perSource, embeddingProvider: dependencies.embeddingProvider!, operationKey: retrievalOperationKey });
    if (pack.lineage.sourceDocumentId !== source.sourceDocumentId || pack.lineage.extractionId !== source.extractionId || pack.lineage.chunkSetId !== source.chunkSetId || pack.lineage.analysisRunId !== source.analysisRunId) throw new Error("PODCAST_GENERATION_SOURCE_LINEAGE_MISMATCH");
    packs.push(pack.items.map((item: any) => canonicalContextItem({ ...item, sourceBlockEvidenceSpans: item.evidence })));
  }
  const result = packs.flat();
  await assertBoundedContext(run, result, totalBudget);
  return result;
}

async function runPlanning(run: any, token: string, dependencies: ProcessPodcastDependencies) {
  let plan = run.plan;
  if (plan) {
    const context = await loadPersistedPlanContext(run);
    const input = { metadata: metadata(run, "EPISODE_PLANNING", PODCAST_PROVIDER_INPUT_BUDGETS.EPISODE_PLANNING), style: styleRecord(run.styleProfile), hosts: (await loadHosts(run)).map(persona), context };
    await verifyConsumedDestination(run, dependencies.provider!, "EPISODE_PLANNING", undefined, "EPISODE_PLAN", input, buildPlanningDestinationProjection(run, plan, context));
  }
  if (!plan) {
    const context = await retrieveContext(run, dependencies, `Plan a cognitive episode titled ${run.episode.title}`, PLANNING_CONTEXT_BUDGET, "PLANNING");
    // Test-only seam: the Gateway query receipt is durable, while the first
    // paid Podcast text operation has not yet been invoked.
    await dependencies.faultInjector?.("afterPlanningRetrieval", { podcastGenerationRunId: run.id });
    await renewPodcastGenerationLease(run.id, token);
    const hosts = (await loadHosts(run)).map(persona);
    const input = { metadata: metadata(run, "EPISODE_PLANNING", PODCAST_PROVIDER_INPUT_BUDGETS.EPISODE_PLANNING), style: styleRecord(run.styleProfile), hosts, context };
    const persist = async (tx: any, output: EpisodePlanOutput) => {
      await tx.podcastPlanContextItem.createMany({ data: context.map((item) => ({ podcastGenerationRunId: run.id, workspaceId: run.workspaceId, episodeId: run.episodeId, sourceDocumentId: item.sourceDocumentId, extractionId: item.extractionId, chunkSetId: item.chunkSetId, analysisRunId: item.analysisRunId, memoryItemId: item.memoryItemId, artifactId: item.artifactId, chunkId: item.chunkId, score: item.score, selectionReason: item.selectionReason, tokenEstimate: item.tokenEstimate, evidenceSpans: item.sourceBlockEvidenceSpans as any })), skipDuplicates: true });
      await tx.episodePlan.create({ data: { podcastGenerationRunId: run.id, workspaceId: run.workspaceId, episodeId: run.episodeId, ...output } });
    };
    const generated = await invokeText(run, token, dependencies, "EPISODE_PLANNING", undefined, input, () => dependencies.provider!.plan(input), episodePlanSchema.parse, "EPISODE_PLAN", persist, output => buildPlanningDestinationProjection(run, output, context));
    if (!generated.consumed) await withOwnedPodcastTransaction(run.id, token, tx => persist(tx, generated.output));
    plan = await prisma.episodePlan.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } });
    await dependencies.faultInjector?.("afterPlanning", { podcastGenerationRunId: run.id });
  }
  await advancePodcastStage(run.id, token, "EPISODE_PLANNING", "NARRATIVE_DESIGN");
  return plan;
}

async function runNarrative(run: any, token: string, dependencies: ProcessPodcastDependencies) {
  let narrative = run.narrative;
  const plan = run.plan ?? await prisma.episodePlan.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } });
  if (narrative) {
    const input = { metadata: metadata(run, "NARRATIVE_DESIGN", PODCAST_PROVIDER_INPUT_BUDGETS.NARRATIVE_DESIGN), style: styleRecord(run.styleProfile), hosts: (await loadHosts(run)).map(persona), plan: planOutput(plan) };
    await verifyConsumedDestination(run, dependencies.provider!, "NARRATIVE_DESIGN", undefined, "NARRATIVE", input, buildNarrativeDestinationProjection(run, narrative));
  }
  if (!narrative) {
    await renewPodcastGenerationLease(run.id, token);
    const input = { metadata: metadata(run, "NARRATIVE_DESIGN", PODCAST_PROVIDER_INPUT_BUDGETS.NARRATIVE_DESIGN), style: styleRecord(run.styleProfile), hosts: (await loadHosts(run)).map(persona), plan: planOutput(plan) };
    const persist = async (tx: any, output: NarrativeOutput) => { await tx.episodeNarrative.create({ data: { podcastGenerationRunId: run.id, workspaceId: run.workspaceId, episodeId: run.episodeId, ...output } }); };
    const generated = await invokeText(run, token, dependencies, "NARRATIVE_DESIGN", undefined, input, () => dependencies.provider!.designNarrative(input), narrativeSchema.parse, "NARRATIVE", persist, output => buildNarrativeDestinationProjection(run, output));
    if (!generated.consumed) await withOwnedPodcastTransaction(run.id, token, tx => persist(tx, generated.output));
    narrative = await prisma.episodeNarrative.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } });
    await dependencies.faultInjector?.("afterNarrative", { podcastGenerationRunId: run.id });
  }
  await advancePodcastStage(run.id, token, "NARRATIVE_DESIGN", "SEGMENT_OUTLINE");
  return narrative;
}

async function runOutline(run: any, token: string, dependencies: ProcessPodcastDependencies) {
  let segments = await prisma.episodeSegment.findMany({ where: { podcastGenerationRunId: run.id }, orderBy: { ordinal: "asc" } });
  if (segments.length) {
    const [plan, narrative, allAvailable] = await Promise.all([prisma.episodePlan.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), prisma.episodeNarrative.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), prisma.podcastPlanContextItem.findMany({ where: { podcastGenerationRunId: run.id }, select: { memoryItemId: true, tokenEstimate: true }, orderBy: [{ tokenEstimate: "asc" }, { memoryItemId: "asc" }] })]);
    const input = { metadata: metadata(run, "SEGMENT_OUTLINE", PODCAST_PROVIDER_INPUT_BUDGETS.SEGMENT_OUTLINE), style: styleRecord(run.styleProfile), hosts: (await loadHosts(run)).map(persona), plan: planOutput(plan), narrative: narrativeOutput(narrative), availableMemoryIds: allAvailable.filter((item) => item.tokenEstimate <= Math.floor(SEGMENT_CONTEXT_BUDGET / 2)).map((item) => item.memoryItemId) };
    await verifyConsumedDestination(run, dependencies.provider!, "SEGMENT_OUTLINE", undefined, "SEGMENT_OUTLINE", input, buildOutlineDestinationProjection(run, segments));
  }
  if (!segments.length) {
    const [plan, narrative, allAvailable] = await Promise.all([prisma.episodePlan.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), prisma.episodeNarrative.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), prisma.podcastPlanContextItem.findMany({ where: { podcastGenerationRunId: run.id }, select: { memoryItemId: true, tokenEstimate: true }, orderBy: [{ tokenEstimate: "asc" }, { memoryItemId: "asc" }] })]);
    const available = allAvailable.filter((item) => item.tokenEstimate <= Math.floor(SEGMENT_CONTEXT_BUDGET / 2));
    if (!available.length) throw new Error("PODCAST_NO_SEGMENT_FEASIBLE_CONTEXT");
    await renewPodcastGenerationLease(run.id, token);
    const input = { metadata: metadata(run, "SEGMENT_OUTLINE", PODCAST_PROVIDER_INPUT_BUDGETS.SEGMENT_OUTLINE), style: styleRecord(run.styleProfile), hosts: (await loadHosts(run)).map(persona), plan: planOutput(plan), narrative: narrativeOutput(narrative), availableMemoryIds: available.map((item) => item.memoryItemId) };
    const allowed = new Set(available.map((item) => item.memoryItemId));
    const persist = async (tx: any, output: SegmentOutlineOutput) => { if (new Set(output.segments.map((item) => item.ordinal)).size !== output.segments.length || output.segments.some((item, index) => item.ordinal !== index + 1)) throw new Error("PODCAST_SEGMENT_ORDINALS_INVALID"); if (output.segments.some((item) => [...item.requiredMemoryIds, ...item.optionalMemoryIds].some((id) => !allowed.has(id)))) throw new Error("PODCAST_SEGMENT_MEMORY_LINEAGE_INVALID"); await tx.episodeSegment.createMany({ data: output.segments.map((item) => ({ podcastGenerationRunId: run.id, workspaceId: run.workspaceId, podcastProjectId: run.podcastProjectId, episodeId: run.episodeId, ...item, disagreementReason: item.disagreementReason ?? null })) }); };
    const generated = await invokeText(run, token, dependencies, "SEGMENT_OUTLINE", undefined, input, () => dependencies.provider!.outlineSegments(input), segmentOutlineSchema.parse, "SEGMENT_OUTLINE", persist, output => buildOutlineDestinationProjection(run, output.segments));
    if (!generated.consumed) await withOwnedPodcastTransaction(run.id, token, tx => persist(tx, generated.output));
    segments = await prisma.episodeSegment.findMany({ where: { podcastGenerationRunId: run.id }, orderBy: { ordinal: "asc" } });
    await dependencies.faultInjector?.("afterOutline", { podcastGenerationRunId: run.id, segmentCount: segments.length });
  }
  await advancePodcastStage(run.id, token, "SEGMENT_OUTLINE", "SEGMENT_DRAFTING");
  return segments;
}

function segmentOutput(segment: any): SegmentOutlineOutput["segments"][number] { return { ordinal: segment.ordinal, purpose: segment.purpose, internalLabel: segment.internalLabel, targetDurationSeconds: segment.targetDurationSeconds, narrativeFunction: segment.narrativeFunction, keyQuestions: parseJsonArray<string>(segment.keyQuestions), requiredMemoryIds: parseJsonArray<string>(segment.requiredMemoryIds), optionalMemoryIds: parseJsonArray<string>(segment.optionalMemoryIds), disagreementReason: segment.disagreementReason }; }

async function loadPersistedSegmentContext(segment: any): Promise<PodcastContextItem[]> {
  const rows = await prisma.podcastSegmentContextItem.findMany({ where: { segmentId: segment.id }, include: { memoryItem: true }, orderBy: [{ score: "desc" }, { memoryItemId: "asc" }] });
  return contextFromRows(rows);
}

async function ensureSegmentContext(run: any, segment: any, token: string, dependencies: ProcessPodcastDependencies) {
  let context = await loadPersistedSegmentContext(segment);
  if (context.length) return context;
  context = await retrieveContext(run, dependencies, [segment.purpose, ...parseJsonArray<string>(segment.keyQuestions)].join("\n"), SEGMENT_CONTEXT_BUDGET, `SEGMENT_CONTEXT:${segment.id}`);
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

function expectedDraftProjection(run: any, segment: any, output: DialogueOutput, context: PodcastContextItem[], memory: any[]) {
  const memoryMap = new Map(memory.map((item: any): [string, any] => [item.id, item]));
  const utterances = output.utterances.map((item) => ({
    ...item,
    draftText: item.text,
    estimatedDurationMs: estimateSpokenDurationMs(item.text),
    evidence: item.evidence.flatMap((reference) => {
      const source = context.find((candidate) => candidate.memoryItemId === reference.memoryItemId)!;
      const memoryItem = memoryMap.get(reference.memoryItemId);
      const lineage = reference.sourceBlockId === undefined ? memoryItem?.evidence ?? [] : (memoryItem?.evidence ?? []).filter((value: any) => value.sourceBlockId === reference.sourceBlockId && value.startOffset === reference.startOffset && value.endOffset === reference.endOffset);
      const selected = item.isDirectQuote ? lineage.filter((value: any) => Boolean(value.quoteText) && item.text.includes(value.quoteText)) : lineage;
      return selected.map((value: any) => ({ sourceDocumentId: source.sourceDocumentId, extractionId: source.extractionId, chunkSetId: source.chunkSetId, analysisRunId: source.analysisRunId, memoryItemId: memoryItem.id, sourceBlockId: value.sourceBlockId, startOffset: value.startOffset, endOffset: value.endOffset, quoteText: value.quoteText, quoteHash: value.quoteHash }));
    }),
  }));
  return buildDraftDestinationProjection(run, { ...segment, status: "DRAFTED" }, utterances);
}

async function draftSegment(run: any, segment: any, token: string, dependencies: ProcessPodcastDependencies) {
  if (await prisma.podcastUtterance.count({ where: { segmentId: segment.id } })) {
    const [context, plan, narrative, hosts, utterances] = await Promise.all([loadPersistedSegmentContext(segment), prisma.episodePlan.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), prisma.episodeNarrative.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), loadHosts(run), prisma.podcastUtterance.findMany({ where: { segmentId: segment.id }, include: { evidence: true }, orderBy: { ordinal: "asc" } })]);
    const input = { metadata: metadata(run, "SEGMENT_DRAFTING", PODCAST_PROVIDER_INPUT_BUDGETS.SEGMENT_DRAFTING, segment.id), style: styleRecord(run.styleProfile), hosts: hosts.map(persona), plan: planOutput(plan), narrative: narrativeOutput(narrative), segment: segmentOutput(segment), context };
    await verifyConsumedDestination(run, dependencies.provider!, "SEGMENT_DRAFTING", segment.id, "SEGMENT_DRAFT", input, buildDraftDestinationProjection(run, segment, utterances));
    return;
  }
  const context = await ensureSegmentContext(run, segment, token, dependencies);
  const [plan, narrative, hosts] = await Promise.all([prisma.episodePlan.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), prisma.episodeNarrative.findUniqueOrThrow({ where: { podcastGenerationRunId: run.id } }), loadHosts(run)]);
  await renewPodcastGenerationLease(run.id, token);
  const input = { metadata: metadata(run, "SEGMENT_DRAFTING", PODCAST_PROVIDER_INPUT_BUDGETS.SEGMENT_DRAFTING, segment.id), style: styleRecord(run.styleProfile), hosts: hosts.map(persona), plan: planOutput(plan), narrative: narrativeOutput(narrative), segment: segmentOutput(segment), context };
  const allowedHosts = new Set(hosts.map((host) => host.id)), allowedMemory = new Set(context.map((item) => item.memoryItemId));
  const projectionMemory = await prisma.bookMemoryItem.findMany({ where: { id: { in: [...allowedMemory] } }, include: { evidence: true } });
  const persist = async (tx: any, output: DialogueOutput) => {
    if (new Set(output.utterances.map((item) => item.ordinal)).size !== output.utterances.length || output.utterances.some((item, index) => item.ordinal !== index + 1) || output.utterances.some((item) => !allowedHosts.has(item.speakerHostId) || item.evidence.some((evidence) => !allowedMemory.has(evidence.memoryItemId)))) throw new Error("PODCAST_DIALOGUE_LINEAGE_INVALID");
    const memoryIds = [...new Set(output.utterances.flatMap((item) => item.evidence.map((evidence) => evidence.memoryItemId)))];
    const memory: any[] = await tx.bookMemoryItem.findMany({ where: { id: { in: memoryIds } }, include: { evidence: true } });
    const memoryMap = new Map<string, any>(memory.map((item: any): [string, any] => [item.id, item]));
    await tx.episodeSegment.update({ where: { id: segment.id }, data: { generationAttemptCount: { increment: 1 } } });
    for (const item of output.utterances) {
      const utterance = await tx.podcastUtterance.create({ data: { segmentId: segment.id, podcastGenerationRunId: run.id, workspaceId: run.workspaceId, podcastProjectId: run.podcastProjectId, episodeId: run.episodeId, speakerHostId: item.speakerHostId, ordinal: item.ordinal, draftText: item.text, text: item.text, utteranceType: item.utteranceType, substantive: item.substantive, isDirectQuote: item.isDirectQuote, estimatedDurationMs: estimateSpokenDurationMs(item.text) } });
      for (const reference of item.evidence) {
        const source = context.find((candidate) => candidate.memoryItemId === reference.memoryItemId)!;
        const memoryItem = memoryMap.get(reference.memoryItemId);
        if (!memoryItem?.evidence.length) throw new Error("PODCAST_EVIDENCE_REQUIRED");
        const lineageEvidence = reference.sourceBlockId === undefined ? memoryItem.evidence : memoryItem.evidence.filter((evidence: any) => evidence.sourceBlockId === reference.sourceBlockId && evidence.startOffset === reference.startOffset && evidence.endOffset === reference.endOffset);
        if (!lineageEvidence.length) throw new Error("PODCAST_EVIDENCE_SPAN_LINEAGE_INVALID");
        const selectedEvidence = item.isDirectQuote ? lineageEvidence.filter((evidence: any) => Boolean(evidence.quoteText) && item.text.includes(evidence.quoteText!)) : lineageEvidence;
        if (!selectedEvidence.length) throw new Error(`PODCAST_DIRECT_QUOTE_LINEAGE_INVALID:textLength=${item.text.length}:quoteLengths=${lineageEvidence.map((evidence: any) => evidence.quoteText?.length ?? 0).join(",")}`);
        await tx.podcastUtteranceEvidence.createMany({ data: selectedEvidence.map((evidence: any) => ({ utteranceId: utterance.id, segmentId: segment.id, podcastGenerationRunId: run.id, workspaceId: run.workspaceId, sourceDocumentId: source.sourceDocumentId, extractionId: source.extractionId, chunkSetId: source.chunkSetId, analysisRunId: source.analysisRunId, memoryItemId: memoryItem.id, sourceBlockId: evidence.sourceBlockId, startOffset: evidence.startOffset, endOffset: evidence.endOffset, quoteText: evidence.quoteText, quoteHash: evidence.quoteHash })), skipDuplicates: true });
      }
    }
    await tx.episodeSegment.update({ where: { id: segment.id }, data: { status: "DRAFTED" } });
  };
  const generated = await invokeText(run, token, dependencies, "SEGMENT_DRAFTING", segment.id, input, () => dependencies.provider!.draftSegment(input), dialogueSchema.parse, "SEGMENT_DRAFT", persist, output => expectedDraftProjection(run, segment, output, context, projectionMemory));
  if (!generated.consumed) await withOwnedPodcastTransaction(run.id, token, tx => persist(tx, generated.output));
  await dependencies.faultInjector?.("afterSegmentDraft", { podcastGenerationRunId: run.id, segmentId: segment.id });
}

async function runDrafting(run: any, token: string, dependencies: ProcessPodcastDependencies) {
  const segments = await prisma.episodeSegment.findMany({ where: { podcastGenerationRunId: run.id }, orderBy: { ordinal: "asc" } });
  for (const segment of segments) await draftSegment(run, segment, token, dependencies);
  await advancePodcastStage(run.id, token, "SEGMENT_DRAFTING", "HUMANIZATION");
}

async function humanizeSegment(run: any, segment: any, token: string, dependencies: ProcessPodcastDependencies) {
  const current = await prisma.episodeSegment.findUniqueOrThrow({ where: { id: segment.id } });
  if (current.status === "HUMANIZED" || current.status === "GROUNDED") {
    const [utterances, hosts] = await Promise.all([prisma.podcastUtterance.findMany({ where: { segmentId: segment.id }, include: { evidence: true }, orderBy: { ordinal: "asc" } }), loadHosts(run)]);
    const dialogue = dialogueSchema.parse({ utterances: utterances.map((item) => ({ ordinal: item.ordinal, speakerHostId: item.speakerHostId, text: item.draftText, utteranceType: item.utteranceType, substantive: item.substantive, isDirectQuote: item.isDirectQuote, evidence: [...new Set(item.evidence.map((evidence) => evidence.memoryItemId))].map((memoryItemId) => ({ memoryItemId })) })) });
    const input = { metadata: metadata(run, "HUMANIZATION", PODCAST_PROVIDER_INPUT_BUDGETS.HUMANIZATION, segment.id), style: styleRecord(run.styleProfile), hosts: hosts.map(persona), segment: segmentOutput(segment), dialogue };
    await verifyConsumedDestination(run, dependencies.provider!, "HUMANIZATION", segment.id, "SEGMENT_HUMANIZATION", input, buildHumanizationDestinationProjection(run, current, utterances));
    return;
  }
  const utterances = await prisma.podcastUtterance.findMany({ where: { segmentId: segment.id }, include: { evidence: true }, orderBy: { ordinal: "asc" } });
  const dialogue: DialogueOutput = { utterances: utterances.map((item) => ({ ordinal: item.ordinal, speakerHostId: item.speakerHostId, text: item.text, utteranceType: item.utteranceType, substantive: item.substantive, isDirectQuote: item.isDirectQuote, evidence: [...new Set(item.evidence.map((evidence) => evidence.memoryItemId))].map((memoryItemId) => ({ memoryItemId })) })) };
  await renewPodcastGenerationLease(run.id, token);
  const input = { metadata: metadata(run, "HUMANIZATION", PODCAST_PROVIDER_INPUT_BUDGETS.HUMANIZATION, segment.id), style: styleRecord(run.styleProfile), hosts: (await loadHosts(run)).map(persona), segment: segmentOutput(segment), dialogue };
  const persist = async (tx: any, output: HumanizationOutput) => {
    const currentUtterances = await tx.podcastUtterance.findMany({ where: { segmentId: segment.id }, include: { evidence: true }, orderBy: { ordinal: "asc" } });
    if (output.utterances.length !== currentUtterances.length || output.utterances.some((item, index) => item.ordinal !== currentUtterances[index]!.ordinal)) throw new Error("PODCAST_HUMANIZATION_STRUCTURE_CHANGED");
    for (let index = 0; index < currentUtterances.length; index++) { if (currentUtterances[index]!.isDirectQuote && output.utterances[index]!.text !== currentUtterances[index]!.text) throw new Error("PODCAST_HUMANIZATION_CHANGED_QUOTE"); if ((currentUtterances[index]!.substantive || currentUtterances[index]!.evidence.length > 0) && output.utterances[index]!.text !== currentUtterances[index]!.text) throw new Error("PODCAST_HUMANIZATION_CHANGED_SUBSTANTIVE_CLAIM"); }
    for (let index = 0; index < currentUtterances.length; index++) await tx.podcastUtterance.update({ where: { id: currentUtterances[index]!.id }, data: { text: output.utterances[index]!.text, estimatedDurationMs: estimateSpokenDurationMs(output.utterances[index]!.text), humanizedAt: new Date() } });
    await tx.episodeSegment.update({ where: { id: segment.id }, data: { status: "HUMANIZED" } });
  };
  const generated = await invokeText(run, token, dependencies, "HUMANIZATION", segment.id, input, () => dependencies.provider!.humanizeSegment(input), humanizationSchema.parse, "SEGMENT_HUMANIZATION", persist, output => buildHumanizationDestinationProjection(run, { ...current, status: "HUMANIZED" }, utterances.map((item, index) => ({ ...item, text: output.utterances[index]!.text, estimatedDurationMs: estimateSpokenDurationMs(output.utterances[index]!.text), humanizedAt: true }))));
  if (!generated.consumed) await withOwnedPodcastTransaction(run.id, token, tx => persist(tx, generated.output));
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
  const token = randomUUID();
  if (!await claimPodcastGenerationRun(run.id, token)) { run = await loadRun(run.id); if (run.status === "SUCCEEDED") return run; throw new Error("PODCAST_GENERATION_ALREADY_CLAIMED"); }
  try {
    const provider = dependencies.providerForRun ? await dependencies.providerForRun({ workspaceId: run.workspaceId, podcastGenerationRunId: run.id, provider: run.provider, model: run.model }) : dependencies.provider;
    const embeddingProvider = dependencies.embeddingProviderForRun ? await dependencies.embeddingProviderForRun({ workspaceId: run.workspaceId, podcastGenerationRunId: run.id }) : dependencies.embeddingProvider;
    if (!provider || !embeddingProvider) throw new Error("PODCAST_GENERATION_PROVIDER_NOT_CONFIGURED");
    if (provider.identity.provider !== run.provider || provider.identity.model !== run.model || (provider.identity.modelVersion ?? "") !== run.modelVersionKey) throw new Error("PODCAST_PROVIDER_IDENTITY_MISMATCH");
    dependencies = { ...dependencies, provider, embeddingProvider };
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

export async function dispatchPendingPodcastGeneration(queue: { add(name: string, payload: { podcastGenerationRunId: string }, options: { jobId: string }): Promise<unknown> }, options: { aggregateIds?: string[]; topic?: string } = {}) {
  return dispatchPendingOutbox<{ podcastGenerationRunId: string }>({ topic: options.topic ?? PODCAST_GENERATION_TOPIC, queue, jobName: PODCAST_GENERATION_JOB, parse: (payload: unknown) => { const value = payload as { podcastGenerationRunId?: unknown }; if (typeof value?.podcastGenerationRunId !== "string") throw new Error("PODCAST_OUTBOX_PAYLOAD_INVALID"); return { podcastGenerationRunId: value.podcastGenerationRunId }; }, jobId: (payload: { podcastGenerationRunId: string }) => payload.podcastGenerationRunId, aggregateIds: options.aggregateIds, afterDispatch: async (tx, payload: { podcastGenerationRunId: string }, queueJobId: string) => { const run = await prisma.podcastGenerationRun.findUniqueOrThrow({ where: { id: payload.podcastGenerationRunId } }); await tx.job.update({ where: { id: run.jobId }, data: { queueJobId } }); } });
}
