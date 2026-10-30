import { ProviderAdapterFailure, ProviderGatewayError } from "../errors.js";
import type { ProviderAdapter } from "../types.js";
import type { ProviderHttpTransport } from "./http-transport.js";
import { approvedProfile, authHeaders } from "./provider-profiles.js";
import { failureForStatus, finish, header, number, parseJson, response } from "./shared.js";
export class OpenAICompatibleAdapter implements ProviderAdapter {
  constructor(private readonly transport: ProviderHttpTransport) {}
  async execute(input: Parameters<ProviderAdapter["execute"]>[0]) {
    const profile = approvedProfile(input.snapshot.providerKey, "TEXT_GENERATION", input.snapshot.endpoint, input.snapshot.configuration); if (!profile || profile.protocol !== "OPENAI_COMPATIBLE") throw new ProviderGatewayError("NETWORK_POLICY_REJECTED"); if (!input.request.text) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE"); const text = input.request.text;
    const mode = text.structuredOutput?.mode;
    // MiniMax M3 is deliberately prompt-and-validate only: do not send an
    // OpenAI-specific response_format field that its documented endpoint does
    // not promise to support.  The caller still parses and domain-validates the
    // final assistant content before publication.
    const responseFormat = input.snapshot.providerKey === "minimax" ? undefined : mode === "STRICT_JSON_SCHEMA" ? { type: "json_schema", json_schema: { name: text.structuredOutput?.schemaName, schema: text.structuredOutput?.schema, strict: true } } : mode === "JSON_MODE" ? { type: "json_object" } : undefined;
    const imageMessages = text.messages.filter(message => message.image);
    if (imageMessages.length > 0 && (
      input.request.routeSlot !== "PDF_VISUAL_STRUCTURE" ||
      input.snapshot.providerKey !== "zhipu" ||
      input.snapshot.capability.visionInput !== true ||
      input.request.capability.visionInput !== true
    )) throw new ProviderGatewayError("CAPABILITY_MISMATCH");
    const messages = [
      ...(text.system ? [{ role: "system", content: text.system }] : []),
      ...text.messages.map(message => ({
        role: message.role,
        content: message.image ? [
          { type: "text", text: message.content },
          { type: "image_url", image_url: { url: "data:image/png;base64," + message.image.dataBase64 } },
        ] : message.content,
      })),
    ];
    // GLM-4.6V defaults to thinking enabled. This bounded page review needs
    // its one 1600-token response for the auditable JSON judgement. Official
    // ChatThinking supports disabled; leave all other providers/routes alone.
    const boundedVision = input.snapshot.providerKey === "zhipu" && input.snapshot.modelId === "glm-4.6v" && input.request.routeSlot === "PDF_VISUAL_STRUCTURE";
    const body = { model: input.snapshot.modelId, messages, max_tokens: text.generation?.maxOutputTokens, temperature: text.generation?.temperature, top_p: text.generation?.topP, ...(responseFormat ? { response_format: responseFormat } : {}), ...(boundedVision ? { thinking: { type: "disabled" } } : {}) };
    const remote = await this.transport.execute({ url: profile.endpoint, method: "POST", headers: { "content-type": "application/json", ...authHeaders(profile.authScheme, input.credential) }, body: JSON.stringify(body), signal: input.signal });
    failureForStatus(remote);
    const json = parseJson(remote);
    const choice = Array.isArray(json.choices) ? json.choices[0] as Record<string, unknown> | undefined : undefined;
    const message = choice?.message as Record<string, unknown> | undefined;
    const rawUsage = json.usage as Record<string, unknown> | undefined;
    const usage = rawUsage ? { inputTokens: number(rawUsage.prompt_tokens), outputTokens: number(rawUsage.completion_tokens), cachedInputTokens: number((rawUsage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) } : undefined;
    const requestId = header(remote.headers, "x-request-id") ?? (boundedVision && typeof json.request_id === "string" ? json.request_id : undefined);
    try {
      if (!message || typeof message.content !== "string") throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE");
      return response(message.content, typeof json.model === "string" ? json.model : undefined, finish(choice?.finish_reason), text, usage, requestId);
    } catch (error) {
      if (!boundedVision && !(input.snapshot.providerKey === "zhipu" && mode === "JSON_MODE")) throw error;
      // A billed 200 response can still be unusable JSON. Preserve reported
      // usage and non-content diagnostics; never copy page/model prose or
      // reasoning into logs or turn a malformed response into a judgement.
      throw new ProviderAdapterFailure("INVALID_PROVIDER_RESPONSE", { remoteRequestId: requestId, retryable: false, usage: { ...usage, extra: { [boundedVision ? "pdfReviewResponse" : "textStructuredResponse"]: { httpStatus: remote.status, finishReason: finish(choice?.finish_reason), contentType: typeof message?.content, contentCharacters: typeof message?.content === "string" ? message.content.length : null, reasoningCharacters: typeof message?.reasoning_content === "string" ? message.reasoning_content.length : null, reportedUsagePresent: Boolean(rawUsage) } } } });
    }
  }
}
