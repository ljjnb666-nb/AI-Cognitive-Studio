import { describe, expect, it } from "vitest";
import { compileStrictJsonSchema } from "@ai-cognitive/provider-gateway";
import { podcastGatewaySchemas } from "../src/gateway-provider.js";
import { podcastConsumerFingerprint } from "../src/consumer-fingerprint.js";
import { dialogueSchema, episodePlanSchema, humanizationSchema, narrativeSchema, segmentOutlineSchema } from "../src/types.js";

const cases = {
  EPISODE_PLANNING: { schema: episodePlanSchema, value: { centralQuestion: "Question", listenerStartingPoint: "Start", listenerTakeaway: "Takeaway", coreThesis: "Thesis", tensions: ["Tension"], surprisingIdeas: ["Idea"], misconceptions: ["Misconception"], keyConcepts: ["Concept"], candidateStories: ["Story"], candidateExamples: ["Example"], openQuestions: ["Open question"] } },
  NARRATIVE_DESIGN: { schema: narrativeSchema, value: { arcType: "Arc", intellectualProgression: ["One", "Two", "Three"], openingMove: "Open", closingMove: "Close" } },
  SEGMENT_OUTLINE: { schema: segmentOutlineSchema, value: { segments: [{ ordinal: 1, purpose: "Purpose", internalLabel: "Intro", targetDurationSeconds: 60, narrativeFunction: "Open", keyQuestions: ["Why"], requiredMemoryIds: ["memory-1"], optionalMemoryIds: [] }] } },
  SEGMENT_DRAFTING: { schema: dialogueSchema, value: { utterances: [{ ordinal: 1, speakerHostId: "host-a", text: "A substantive point.", utteranceType: "STATEMENT", substantive: true, isDirectQuote: false, evidence: [] }, { ordinal: 2, speakerHostId: "host-b", text: "A useful question?", utteranceType: "QUESTION", substantive: true, isDirectQuote: false, evidence: [] }] } },
  HUMANIZATION: { schema: humanizationSchema, value: { utterances: [{ ordinal: 1, text: "A substantive point." }, { ordinal: 2, text: "A useful question?" }] } },
} as const;

