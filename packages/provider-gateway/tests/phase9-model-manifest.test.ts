import { describe, expect, it } from "vitest";
import { builtInProviderCatalog, parseProviderModelManifest, sanitizedProviderManifest, validateRouteManifestSelection } from "../src/index.js";

const manifest = JSON.stringify({ providers: [{ providerKey: "fixture", displayName: "Fixture", protocol: "TEST", adapterVersion: "phase9", models: [{ modelId: "text", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }, { modelId: "embed", families: ["EMBEDDING"], confidence: "VERIFIED", embeddingDimensions: 4 }, { modelId: "speech", families: ["SPEECH"], confidence: "VERIFIED", speechFormats: ["wav"] }] }] });

describe("Phase 9 model manifest", () => {
  it("exposes only safe capability metadata and gates each route by model family", () => {
    const parsed = parseProviderModelManifest(manifest);
    expect(sanitizedProviderManifest(parsed)).toEqual(expect.objectContaining({ providers: [expect.objectContaining({ providerKey: "fixture", models: expect.arrayContaining([expect.objectContaining({ modelId: "text" })]) })] }));
    expect(validateRouteManifestSelection(parsed, { routeSlot: "BOOK_CHUNK_ANALYSIS", providerKey: "fixture", protocol: "TEST", modelId: "text" }).modelId).toBe("text");
    expect(validateRouteManifestSelection(parsed, { routeSlot: "EMBEDDING", providerKey: "fixture", protocol: "TEST", modelId: "embed" }).modelId).toBe("embed");
    expect(validateRouteManifestSelection(parsed, { routeSlot: "PODCAST_TTS", providerKey: "fixture", protocol: "TEST", modelId: "speech", configuration: { outputFormat: "wav" } }).modelId).toBe("speech");
    expectErrorCode(() => validateRouteManifestSelection(parsed, { routeSlot: "SHORT_VIDEO_TTS", providerKey: "fixture", protocol: "TEST", modelId: "text" }), "CAPABILITY_MISMATCH");
    expectErrorCode(() => validateRouteManifestSelection(parsed, { routeSlot: "PODCAST_TTS", providerKey: "fixture", protocol: "TEST", modelId: "speech", configuration: { outputFormat: "mp3" } }), "CAPABILITY_MISMATCH");
  });

  it("fails closed for malformed production configuration", () => {
    expect(() => parseProviderModelManifest(undefined)).toThrow(/PROVIDER_GATEWAY_MODEL_MANIFEST_MISSING/);
    expect(() => parseProviderModelManifest("{")).toThrow(/PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID/);
  });
  it("declares MiniMax M3 for text only and Gemini Embedding 2 at 768 dimensions", () => {
    const minimax = builtInProviderCatalog.providers.find(provider => provider.providerKey === "minimax");
    expect(minimax).toMatchObject({ displayName: "MiniMax", protocol: "OPENAI_COMPATIBLE" });
    expect(minimax?.models).toEqual([{ modelId: "MiniMax-M3", families: ["TEXT_GENERATION"], confidence: "DECLARED", structuredOutput: "JSON_MODE" }]);
    const gemini = builtInProviderCatalog.providers.find(provider => provider.providerKey === "gemini");
    expect(gemini?.models.some(model => model.modelId === "text-embedding-004")).toBe(false);
    expect(gemini?.models).toContainEqual(expect.objectContaining({ modelId: "gemini-embedding-2", families: ["EMBEDDING"], embeddingDimensions: 768, configurableEmbeddingDimensions: true }));
    const qwen = builtInProviderCatalog.providers.find(provider => provider.providerKey === "qwen");
    expect(qwen?.models).toContainEqual(expect.objectContaining({ modelId: "text-embedding-v4", embeddingDimensions: 1024, configurableEmbeddingDimensions: true, embeddingDimensionOptions: [2048, 1536, 1024, 768, 512, 256, 128, 64] }));
  });
});

function expectErrorCode(work: () => unknown, code: string) { try { work(); } catch (error) { expect(error).toMatchObject({ code }); return; } throw new Error(`Expected ${code}`); }
