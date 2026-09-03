import { z } from "zod";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const nonEmpty = boundedText(512);
const unmodifiedNonEmpty = z.string().min(1).refine((value) => value.trim().length > 0, "Text must contain a non-whitespace character.");
const stringList = (maximumItems = 24, maximumLength = 512) => z.array(boundedText(maximumLength)).max(maximumItems);
export const evidenceRefSchema = z.object({
  memoryItemId: nonEmpty,
  sourceBlockId: nonEmpty.optional(),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().positive().optional(),
}).superRefine((value, context) => {
  const selectorCount = [value.sourceBlockId, value.startOffset, value.endOffset].filter((item) => item !== undefined).length;
  if (selectorCount !== 0 && selectorCount !== 3) context.addIssue({ code: "custom", message: "Evidence span selectors must be supplied together." });
  if (value.startOffset !== undefined && value.endOffset !== undefined && value.endOffset <= value.startOffset) context.addIssue({ code: "custom", message: "Evidence span offsets are invalid." });
});
export const episodePlanSchema = z.object({
  centralQuestion: boundedText(800), listenerStartingPoint: boundedText(1_200), listenerTakeaway: boundedText(1_200), coreThesis: boundedText(1_200),
  tensions: stringList(), surprisingIdeas: stringList(), misconceptions: stringList(), keyConcepts: stringList(), candidateStories: stringList(16, 1_200), candidateExamples: stringList(16, 1_200), openQuestions: stringList(24, 800),
});
export const narrativeSchema = z.object({
  arcType: boundedText(256), intellectualProgression: stringList(24, 800).min(3), openingMove: boundedText(1_200), closingMove: boundedText(1_200),
});
export const segmentOutlineSchema = z.object({ segments: z.array(z.object({
  ordinal: z.number().int().positive(),
  purpose: boundedText(800), internalLabel: boundedText(256),
  targetDurationSeconds: z.number().int().positive().max(7_200),
  narrativeFunction: boundedText(256), keyQuestions: stringList(12, 800).min(1), requiredMemoryIds: stringList(50, 256), optionalMemoryIds: stringList(50, 256), disagreementReason: z.string().trim().max(800).nullable().optional(),
})).min(1).max(24) });
export const utteranceTypeSchema = z.enum(["STATEMENT", "QUESTION", "REACTION", "CHALLENGE", "CLARIFICATION", "EXAMPLE", "TRANSITION", "CALLBACK"]);
export const dialogueSchema = z.object({ utterances: z.array(z.object({
  ordinal: z.number().int().positive(),
  speakerHostId: nonEmpty,
  text: unmodifiedNonEmpty.pipe(z.string().max(4_000)),
  utteranceType: utteranceTypeSchema,
  substantive: z.boolean(),
  isDirectQuote: z.boolean().default(false),
  evidence: z.array(evidenceRefSchema).max(20),
})).min(2).max(200) });
export const humanizationSchema = z.object({ utterances: z.array(z.object({ ordinal: z.number().int().positive(), text: unmodifiedNonEmpty.pipe(z.string().max(4_000)) }).strict()).min(2).max(200) }).strict();

export type EpisodePlanOutput = z.infer<typeof episodePlanSchema>;
export type NarrativeOutput = z.infer<typeof narrativeSchema>;
export type SegmentOutlineOutput = z.infer<typeof segmentOutlineSchema>;
export type DialogueOutput = z.infer<typeof dialogueSchema>;
export type HumanizationOutput = z.infer<typeof humanizationSchema>;
export type PodcastHostPersona = {
  id: string; displayName: string; role: string; speakingStyle: string; knowledgeStyle: string; temperament: string;
  skepticism: number; humor: number; verbosity: number; questionStyle: string; disagreementStyle: string;
  preferredSentenceLength: string; fillerPreference: string;
};
export const podcastHostPersonaSchema = z.object({ id: boundedText(256), displayName: boundedText(120), role: boundedText(400), speakingStyle: boundedText(800), knowledgeStyle: boundedText(800), temperament: boundedText(400), skepticism: z.number().min(0).max(10), humor: z.number().min(0).max(10), verbosity: z.number().min(0).max(10), questionStyle: boundedText(800), disagreementStyle: boundedText(800), preferredSentenceLength: boundedText(120), fillerPreference: boundedText(400) });
export const podcastStyleSchema = z.object({ language: boundedText(80), tone: boundedText(400), depth: z.number(), pace: z.number(), hostCount: z.number().int().min(1).max(12), targetDurationMinutes: z.number().positive().max(720), targetAudience: boundedText(800), formality: z.number(), humorLevel: z.number(), debateLevel: z.number(), storytellingLevel: z.number(), interruptionLevel: z.number(), disagreementLevel: z.number(), technicalDepth: z.number(), summaryDensity: z.number(), exampleDensity: z.number() });
export type PodcastContextItem = {
  sourceDocumentId: string; extractionId: string; chunkSetId: string; analysisRunId: string; memoryItemId: string;
  artifactId: string; chunkId?: string | null; type?: string; content: string; score: number; selectionReason: string;
  tokenEstimate: number; sourceBlockEvidenceSpans: Array<{ sourceBlockId: string; startOffset: number; endOffset: number; quoteText?: string | null }>;
};
export type ProviderMetadata = { stage: string; episodeId: string; segmentId?: string; generationAttempt?: number; provider: string; model: string; correlationId: string; tokenBudget: number };
export type PodcastTextReceipt = { operationKey: string; invocationId: string; snapshotId: string };
export type PodcastTextConsumer = { consumerKind: string; consumerKey: string; consumerFingerprint: string };
export interface PodcastGenerationProvider {
  identity: { provider: string; model: string; modelVersion?: string };
  plan(input: { metadata: ProviderMetadata; style: Record<string, unknown>; hosts: PodcastHostPersona[]; context: PodcastContextItem[] }): Promise<unknown>;
  designNarrative(input: { metadata: ProviderMetadata; style: Record<string, unknown>; hosts: PodcastHostPersona[]; plan: EpisodePlanOutput }): Promise<unknown>;
  outlineSegments(input: { metadata: ProviderMetadata; style: Record<string, unknown>; hosts: PodcastHostPersona[]; plan: EpisodePlanOutput; narrative: NarrativeOutput; availableMemoryIds: string[] }): Promise<unknown>;
  draftSegment(input: { metadata: ProviderMetadata; style: Record<string, unknown>; hosts: PodcastHostPersona[]; plan: EpisodePlanOutput; narrative: NarrativeOutput; segment: SegmentOutlineOutput["segments"][number]; context: PodcastContextItem[]; repairReasons?: string[] }): Promise<unknown>;
  humanizeSegment(input: { metadata: ProviderMetadata; style: Record<string, unknown>; hosts: PodcastHostPersona[]; segment: SegmentOutlineOutput["segments"][number]; dialogue: DialogueOutput; qualityHints?: string[] }): Promise<unknown>;
}
/** Production providers retain receipts by deterministic operation key, not response identity. */
export interface DurablePodcastGenerationProvider extends PodcastGenerationProvider {
  consumeTextResult<T>(operationKey: string, consumer: PodcastTextConsumer, materialize: (input: { tx: unknown; output: T }) => Promise<void>): Promise<"CONSUMED" | "ALREADY_CONSUMED">;
  /** Verifies a purged receipt against the destination-derived canonical identity without exposing plaintext. */
  verifyConsumedTextResult(operationKey: string, consumer: PodcastTextConsumer): Promise<"NOT_CONSUMED" | "EXACT" | "RECONCILIATION_REQUIRED">;
}
