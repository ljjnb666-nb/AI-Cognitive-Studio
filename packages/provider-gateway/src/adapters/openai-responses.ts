import { approvedProfile, authHeaders } from "./provider-profiles.js";
import { failureForStatus, finish, number, parseJson, response, header } from "./shared.js";
import type { ProviderAdapter } from "../types.js";
import type { ProviderHttpTransport } from "./http-transport.js";
export class OpenAIResponsesAdapter implements ProviderAdapter {
  constructor(private readonly transport: ProviderHttpTransport) {}
  async execute(input: Parameters<ProviderAdapter["execute"]>[0]) {
    const profile = approvedProfile(input.snapshot.providerKey, input.snapshot.endpoint); if (!profile || profile.protocol !== "OPENAI_RESPONSES") throw new (await import("../errors.js")).ProviderGatewayError("NETWORK_POLICY_REJECTED"); if (!input.request.text) throw new (await import("../errors.js")).ProviderGatewayError("INVALID_PROVIDER_RESPONSE");
    const text = input.request.text; const format = text.structuredOutput?.mode === "STRICT_JSON_SCHEMA" ? { type: "json_schema", name: text.structuredOutput.schemaName, schema: text.structuredOutput.schema, strict: true } : text.structuredOutput?.mode === "JSON_MODE" ? { type: "json_object" } : { type: "text" };
    const body = { model: input.snapshot.modelId, input: [...(text.system ? [{ role: "system", content: text.system }] : []), ...text.messages.map(message => ({ role: message.role, content: message.content }))], text: { format }, max_output_tokens: text.generation?.maxOutputTokens, temperature: text.generation?.temperature, top_p: text.generation?.topP };
    const remote = await this.transport.execute({ url: profile.endpoint, method: "POST", headers: { "content-type": "application/json", ...authHeaders(profile.authScheme, input.credential) }, body: JSON.stringify(body), signal: input.signal }); failureForStatus(remote); const json = parseJson(remote); const output = Array.isArray(json.output) ? json.output : []; const message = output.find(item => item && typeof item === "object" && (item as Record<string, unknown>).type === "message") as Record<string, unknown> | undefined; const content = message && Array.isArray(message.content) ? message.content : []; const final = content.find(item => item && typeof item === "object" && (item as Record<string, unknown>).type === "output_text") as Record<string, unknown> | undefined; if (!final || typeof final.text !== "string") throw new (await import("../errors.js")).ProviderGatewayError("INVALID_PROVIDER_RESPONSE"); const usage = json.usage as Record<string, unknown> | undefined;
    const requestId = header(remote.headers, "x-request-id") ?? (typeof json._request_id === "string" ? json._request_id : undefined);
    return response(final.text, typeof json.model === "string" ? json.model : undefined, finish(json.status), text, usage ? { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cachedInputTokens: number((usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) } : undefined, requestId);
  }
}
