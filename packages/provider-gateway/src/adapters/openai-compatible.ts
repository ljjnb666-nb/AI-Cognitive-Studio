import { ProviderGatewayError } from "../errors.js";
import type { ProviderAdapter } from "../types.js";
import type { ProviderHttpTransport } from "./http-transport.js";
import { approvedProfile, authHeaders } from "./provider-profiles.js";
import { failureForStatus, finish, header, number, parseJson, response } from "./shared.js";
export class OpenAICompatibleAdapter implements ProviderAdapter {
  constructor(private readonly transport: ProviderHttpTransport) {}
  async execute(input: Parameters<ProviderAdapter["execute"]>[0]) {
    const profile = approvedProfile(input.snapshot.providerKey, "TEXT_GENERATION", input.snapshot.endpoint, input.snapshot.configuration); if (!profile || profile.protocol !== "OPENAI_COMPATIBLE") throw new ProviderGatewayError("NETWORK_POLICY_REJECTED"); if (!input.request.text) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE"); const text = input.request.text;
    const mode = text.structuredOutput?.mode; const responseFormat = mode === "STRICT_JSON_SCHEMA" ? { type: "json_schema", json_schema: { name: text.structuredOutput?.schemaName, schema: text.structuredOutput?.schema, strict: true } } : mode === "JSON_MODE" ? { type: "json_object" } : undefined;
    const body = { model: input.snapshot.modelId, messages: [...(text.system ? [{ role: "system", content: text.system }] : []), ...text.messages], max_tokens: text.generation?.maxOutputTokens, temperature: text.generation?.temperature, top_p: text.generation?.topP, response_format: responseFormat };
    const remote = await this.transport.execute({ url: profile.endpoint, method: "POST", headers: { "content-type": "application/json", ...authHeaders(profile.authScheme, input.credential) }, body: JSON.stringify(body), signal: input.signal }); failureForStatus(remote); const json = parseJson(remote); const choice = Array.isArray(json.choices) ? json.choices[0] as Record<string, unknown> | undefined : undefined; const message = choice?.message as Record<string, unknown> | undefined; if (!message || typeof message.content !== "string") throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE"); const usage = json.usage as Record<string, unknown> | undefined;
    return response(message.content, typeof json.model === "string" ? json.model : undefined, finish(choice?.finish_reason), text, usage ? { inputTokens: number(usage.prompt_tokens), outputTokens: number(usage.completion_tokens), cachedInputTokens: number((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) } : undefined, header(remote.headers, "x-request-id"));
  }
}
