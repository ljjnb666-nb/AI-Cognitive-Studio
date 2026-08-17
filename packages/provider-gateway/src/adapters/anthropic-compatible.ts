import { ProviderGatewayError } from "../errors.js";
import type { ProviderAdapter } from "../types.js";
import type { ProviderHttpTransport } from "./http-transport.js";
import { approvedProfile, authHeaders } from "./provider-profiles.js";
import { failureForStatus, finish, header, number, parseJson, response } from "./shared.js";
export class AnthropicCompatibleAdapter implements ProviderAdapter {
  constructor(private readonly transport: ProviderHttpTransport) {}
  async execute(input: Parameters<ProviderAdapter["execute"]>[0]) {
    const profile = approvedProfile(input.snapshot.providerKey, "TEXT_GENERATION", input.snapshot.endpoint); if (!profile || profile.protocol !== "ANTHROPIC_COMPATIBLE") throw new ProviderGatewayError("NETWORK_POLICY_REJECTED"); if (!input.request.text) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE"); const text = input.request.text;
    const output_config = text.structuredOutput?.mode === "STRICT_JSON_SCHEMA" ? { format: { type: "json_schema", schema: text.structuredOutput.schema } } : undefined;
    const body = { model: input.snapshot.modelId, system: text.system, messages: text.messages, max_tokens: text.generation?.maxOutputTokens ?? 4096, temperature: text.generation?.temperature, top_p: text.generation?.topP, output_config };
    const remote = await this.transport.execute({ url: profile.endpoint, method: "POST", headers: { "content-type": "application/json", "anthropic-version": profile.anthropicVersion!, ...authHeaders(profile.authScheme, input.credential) }, body: JSON.stringify(body), signal: input.signal }); failureForStatus(remote); const json = parseJson(remote); const block = Array.isArray(json.content) ? json.content.find(item => item && typeof item === "object" && (item as Record<string, unknown>).type === "text") as Record<string, unknown> | undefined : undefined; if (!block || typeof block.text !== "string") throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE"); const usage = json.usage as Record<string, unknown> | undefined;
    return response(block.text, typeof json.model === "string" ? json.model : undefined, finish(json.stop_reason), text, usage ? { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cachedInputTokens: number(usage.cache_read_input_tokens) } : undefined, header(remote.headers, "request-id"));
  }
}
