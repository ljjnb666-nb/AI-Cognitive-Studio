import { describe, expect, it } from "vitest";
import { compileStrictJsonSchema } from "@ai-cognitive/provider-gateway";
import { GatewayPodcastGenerationProvider, podcastGatewaySchemas } from "../src/gateway-provider.js";
import { podcastConsumerFingerprint } from "../src/consumer-fingerprint.js";
import { dialogueSchema, episodePlanSchema, humanizationSchema, narrativeSchema, segmentOutlineSchema } from "../src/types.js";
import { buildPodcastSystemInstruction } from "../src/prompts.js";

const cases = {
  EPISODE_PLANNING: { schema: episodePlanSchema, value: { centralQuestion: "Question", listenerStartingPoint: "Start", listenerTakeaway: "Takeaway", coreThesis: "Thesis", tensions: ["Tension"], surprisingIdeas: ["Idea"], misconceptions: ["Misconception"], keyConcepts: ["Concept"], candidateStories: ["Story"], candidateExamples: ["Example"], openQuestions: ["Open question"] } },
  NARRATIVE_DESIGN: { schema: narrativeSchema, value: { arcType: "Arc", intellectualProgression: ["One", "Two", "Three"], openingMove: "Open", closingMove: "Close" } },
  SEGMENT_OUTLINE: { schema: segmentOutlineSchema, value: { segments: [{ ordinal: 1, purpose: "Purpose", internalLabel: "Intro", targetDurationSeconds: 60, narrativeFunction: "Open", keyQuestions: ["Why"], requiredMemoryIds: ["memory-1"], optionalMemoryIds: [] }] } },
  SEGMENT_DRAFTING: { schema: dialogueSchema, value: { utterances: [{ ordinal: 1, speakerHostId: "host-a", text: "A substantive point.", utteranceType: "STATEMENT", substantive: true, isDirectQuote: false, evidence: [] }, { ordinal: 2, speakerHostId: "host-b", text: "A useful question?", utteranceType: "QUESTION", substantive: true, isDirectQuote: false, evidence: [] }] } },
  HUMANIZATION: { schema: humanizationSchema, value: { utterances: [{ ordinal: 1, text: "A substantive point." }, { ordinal: 2, text: "A useful question?" }] } },
} as const;

describe("Phase 8C Podcast strict provider schemas", () => {
  it("keeps a two-minute outline at its configured duration", () => {
    const instruction = buildPodcastSystemInstruction("SEGMENT_OUTLINE", { targetDurationMinutes: 2 });
    expect(instruction).toContain("2 minutes total"); expect(instruction).toContain("120 seconds"); expect(instruction).not.toContain("15 minutes");
  });
  it.each(["JSON_MODE", "STRICT_JSON_SCHEMA"] as const)("uses declared %s capability and keeps product validation", async mode => {
    const requests: Array<{ capability: unknown; text: { system: string; structuredOutput: { mode: string } } }> = [];
    let output: unknown = cases.EPISODE_PLANNING.value;
    type Runtime = ConstructorParameters<typeof GatewayPodcastGenerationProvider>[0];
    const runtime = { workspaceId: "w", userId: "u", podcastGenerationRunId: "r", provider: "zhipu", model: "glm-4.7-flash", pipelineVersion: "v1", promptVersion: "v1", structuredOutput: mode,
      repository: { findExistingTextInvocationForRequest: async () => undefined },
      gateway: { resolveSnapshot: async () => ({ providerKey: "zhipu", modelId: "glm-4.7-flash" }), execute: async (request: typeof requests[number]) => { requests.push(request); return { status: "SUCCEEDED", invocationId: "i", snapshot: { id: "s" }, response: { type: "STRUCTURED", structured: output } }; } },
    } as unknown as Runtime;
    const provider = new GatewayPodcastGenerationProvider(runtime);
    const input: Parameters<typeof provider.plan>[0] = { metadata: { stage: "EPISODE_PLANNING", episodeId: "episode", provider: "zhipu", model: "glm-4.7-flash", tokenBudget: 8000, correlationId: "c" }, style: {}, hosts: [], context: [] };
    expect(await provider.plan(input)).toEqual(output);
    expect(requests[0]!.capability).toEqual({ family: "TEXT_GENERATION", structuredOutput: mode });
    expect(requests[0]!.text.structuredOutput.mode).toBe(mode);
    if (mode === "JSON_MODE") expect(requests[0]!.text.system).toContain(JSON.stringify(podcastGatewaySchemas.EPISODE_PLANNING));
    output = { centralQuestion: "missing required fields" };
    await expect(provider.plan(input)).rejects.toThrow();
  });
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
