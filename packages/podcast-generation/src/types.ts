import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const unmodifiedNonEmpty = z.string().min(1).refine((value) => value.trim().length > 0, "Text must contain a non-whitespace character.");
const stringList = z.array(nonEmpty).max(50);
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
  centralQuestion: nonEmpty,
  listenerStartingPoint: nonEmpty,
  listenerTakeaway: nonEmpty,
  coreThesis: nonEmpty,
  tensions: stringList,
  surprisingIdeas: stringList,
  misconceptions: stringList,
  keyConcepts: stringList,
  candidateStories: stringList,
  candidateExamples: stringList,
  openQuestions: stringList,
});
export const narrativeSchema = z.object({
  arcType: nonEmpty,
  intellectualProgression: stringList.min(3),
  openingMove: nonEmpty,
  closingMove: nonEmpty,
});
export const segmentOutlineSchema = z.object({ segments: z.array(z.object({
  ordinal: z.number().int().positive(),
  purpose: nonEmpty,
  internalLabel: nonEmpty,
  targetDurationSeconds: z.number().int().positive().max(7_200),
  narrativeFunction: nonEmpty,
  keyQuestions: stringList.min(1),
  requiredMemoryIds: stringList,
  optionalMemoryIds: stringList,
  disagreementReason: z.string().nullable().optional(),
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
export type PodcastContextItem = {
  sourceDocumentId: string; extractionId: string; chunkSetId: string; analysisRunId: string; memoryItemId: string;
  artifactId: string; chunkId?: string | null; type?: string; content: string; score: number; selectionReason: string;
  tokenEstimate: number; sourceBlockEvidenceSpans: Array<{ sourceBlockId: string; startOffset: number; endOffset: number; quoteText?: string | null }>;
};
export type ProviderMetadata = { stage: string; episodeId: string; segmentId?: string; provider: string; model: string; correlationId: string; tokenBudget: number };
export interface PodcastGenerationProvider {
  identity: { provider: string; model: string; modelVersion?: string };
  plan(input: { metadata: ProviderMetadata; style: Record<string, unknown>; hosts: PodcastHostPersona[]; context: PodcastContextItem[] }): Promise<unknown>;
  designNarrative(input: { metadata: ProviderMetadata; style: Record<string, unknown>; hosts: PodcastHostPersona[]; plan: EpisodePlanOutput }): Promise<unknown>;
  outlineSegments(input: { metadata: ProviderMetadata; style: Record<string, unknown>; hosts: PodcastHostPersona[]; plan: EpisodePlanOutput; narrative: NarrativeOutput; availableMemoryIds: string[] }): Promise<unknown>;
  draftSegment(input: { metadata: ProviderMetadata; style: Record<string, unknown>; hosts: PodcastHostPersona[]; plan: EpisodePlanOutput; narrative: NarrativeOutput; segment: SegmentOutlineOutput["segments"][number]; context: PodcastContextItem[] }): Promise<unknown>;
  humanizeSegment(input: { metadata: ProviderMetadata; style: Record<string, unknown>; hosts: PodcastHostPersona[]; segment: SegmentOutlineOutput["segments"][number]; dialogue: DialogueOutput }): Promise<unknown>;
}
