import { ProviderGatewayError } from "../errors.js";
import type { ProviderAdapter } from "../types.js";
import type { ProviderHttpTransport } from "./http-transport.js";
import { approvedProfile, authHeaders } from "./provider-profiles.js";
import { failureForStatus, finish, header, number, parseJson, response } from "./shared.js";
export class GeminiNativeAdapter implements ProviderAdapter {
  constructor(private readonly transport: ProviderHttpTransport) {}
  async execute(input: Parameters<ProviderAdapter["execute"]>[0]) {
    const profile = approvedProfile(input.snapshot.providerKey, input.snapshot.endpoint); if (!profile || profile.protocol !== "GEMINI_NATIVE") throw new ProviderGatewayError("NETWORK_POLICY_REJECTED"); if (!input.request.text) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE"); const text = input.request.text; const mode = text.structuredOutput?.mode;
    const structuredGeneration = mode === "STRICT_JSON_SCHEMA" ? { responseMimeType: "application/json", responseJsonSchema: text.structuredOutput?.schema } : mode === "JSON_MODE" ? { responseMimeType: "application/json" } : {};
    const generationConfig = { maxOutputTokens: text.generation?.maxOutputTokens, temperature: text.generation?.temperature, topP: text.generation?.topP, ...structuredGeneration };
    const body = { ...(text.system ? { systemInstruction: { parts: [{ text: text.system }] } } : {}), contents: text.messages.map(message => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })), generationConfig };
    const remote = await this.transport.execute({ url: `${profile.endpoint}/models/${encodeURIComponent(input.snapshot.modelId)}:generateContent`, method: "POST", headers: { "content-type": "application/json", ...authHeaders(profile.authScheme, input.credential) }, body: JSON.stringify(body), signal: input.signal }); failureForStatus(remote); const json = parseJson(remote); const candidate = Array.isArray(json.candidates) ? json.candidates[0] as Record<string, unknown> | undefined : undefined; const content = candidate?.content as Record<string, unknown> | undefined; const parts = content && Array.isArray(content.parts) ? content.parts : []; const texts = parts.filter(item => item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string").map(item => (item as Record<string, unknown>).text as string); if (!texts.length) throw new ProviderGatewayError(candidate?.finishReason === "SAFETY" ? "CONTENT_REJECTED" : "INVALID_PROVIDER_RESPONSE"); const usage = json.usageMetadata as Record<string, unknown> | undefined;
    const requestId = header(remote.headers, "x-request-id") ?? (typeof json.responseId === "string" ? json.responseId : undefined);
    return response(texts.join(""), input.snapshot.modelId, finish(candidate?.finishReason), text, usage ? { inputTokens: number(usage.promptTokenCount), outputTokens: number(usage.candidatesTokenCount), cachedInputTokens: number(usage.cachedContentTokenCount) } : undefined, requestId);
  }
}
