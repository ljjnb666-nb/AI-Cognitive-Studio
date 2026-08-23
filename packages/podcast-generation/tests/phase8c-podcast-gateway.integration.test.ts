import { describe, expect, it } from "vitest";
import { compileStrictJsonSchema } from "@ai-cognitive/provider-gateway";
import { podcastGatewaySchemas } from "../src/gateway-provider.js";
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
});
