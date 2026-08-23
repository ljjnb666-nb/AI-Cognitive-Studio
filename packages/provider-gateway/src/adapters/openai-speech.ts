import { ProviderGatewayError } from "../errors.js";
import { validateSpeechResponse } from "../speech/validation.js";
import type { ProviderAdapter } from "../types.js";
import type { ProviderHttpTransport } from "./http-transport.js";
import { approvedProfile, authHeaders } from "./provider-profiles.js";
import { header } from "./shared.js";

type Wire = Parameters<ProviderAdapter["execute"]>[0];
export class OpenAISpeechAdapter implements ProviderAdapter {
  constructor(private readonly transport: ProviderHttpTransport) {}
  async execute(input: Wire) {
    const speech = input.request.speech;
    const profile = approvedProfile(input.snapshot.providerKey, "SPEECH", input.snapshot.endpoint, input.snapshot.configuration);
    if (!speech || !profile || profile.protocol !== "CUSTOM_SPEECH") throw new ProviderGatewayError("NETWORK_POLICY_REJECTED");
    // OpenAI's Speech endpoint supports speed and instructions, but has no pitch field.
    if (speech.voice.pitch !== 0) throw new ProviderGatewayError("CAPABILITY_MISMATCH", "OpenAI Speech does not support pitch control");
    const response = await this.transport.executeBinary({ url: profile.endpoint, method: "POST", headers: { "content-type": "application/json", ...authHeaders(profile.authScheme, input.credential) }, body: JSON.stringify({ model: input.snapshot.modelId, input: speech.text, voice: speech.voice.providerVoiceId, response_format: speech.outputFormat, speed: speech.voice.speakingRate, ...(speech.voice.style ? { instructions: speech.voice.style } : {}) }), signal: input.signal });
    if (response.status < 200 || response.status >= 300) throw new ProviderGatewayError(response.status === 401 ? "AUTHENTICATION_FAILED" : response.status === 429 ? "RATE_LIMITED" : response.status >= 500 ? "TRANSIENT_UPSTREAM" : "INVALID_PROVIDER_RESPONSE");
    const mediaType = header(response.headers, "content-type")?.split(";", 1)[0] ?? `audio/${speech.outputFormat}`;
    const result = { bytes: response.bytes, mediaType, format: speech.outputFormat, sampleRate: Number(input.snapshot.configuration.sampleRate ?? 24_000), channels: Number(input.snapshot.configuration.channels ?? 1), providerModel: input.snapshot.modelId };
    validateSpeechResponse(result, speech.outputFormat);
    return { response: result, usage: { speechInputCharacters: speech.text.length }, remoteRequestId: header(response.headers, "x-request-id") };
  }
}
