import { describe, expect, it } from "vitest";
import { DeterministicProviderHttpTransport, OpenAISpeechAdapter, ProviderGatewayError, validateSpeechInput } from "../src/index.js";

const capability = { modelId: "gpt-4o-mini-tts", families: ["SPEECH"] as const, confidence: "VERIFIED" as const, speechFormats: ["wav"] as const, languages: ["en"] as const };
const request = { workspaceId: "workspace", routeSlot: "PODCAST_TTS" as const, correlationId: "trace", idempotencyKey: "podcast-tts:run:chunk", inputHash: "a".repeat(64), capability: { family: "SPEECH" as const, outputFormat: "wav" }, speech: { text: "hello", language: "en", voice: { providerVoiceId: "alloy", voiceVersion: "1", speakingRate: 1, pitch: 0 }, outputFormat: "wav" } };
const wire = { snapshot: { id: "snapshot", workspaceId: "workspace", routeSlot: "PODCAST_TTS" as const, correlationId: "trace", source: "WORKSPACE" as const, providerKey: "openai", protocol: "CUSTOM_SPEECH" as const, modelId: "gpt-4o-mini-tts", adapterVersion: "phase8c", capability, configuration: { sampleRate: 24_000, channels: 1 }, configurationHash: "hash", createdAt: new Date(), endpoint: "https://api.openai.com/v1/audio/speech" }, request: { ...request, requestFingerprint: "fingerprint" }, signal: new AbortController().signal, credential: "test-key" };

describe("Phase 8C speech transport boundary", () => {
  it("sends OpenAI WAV Speech as binary-safe output without fabricating unsupported pitch", async () => {
    const transport = new DeterministicProviderHttpTransport(() => ({ status: 500, headers: {}, body: "unused" }), () => ({ status: 200, headers: { "content-type": "audio/wav", "x-request-id": "speech-request" }, bytes: new Uint8Array([82, 73, 70, 70]) }));
    const result = await new OpenAISpeechAdapter(transport).execute(wire);
    expect(result).toMatchObject({ response: { format: "wav", mediaType: "audio/wav" }, usage: { speechInputCharacters: 5 }, remoteRequestId: "speech-request" });
    expect(JSON.parse(transport.calls[0]!.body)).toMatchObject({ model: "gpt-4o-mini-tts", input: "hello", voice: "alloy", response_format: "wav", speed: 1 });
    await expect(new OpenAISpeechAdapter(transport).execute({ ...wire, request: { ...wire.request, speech: { ...wire.request.speech!, voice: { ...wire.request.speech!.voice, pitch: 1 } } } })).rejects.toMatchObject({ code: "CAPABILITY_MISMATCH" });
  });
  it("fails closed on malformed semantic speech input", () => {
    expect(() => validateSpeechInput({ ...request.speech!, text: "" }, capability)).toThrow(ProviderGatewayError);
    expect(() => validateSpeechInput({ ...request.speech!, outputFormat: "mp3" }, capability)).toThrow(ProviderGatewayError);
  });
});
