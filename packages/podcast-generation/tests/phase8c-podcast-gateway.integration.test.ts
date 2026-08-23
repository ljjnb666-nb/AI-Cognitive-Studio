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

});
