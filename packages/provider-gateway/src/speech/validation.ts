import { ProviderGatewayError } from "../errors.js";
import type { ModelCapability, SpeechInput, SpeechResponse } from "../types.js";

const maxCharacters = 4_096;
const maxResponseBytes = 64 * 1024 * 1024;

export function validateSpeechInput(input: SpeechInput, capability: ModelCapability, budget?: number): void {
  if (!input.text.trim() || input.text.length > Math.min(budget ?? maxCharacters, maxCharacters) || !input.language.trim() || !input.voice.providerVoiceId.trim() || !input.voice.voiceVersion.trim()) throw new ProviderGatewayError("CAPABILITY_MISMATCH", "Invalid speech input");
  if (!Number.isFinite(input.voice.speakingRate) || input.voice.speakingRate < 0.25 || input.voice.speakingRate > 4 || !Number.isFinite(input.voice.pitch) || input.voice.pitch < -20 || input.voice.pitch > 20) throw new ProviderGatewayError("CAPABILITY_MISMATCH", "Unsupported speech voice controls");
  if (!input.outputFormat.trim() || (capability.speechFormats && !capability.speechFormats.includes(input.outputFormat)) || (capability.languages && !capability.languages.includes(input.language))) throw new ProviderGatewayError("CAPABILITY_MISMATCH", "Speech model cannot satisfy requested format or language");
}

export function validateSpeechResponse(response: SpeechResponse, requestedFormat: string): void {
  if (!(response.bytes instanceof Uint8Array) || response.bytes.byteLength === 0 || response.bytes.byteLength > maxResponseBytes || !/^[-\w.]+\/[-\w.+]+$/.test(response.mediaType) || response.format !== requestedFormat || !Number.isSafeInteger(response.sampleRate) || response.sampleRate <= 0 || !Number.isSafeInteger(response.channels) || response.channels <= 0 || (response.durationMs !== undefined && (!Number.isFinite(response.durationMs) || response.durationMs <= 0))) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Invalid speech response");
}
