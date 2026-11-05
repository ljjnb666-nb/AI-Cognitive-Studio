import { ProviderAdapterFailure, ProviderGatewayError } from "../errors.js";
import type { ProviderAdapter } from "../types.js";
import type { ProviderHttpTransport } from "./http-transport.js";
import { approvedProfile, authHeaders } from "./provider-profiles.js";
import { failureForStatus, finish, header, number, parseJson, response } from "./shared.js";
import { zhipuModerationDiagnostic } from "./zhipu-moderation-diagnostic.js";
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
    // 新任务显式选择此配置，旧快照与其他模型保持原始线上请求格式。
    const m3 = input.snapshot.providerKey === "minimax" && input.snapshot.modelId === "MiniMax-M3";
    // Independent book reviews must never silently consume the entire response
    // budget in MiniMax's default reasoning mode. A pre-existing route binding
    // may not carry minimaxM3JsonMode; the dedicated review slot is sufficient
    // to enforce thinking.disabled WITHOUT changing older analysis snapshots.
    const m3Review = m3 && input.request.routeSlot === "BOOK_SEMANTIC_REVIEW";
    if (m3Review && mode !== "JSON_MODE") throw new ProviderGatewayError("CAPABILITY_MISMATCH");
    const m3Json = m3 && mode === "JSON_MODE" &&
      (m3Review || input.snapshot.configuration.minimaxM3JsonMode === true);
    // OpenAI-compatible /chat/completions supports max_completion_tokens;
    // MiniMax's older /text/chatcompletion_v2 endpoint retains max_tokens.
    // Both count reasoning toward the cap, hence the mandatory nonthinking mode.
    const tokenCap = m3Review && profile.endpoint.endsWith("/chat/completions")
      ? { max_completion_tokens: text.generation?.maxOutputTokens }
      : { max_tokens: text.generation?.maxOutputTokens };
    const body = { model: input.snapshot.modelId, messages, ...tokenCap, ...(m3Json ? { thinking: { type: "disabled" }, reasoning_split: true } : { temperature: text.generation?.temperature, top_p: text.generation?.topP }), ...(responseFormat ? { response_format: responseFormat } : {}), ...(boundedVision ? { thinking: { type: "disabled" } } : {}) };
    const remote = await this.transport.execute({ url: profile.endpoint, method: "POST", headers: { "content-type": "application/json", ...authHeaders(profile.authScheme, input.credential) }, body: JSON.stringify(body), signal: input.signal });
    if (input.snapshot.providerKey === "zhipu" && remote.status === 400) {
      let businessCode: unknown;
      try { businessCode = (JSON.parse(remote.body) as { error?: { code?: unknown } }).error?.code; } catch { /* Keep ordinary malformed-response handling. */ }
      if (String(businessCode) === "1301") throw new ProviderAdapterFailure("CONTENT_REJECTED", { retryable: false, remoteRequestId: header(remote.headers, "x-request-id"), usage: { extra: { moderationDiagnostic: zhipuModerationDiagnostic(JSON.parse(remote.body), remote.status) } } });
    }
    failureForStatus(remote);
    const json = parseJson(remote);
    const choice = Array.isArray(json.choices) ? json.choices[0] as Record<string, unknown> | undefined : undefined;
    const message = choice?.message as Record<string, unknown> | undefined;
    const rawUsage = json.usage as Record<string, unknown> | undefined;
    const usage = rawUsage ? { inputTokens: number(rawUsage.prompt_tokens), outputTokens: number(rawUsage.completion_tokens), cachedInputTokens: number((rawUsage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) } : undefined;
    const requestId = header(remote.headers, "x-request-id") ?? (boundedVision && typeof json.request_id === "string" ? json.request_id : undefined);
    if (input.snapshot.providerKey === "zhipu" && (choice?.finish_reason === "sensitive" || choice?.finish_reason === "content_filter")) throw new ProviderAdapterFailure("CONTENT_REJECTED", { retryable: false, remoteRequestId: requestId, usage: { ...usage, extra: { moderationDiagnostic: zhipuModerationDiagnostic(json, remote.status) } } });
    if (input.snapshot.providerKey === "minimax" && (choice?.finish_reason === "content_filter" || choice?.finish_reason === "sensitive"))
      throw new ProviderAdapterFailure("CONTENT_REJECTED", { retryable: false, remoteRequestId: requestId, usage });
    try {
      if (!message || typeof message.content !== "string") throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE");
      // Even a syntactically complete JSON prefix is not a final judgement if
      // the provider stopped because of the generation limit. Keep the billed
      // usage, mark this non-retryable and never materialize a false PASS.
      if (m3 && mode === "JSON_MODE" && finish(choice?.finish_reason) === "LENGTH")
        throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE");
      return response(message.content, typeof json.model === "string" ? json.model : undefined, finish(choice?.finish_reason), text, usage, requestId);
    } catch (error) {
      if (!boundedVision && !(["zhipu", "minimax"].includes(input.snapshot.providerKey) && mode === "JSON_MODE")) throw error;
      // A billed 200 response can still be unusable JSON. Preserve reported
      // usage and non-content diagnostics; never copy page/model prose or
      // reasoning into logs or turn a malformed response into a judgement.
      throw new ProviderAdapterFailure("INVALID_PROVIDER_RESPONSE", { remoteRequestId: requestId, retryable: false, usage: { ...usage, extra: { [boundedVision ? "pdfReviewResponse" : "textStructuredResponse"]: { httpStatus: remote.status, finishReason: finish(choice?.finish_reason), contentType: typeof message?.content, contentCharacters: typeof message?.content === "string" ? message.content.length : null, reasoningCharacters: typeof message?.reasoning_content === "string" ? message.reasoning_content.length : null, reportedUsagePresent: Boolean(rawUsage) } } } });
    }
  }
}
