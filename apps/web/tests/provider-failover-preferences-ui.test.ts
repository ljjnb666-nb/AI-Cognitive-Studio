import { describe, expect, it } from "vitest";
import {
  candidateFromFailoverChoice,
  selectedFailoverChoiceKey,
  type FailoverChoice,
} from "../components/provider-failover-preferences";

const choices: FailoverChoice[] = [
  {
    routeSlot: "EMBEDDING", connectionId: "qwen-connection", modelId: "text-embedding-v4",
    providerKey: "qwen", displayName: "Qwen", configuration: { embeddingDimensions: 1024 },
  },
  {
    routeSlot: "PODCAST_SCRIPT", connectionId: "custom-connection", modelId: "custom-model",
    providerKey: "openai-compatible", displayName: "OpenAI-compatible custom endpoint", configuration: {},
  },
];

describe("failover preference UI candidate resolution", () => {
  it("preserves the exact saved configuration when only the future enabled checkbox changes", () => {
    const saved = [{ connectionId: "qwen-connection", modelId: "text-embedding-v4", configuration: { embeddingDimensions: 256 } }];
    const selected = selectedFailoverChoiceKey(saved[0]!, choices);
    expect(candidateFromFailoverChoice(selected, "", choices, saved)).toEqual(saved[0]);
    expect(candidateFromFailoverChoice(selected, "", choices)).toEqual({
      connectionId: saved[0]!.connectionId,
      modelId: saved[0]!.modelId,
      configuration: { embeddingDimensions: 1024 },
    });
  });

  it("allows selecting a custom provider by its real model ID and preserves its saved settings", () => {
    const saved = [{ connectionId: "custom-connection", modelId: "actual-private-model-v2", configuration: { temperature: 0.2 } }];
    const selection = selectedFailoverChoiceKey(saved[0]!, choices);
    expect(selection).toBe(JSON.stringify(["custom-connection", "custom-model"]));
    expect(candidateFromFailoverChoice(selection, saved[0]!.modelId, choices, saved)).toEqual(saved[0]);
    expect(candidateFromFailoverChoice(selection, "another-model", choices, saved)).toEqual({
      connectionId: "custom-connection", modelId: "another-model", configuration: {},
    });
  });

  it("rejects empty, placeholder, whitespace and oversized custom model IDs", () => {
    const selection = JSON.stringify(["custom-connection", "custom-model"]);
    for (const invalid of ["", "  ", "custom-model", "two words", "x".repeat(201)]) {
      expect(candidateFromFailoverChoice(selection, invalid, choices)).toBeNull();
    }
    expect(candidateFromFailoverChoice(JSON.stringify(["unknown-connection", "model"]), "anything", choices)).toBeNull();
  });
});