describe("Phase 8C Podcast strict provider schemas", () => {
  for (const [stage, testCase] of Object.entries(cases)) {
    it(`${stage} keeps Zod and strict provider schema in parity`, () => {
      const schema = podcastGatewaySchemas[stage as keyof typeof podcastGatewaySchemas];
      const validate = compileStrictJsonSchema(schema);
      expect(schema).toMatchObject({ type: "object", additionalProperties: false });
      expect(schema.properties).toBeTypeOf("object");
      expect(Object.keys(schema.properties as object)).toEqual(expect.arrayContaining(schema.required as string[]));
      expect(testCase.schema.safeParse(testCase.value).success).toBe(true);
      expect(validate(testCase.value)).toBe(true);

      const unexpected = { ...testCase.value, unexpectedGatewayField: "must fail" };
      expect(validate(unexpected)).toBe(false);
      expect(testCase.schema.safeParse(unexpected).success).toBe(stage !== "HUMANIZATION");
    });
  }

  it("uses one order-stable canonical consumer identity for persisted retrieval sets", () => {
    const run = { workspaceId: "workspace", id: "run", generationIdentityHash: "identity", sources: [{ sourceDocumentId: "source", extractionId: "extraction", chunkSetId: "chunks", analysisRunId: "analysis" }], styleProfileId: "style", styleProfileVersion: "1", hostConfigurationVersion: "1", pipelineVersion: "pipeline", promptVersion: "prompt" };
    const common = { run, stage: "EPISODE_PLANNING", destination: "EPISODE_PLAN", output: cases.EPISODE_PLANNING.value };
    const a = podcastConsumerFingerprint({ ...common, input: { context: [{ memoryItemId: "b" }, { memoryItemId: "a" }], hosts: [{ id: "h2" }, { id: "h1" }] } });
    const b = podcastConsumerFingerprint({ ...common, input: { hosts: [{ id: "h1" }, { id: "h2" }], context: [{ memoryItemId: "a" }, { memoryItemId: "b" }] } });
    expect(a).toBe(b);
  });

  it("changes the canonical identity when a durable destination is incomplete or mutated", () => {
    const run = { workspaceId: "workspace", id: "run", generationIdentityHash: "identity", sources: [], styleProfileId: "style", styleProfileVersion: "1", hostConfigurationVersion: "1", pipelineVersion: "pipeline", promptVersion: "prompt" };
    const base = { run, stage: "SEGMENT_OUTLINE", destination: "SEGMENT_OUTLINE", input: { availableMemoryIds: ["memory"] } };
    const exact = podcastConsumerFingerprint({ ...base, output: cases.SEGMENT_OUTLINE.value });
    const missing = podcastConsumerFingerprint({ ...base, output: { segments: [] } });
    const changed = podcastConsumerFingerprint({ ...base, output: { segments: [{ ...cases.SEGMENT_OUTLINE.value.segments[0], purpose: "changed" }] } });
    expect(new Set([exact, missing, changed]).size).toBe(3);
  });

  // These are deliberately individual regression tests: a consumed tombstone
  // may be accepted only for the exact durable destination, never for a
  // partially missing or silently edited projection of it.
  const destinationCases = [
    ["planning exact", "EPISODE_PLANNING", "EPISODE_PLAN", cases.EPISODE_PLANNING.value, cases.EPISODE_PLANNING.value, true],
    ["planning missing plan", "EPISODE_PLANNING", "EPISODE_PLAN", cases.EPISODE_PLANNING.value, undefined, false],
    ["planning missing context", "EPISODE_PLANNING", "EPISODE_PLAN", cases.EPISODE_PLANNING.value, { ...cases.EPISODE_PLANNING.value, centralQuestion: "context removed" }, false],
    ["planning mutated plan", "EPISODE_PLANNING", "EPISODE_PLAN", cases.EPISODE_PLANNING.value, { ...cases.EPISODE_PLANNING.value, coreThesis: "mutated" }, false],
    ["narrative exact", "NARRATIVE_DESIGN", "NARRATIVE", cases.NARRATIVE_DESIGN.value, cases.NARRATIVE_DESIGN.value, true],
    ["narrative mutated", "NARRATIVE_DESIGN", "NARRATIVE", cases.NARRATIVE_DESIGN.value, { ...cases.NARRATIVE_DESIGN.value, closingMove: "mutated" }, false],
    ["outline exact", "SEGMENT_OUTLINE", "SEGMENT_OUTLINE", cases.SEGMENT_OUTLINE.value, cases.SEGMENT_OUTLINE.value, true],
    ["outline deleted row", "SEGMENT_OUTLINE", "SEGMENT_OUTLINE", cases.SEGMENT_OUTLINE.value, { segments: [] }, false],
    ["outline extra row", "SEGMENT_OUTLINE", "SEGMENT_OUTLINE", cases.SEGMENT_OUTLINE.value, { segments: [...cases.SEGMENT_OUTLINE.value.segments, { ...cases.SEGMENT_OUTLINE.value.segments[0], ordinal: 2 }] }, false],
    ["outline mutated ordinal", "SEGMENT_OUTLINE", "SEGMENT_OUTLINE", cases.SEGMENT_OUTLINE.value, { segments: [{ ...cases.SEGMENT_OUTLINE.value.segments[0], ordinal: 2 }] }, false],
    ["outline mutated content", "SEGMENT_OUTLINE", "SEGMENT_OUTLINE", cases.SEGMENT_OUTLINE.value, { segments: [{ ...cases.SEGMENT_OUTLINE.value.segments[0], purpose: "mutated" }] }, false],
    ["outline mutated memory lineage", "SEGMENT_OUTLINE", "SEGMENT_OUTLINE", cases.SEGMENT_OUTLINE.value, { segments: [{ ...cases.SEGMENT_OUTLINE.value.segments[0], requiredMemoryIds: ["other"] }] }, false],
    ["draft exact", "SEGMENT_DRAFTING", "SEGMENT_DRAFT", cases.SEGMENT_DRAFTING.value, cases.SEGMENT_DRAFTING.value, true],
    ["draft deleted utterance", "SEGMENT_DRAFTING", "SEGMENT_DRAFT", cases.SEGMENT_DRAFTING.value, { utterances: [cases.SEGMENT_DRAFTING.value.utterances[0]] }, false],
    ["draft mutated text", "SEGMENT_DRAFTING", "SEGMENT_DRAFT", cases.SEGMENT_DRAFTING.value, { utterances: [{ ...cases.SEGMENT_DRAFTING.value.utterances[0], text: "mutated" }, cases.SEGMENT_DRAFTING.value.utterances[1]] }, false],
    ["draft changed speaker", "SEGMENT_DRAFTING", "SEGMENT_DRAFT", cases.SEGMENT_DRAFTING.value, { utterances: [{ ...cases.SEGMENT_DRAFTING.value.utterances[0], speakerHostId: "other" }, cases.SEGMENT_DRAFTING.value.utterances[1]] }, false],
    ["draft deleted evidence", "SEGMENT_DRAFTING", "SEGMENT_DRAFT", { ...cases.SEGMENT_DRAFTING.value, utterances: [{ ...cases.SEGMENT_DRAFTING.value.utterances[0], evidence: [{ memoryItemId: "memory-1" }] }, cases.SEGMENT_DRAFTING.value.utterances[1]] }, cases.SEGMENT_DRAFTING.value, false],
    ["draft mutated evidence lineage", "SEGMENT_DRAFTING", "SEGMENT_DRAFT", { ...cases.SEGMENT_DRAFTING.value, utterances: [{ ...cases.SEGMENT_DRAFTING.value.utterances[0], evidence: [{ memoryItemId: "memory-1", sourceBlockId: "block", startOffset: 0, endOffset: 1 }] }, cases.SEGMENT_DRAFTING.value.utterances[1]] }, { ...cases.SEGMENT_DRAFTING.value, utterances: [{ ...cases.SEGMENT_DRAFTING.value.utterances[0], evidence: [{ memoryItemId: "memory-1", sourceBlockId: "block", startOffset: 1, endOffset: 2 }] }, cases.SEGMENT_DRAFTING.value.utterances[1]] }, false],
    ["humanization exact", "HUMANIZATION", "SEGMENT_HUMANIZATION", cases.HUMANIZATION.value, cases.HUMANIZATION.value, true],
    ["humanization mutated final text", "HUMANIZATION", "SEGMENT_HUMANIZATION", cases.HUMANIZATION.value, { utterances: [{ ordinal: 1, text: "mutated" }, cases.HUMANIZATION.value.utterances[1]] }, false],
    ["humanization mutated duration projection", "HUMANIZATION", "SEGMENT_HUMANIZATION", { ...cases.HUMANIZATION.value, duration: 1 }, { ...cases.HUMANIZATION.value, duration: 2 }, false],
    ["humanization invalid segment status projection", "HUMANIZATION", "SEGMENT_HUMANIZATION", { ...cases.HUMANIZATION.value, status: "HUMANIZED" }, { ...cases.HUMANIZATION.value, status: "DRAFTED" }, false],
    ["humanization mutated draft text projection", "HUMANIZATION", "SEGMENT_HUMANIZATION", { ...cases.HUMANIZATION.value, draftText: "draft-a" }, { ...cases.HUMANIZATION.value, draftText: "draft-b" }, false],
    ["humanization mutated evidence projection", "HUMANIZATION", "SEGMENT_HUMANIZATION", { ...cases.HUMANIZATION.value, evidence: ["memory-1"] }, { ...cases.HUMANIZATION.value, evidence: ["memory-2"] }, false],
  ] as const;
  it.each(destinationCases)("consumed destination verifier %s", (_label, stage, destination, expected, actual, exact) => {
    const run = { workspaceId: "workspace", id: "run", generationIdentityHash: "identity", sources: [], styleProfileId: "style", styleProfileVersion: "1", hostConfigurationVersion: "1", pipelineVersion: "pipeline", promptVersion: "prompt" };
    const input = { stage, destination, lineage: ["source", "memory"] };
    const expectedFingerprint = podcastConsumerFingerprint({ run, stage, destination, input, output: expected });
    const actualFingerprint = actual === undefined ? undefined : podcastConsumerFingerprint({ run, stage, destination, input, output: actual });
    expect(actualFingerprint === expectedFingerprint).toBe(exact);
  });
});
