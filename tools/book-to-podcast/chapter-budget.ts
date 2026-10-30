/** Operator-only limits for one privately authorized Chapter I acceptance.
 * No credential or content is written to the reservation ledger. Reservations
 * are persisted BEFORE network; an ambiguous result is never retried. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProviderAdapterResolver, FetchProviderHttpTransport, ProviderAdapterFailure, ProviderGatewayError, type ProviderAdapterResolver, type ProviderHttpRequest, type ProviderHttpTransport } from "../../packages/provider-gateway/src/index.js";

export const chapterLimits = Object.freeze({ approvedCny: 0.50, textRequests: 32, textOutputTokens: 8000, embeddingRequests: 16, embeddingItems: 96, embeddingTokensPerItem: 3072, speechRequests: 24, speechCharacters: 1500 });
export const maximumPricedCny = chapterLimits.speechCharacters * 2 / 10000 + chapterLimits.embeddingItems * chapterLimits.embeddingTokensPerItem * 0.5 / 1_000_000;
// The paid alternative reserves the entire published input context per call,
// not an optimistic tokenizer estimate. Failure/missing usage never refunds it.
export const paidChapterLimits = Object.freeze({ ...chapterLimits, approvedCny: 3, textRequests: 20, textInputTokens: 200_000 });
export const maximumPaidPricedCny = maximumPricedCny + paidChapterLimits.textRequests * (paidChapterLimits.textInputTokens * 0.5 + paidChapterLimits.textOutputTokens * 3) / 1_000_000;
export const resilientChapterLimits = Object.freeze({ ...paidChapterLimits, approvedCny: 5.50, textRequests: 40 });
export const maximumResilientPricedCny = maximumPricedCny + resilientChapterLimits.textRequests * (resilientChapterLimits.textInputTokens * 0.5 + resilientChapterLimits.textOutputTokens * 3) / 1_000_000;
export const airScriptLimits = Object.freeze({ requests: 10, inputTokens: 128_000, inputCnyPerMillion: 1.2, outputCnyPerMillion: 8 });
export const maximumAirPricedCny = 2.761792 + airScriptLimits.requests * (airScriptLimits.inputTokens * airScriptLimits.inputCnyPerMillion + resilientChapterLimits.textOutputTokens * airScriptLimits.outputCnyPerMillion) / 1_000_000 + (96 - 22) * 3072 * 0.5 / 1_000_000 + 1500 * 2 / 10000;
// Proposed recovery is inert until the operator receives its separate grant.
export const citableChapterLimits = Object.freeze({ ...resilientChapterLimits, approvedCny: 6.50 });
export const citableAirScriptLimits = Object.freeze({ ...airScriptLimits, requests: 15 });
export const maximumCitablePricedCny = 4.726336 + 6 * 0.2176 + (96 - 26) * 3072 * 0.5 / 1_000_000 + 1500 * 2 / 10000;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Reservation = { ordinal: number; model: string; bodySha256: string; characters: number; embeddingItems: number; reservedCny: number };

export async function createChapterBudget(root: string, authorization: string | undefined, upstream: ProviderHttpTransport = new FetchProviderHttpTransport()): Promise<{ adapterResolver: ProviderAdapterResolver; stop(): Promise<void> }> {
  const resume = authorization === "CHAPTER_I_RESUME_429_ONCE_SAME_0.50_CNY";
  const resumePaidLater = authorization === "CHAPTER_I_FLASHX_RESUME_SECOND_TIMEOUT_ONCE_SAME_3.00_CNY";
  const citableResume = authorization === "CHAPTER_I_AIR_CITABLE_V5_ONCE_CUMULATIVE_6.50_CNY";
  const activeAirLimits = citableResume ? citableAirScriptLimits : airScriptLimits;
  const airResume = authorization === "CHAPTER_I_AIR_EVIDENCE_V4_ONCE_SAME_5.50_CNY";
  const air = citableResume || airResume || authorization === "CHAPTER_I_AIR_SCRIPT_ONCE_SAME_5.50_CNY";
  const resumeData = air || authorization === "CHAPTER_I_FLASHX_DATA_V3_ONCE_SAME_5.50_CNY";
  const resumeJson = resumeData || authorization === "CHAPTER_I_FLASHX_JSON_V2_ONCE_SAME_5.50_CNY";
  const boundedRetry = resumeJson || authorization === "CHAPTER_I_FLASHX_BOUNDED_RETRY_5.50_CNY_ONCE";
  const resumePaid = boundedRetry || resumePaidLater || authorization === "CHAPTER_I_FLASHX_RESUME_TIMEOUT_ONCE_SAME_3.00_CNY";
  const paid = resumePaid || authorization === "CHAPTER_I_FLASHX_3.00_CNY_ONCE";
  const limits = citableResume ? citableChapterLimits : boundedRetry ? resilientChapterLimits : paid ? paidChapterLimits : chapterLimits;
  if ((!resume && !paid && authorization !== "CHAPTER_I_0.50_CNY_ONCE") || (citableResume ? maximumCitablePricedCny : air ? maximumAirPricedCny : boundedRetry ? maximumResilientPricedCny : paid ? maximumPaidPricedCny : maximumPricedCny) > limits.approvedCny) throw new Error("CHAPTER_EXPLICIT_BUDGET_AUTHORIZATION_REQUIRED");
  await mkdir(root, { recursive: true });
  const ledger = join(root, "chapter-call-reservations.private.json");
  // Exclusive creation makes restarting this operator require reconciliation,
  // including after a process crash between reservation and response capture.
  const reservations: Reservation[] = [];
  if (resumePaid) {
    const prior = JSON.parse(await readFile(ledger, "utf8"));
    const expected = citableResume ? 40 : airResume ? 33 : air ? 27 : resumeData ? 24 : resumeJson ? 17 : boundedRetry ? 9 : resumePaidLater ? 7 : 3;
    const invalidReservation = (r: Reservation) => r.model === "glm-4.7-flashx" ? r.reservedCny !== 0.124 : r.model === "glm-4.5-air" ? !((airResume || citableResume) && Math.abs(r.reservedCny - 0.2176) < 1e-10) : !(resumeJson && r.model === "embedding-3" && r.embeddingItems > 0 && Math.abs(r.reservedCny - r.embeddingItems * 3072 * 0.5 / 1_000_000) < 1e-10);
    if (prior.stopped !== true || prior.limits?.approvedCny !== (resumeJson ? 5.5 : 3) || prior.reservations?.length !== expected || prior.reservations.some(invalidReservation)) throw Error("CHAPTER_PAID_RESUME_SCOPE_MISMATCH");
    if (citableResume && (prior.reservations.filter((r: Reservation) => r.model === "glm-4.5-air").length !== 9 || prior.reservations.filter((r: Reservation) => r.model === "glm-4.7-flashx").length !== 22 || prior.reservations.reduce((sum: number, r: Reservation) => sum + r.embeddingItems, 0) !== 26 || Math.abs(prior.reservations.reduce((sum: number, r: Reservation) => sum + r.reservedCny, 0) - 4.726336) > 1e-9)) throw Error("CHAPTER_PAID_RESUME_SCOPE_MISMATCH");
    for (const ordinal of citableResume ? Array.from({ length: 40 }, (_, i) => i + 1).filter(i => ![3, 7, 9, 11, 23, 26, 27].includes(i)) : airResume ? [1, 2, 4, 5, 6, 8, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 28, 29, 30, 31, 32, 33] : air ? [1, 2, 4, 5, 6, 8, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25] : resumeData ? [1, 2, 4, 5, 6, 8, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24] : resumeJson ? [1, 2, 4, 5, 6, 8, 10, 12, 13, 14, 15, 16, 17] : boundedRetry ? [1, 2, 4, 5, 6, 8] : resumePaidLater ? [1, 2, 4, 5, 6] : [1, 2]) {
      const metadata = JSON.parse(await readFile(join(root, `chapter-response-${ordinal}.meta.private.json`), "utf8"));
      if (metadata.httpStatus !== 200) throw Error("CHAPTER_PAID_RESUME_SCOPE_MISMATCH");
    }
    await writeFile(join(root, citableResume ? "chapter-air-citable-v5-authorization.private.json" : airResume ? "chapter-air-evidence-v4-authorization.private.json" : air ? "chapter-air-script-authorization.private.json" : resumeData ? "chapter-data-v3-authorization.private.json" : resumeJson ? "chapter-json-v2-authorization.private.json" : boundedRetry ? "chapter-bounded-retry-authorization.private.json" : resumePaidLater ? "chapter-paid-resume2-authorization.private.json" : "chapter-paid-resume-authorization.private.json"), JSON.stringify({ authorization, previousReservationsRetained: expected, previousTimedOutChargeUnknown: true, gatewayMaxAttempts: boundedRetry ? 2 : 1, timeoutMs: boundedRetry ? 50000 : 90000, newPromptVersion: "chapter-source-evidence-v2", podcastPromptVersion: citableResume ? "phase9-web-citable-v5" : airResume ? "phase9-web-evidence-v4" : resumeData ? "phase9-web-data-v3" : resumeJson ? "phase9-web-json-v2" : "phase9-web-v1", formatRetryApproved: resumeData, ...(air ? { scriptModel: "glm-4.5-air", airScriptLimits: activeAirLimits } : {}) }), { flag: "wx" });
    await writeFile(join(root, citableResume ? "chapter-call-reservations.eighth-attempt.private.json" : airResume ? "chapter-call-reservations.seventh-attempt.private.json" : air ? "chapter-call-reservations.sixth-attempt.private.json" : resumeData ? "chapter-call-reservations.fifth-attempt.private.json" : resumeJson ? "chapter-call-reservations.fourth-attempt.private.json" : boundedRetry ? "chapter-call-reservations.third-attempt.private.json" : resumePaidLater ? "chapter-call-reservations.second-attempt.private.json" : "chapter-call-reservations.first-attempt.private.json"), JSON.stringify(prior, null, 2), { flag: "wx" });
    reservations.push(...prior.reservations);
  } else if (resume) {
    const prior = JSON.parse(await readFile(ledger, "utf8")), metadata = JSON.parse(await readFile(join(root, "chapter-response-1.meta.private.json"), "utf8")), response = JSON.parse(await readFile(join(root, "chapter-response-1.private.json"), "utf8"));
    if (prior.stopped !== true || prior.reservations?.length !== 1 || prior.reservations[0].model !== "glm-4.7-flash" || prior.reservations[0].reservedCny !== 0 || metadata.httpStatus !== 429 || response.error?.code !== "1305") throw Error("CHAPTER_429_RESUME_SCOPE_MISMATCH");
    await writeFile(join(root, "chapter-resume-authorization.private.json"), JSON.stringify({ authorization, originalRequestId: metadata.requestId, limitsIncludeOriginalRequest: true }), { flag: "wx" });
    await writeFile(join(root, "chapter-call-reservations.first-attempt.private.json"), JSON.stringify(prior, null, 2), { flag: "wx" });
    reservations.push(...prior.reservations);
  } else await writeFile(ledger, JSON.stringify({ limits, reservations: [], stopped: false }), { flag: "wx" });
  let stopped = false;
  let halted = false;
  const persist = () => writeFile(ledger, JSON.stringify({ limits, reservations, stopped }, null, 2));
  const stop = async () => { halted = true; stopped = true; await persist(); };
  const reserve = async (request: ProviderHttpRequest) => {
    // The operator executes sequentially. Reject overlapping reservations too,
    // so a future caller cannot race read/check/write of the budget.
    if (stopped) throw new ProviderGatewayError("BUDGET_EXCEEDED");
    stopped = true;
    const body = JSON.parse(request.body) as Record<string, unknown>;
    const model = body.model, digest = hash(request.body);
    if (typeof model !== "string") throw new ProviderGatewayError("BUDGET_EXCEEDED");
    const counts = (m: string) => reservations.filter(r => r.model === m).length;
    let characters = 0, embeddingItems = 0, reservedCny = 0;
    const explicitlyApprovedTimeoutReplay = resumePaidLater && reservations.length === 7 && reservations[6]!.bodySha256 === digest && model === "glm-4.7-flashx";
    if (!boundedRetry && reservations.some(r => r.bodySha256 === digest) && !explicitlyApprovedTimeoutReplay && !(resume && reservations.length === 1 && reservations[0]!.model === "glm-4.7-flash" && body.model === "glm-4.7-flash")) throw new ProviderGatewayError("BUDGET_EXCEEDED");
    if (model === (air ? "glm-4.5-air" : paid ? "glm-4.7-flashx" : "glm-4.7-flash") && request.url === "https://open.bigmodel.cn/api/paas/v4/chat/completions") {
      if (reservations.filter(r => ["glm-4.7-flash", "glm-4.7-flashx", "glm-4.5-air"].includes(r.model)).length >= limits.textRequests || (air && counts(model) >= activeAirLimits.requests) || Buffer.byteLength(request.body) > 100_000) throw new ProviderGatewayError("BUDGET_EXCEEDED");
      body.max_tokens = Math.min(typeof body.max_tokens === "number" ? body.max_tokens : limits.textOutputTokens, limits.textOutputTokens);
      body.thinking = { type: "disabled" };
      if (paid) reservedCny = air ? (airScriptLimits.inputTokens * airScriptLimits.inputCnyPerMillion + limits.textOutputTokens * airScriptLimits.outputCnyPerMillion) / 1_000_000 : (paidChapterLimits.textInputTokens * 0.5 + limits.textOutputTokens * 3) / 1_000_000;
    } else if (model === "embedding-3" && request.url === "https://open.bigmodel.cn/api/paas/v4/embeddings") {
      const texts = body.input;
      if (!Array.isArray(texts) || texts.length < 1 || texts.length > 64 || texts.some(t => typeof t !== "string" || !t.trim() || Buffer.byteLength(t) > 3072) || counts(model) >= limits.embeddingRequests) throw new ProviderGatewayError("BUDGET_EXCEEDED");
      embeddingItems = texts.length;
      if (embeddingItems + reservations.reduce((n, r) => n + r.embeddingItems, 0) > limits.embeddingItems) throw new ProviderGatewayError("BUDGET_EXCEEDED");
      // Reserve the documented MAX input tokens, including failed requests.
      reservedCny = embeddingItems * limits.embeddingTokensPerItem * 0.5 / 1_000_000;
    } else if (model === "glm-tts" && request.url === "https://open.bigmodel.cn/api/paas/v4/audio/speech") {
      if (typeof body.input !== "string" || !["tongtong", "xiaochen"].includes(String(body.voice)) || body.speed !== 1 || body.response_format !== "wav" || counts(model) >= limits.speechRequests) throw new ProviderGatewayError("BUDGET_EXCEEDED");
      characters = body.input.length;
      if (characters < 1 || characters > 1024 || characters + reservations.reduce((n, r) => n + r.characters, 0) > limits.speechCharacters) throw new ProviderGatewayError("BUDGET_EXCEEDED");
      reservedCny = characters * 2 / 10000;
    } else throw new ProviderGatewayError("BUDGET_EXCEEDED");
    if (reservedCny + reservations.reduce((n, r) => n + r.reservedCny, 0) > limits.approvedCny) throw new ProviderGatewayError("BUDGET_EXCEEDED");
    const reservation = { ordinal: reservations.length + 1, model, bodySha256: digest, characters, embeddingItems, reservedCny };
    reservations.push(reservation);
    await persist();
    return { reservation, request: { ...request, body: JSON.stringify(body) } };
  };
  const transport: ProviderHttpTransport = {
    execute: async request => {
      const r = await reserve(request), response = await upstream.execute(r.request);
      await writeFile(join(root, `chapter-response-${r.reservation.ordinal}.private.json`), response.body);
      await saveResponseMetadata(r.reservation.ordinal, response);
      return response;
    },
    executeBinary: async request => {
      const r = await reserve(request), response = await upstream.executeBinary(r.request);
      await writeFile(join(root, `chapter-response-${r.reservation.ordinal}.private.bin`), response.bytes);
      await saveResponseMetadata(r.reservation.ordinal, response);
      return response;
    },
  };
  async function saveResponseMetadata(ordinal: number, response: { status: number; headers: Headers | Readonly<Record<string, string | undefined>> }) {
    const header = (name: string) => response.headers instanceof Headers ? response.headers.get(name) : Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
    await writeFile(join(root, `chapter-response-${ordinal}.meta.private.json`), JSON.stringify({ httpStatus: response.status, contentType: header("content-type"), requestId: header("x-request-id") }));
  }
  const resolve = createProviderAdapterResolver(transport);
  const operationAttempts = new Map<string, number>();
  return { stop, adapterResolver: input => {
    const adapter = resolve(input);
    return adapter && { execute: async wire => {
      if (air && wire.request.capability.family === "TEXT_GENERATION" && wire.request.routeSlot !== "PODCAST_SCRIPT") { await stop(); throw new ProviderAdapterFailure("BUDGET_EXCEEDED", { retryable: false }); }
      const operation = hash(wire.request.idempotencyKey), attempt = (operationAttempts.get(operation) ?? 0) + 1;
      operationAttempts.set(operation, attempt);
      if (boundedRetry && attempt > 2) { await stop(); throw new ProviderAdapterFailure("BUDGET_EXCEEDED", { retryable: false }); }
      try {
        const result = await adapter.execute(wire);
        stopped = halted; await persist(); return result;
      } catch (error) {
        const approvedFormatRetry = resumeData && wire.request.capability.family === "TEXT_GENERATION" && wire.request.text?.structuredOutput?.mode === "JSON_MODE" && wire.request.text.structuredOutput.schema !== undefined && error instanceof ProviderGatewayError && error.code === "INVALID_PROVIDER_RESPONSE";
        if (boundedRetry && attempt === 1 && error instanceof ProviderGatewayError && (["TIMEOUT", "CANCELLED", "TRANSIENT_UPSTREAM", "RATE_LIMITED"].includes(error.code) || approvedFormatRetry)) {
          // This exceptional retry policy requires a distinct, explicit user
          // grant. Every physical attempt is reserved and counted again.
          stopped = halted; await persist();
          throw new ProviderAdapterFailure(error.code, { retryable: true, remoteRequestId: error.remoteRequestId, usage: error instanceof ProviderAdapterFailure ? error.usage : undefined });
        }
        await stop();
        if (error instanceof ProviderGatewayError) throw new ProviderAdapterFailure(error.code, { retryable: false, usage: error instanceof ProviderAdapterFailure ? error.usage : undefined, remoteRequestId: error.remoteRequestId });
        throw new ProviderAdapterFailure("INVALID_PROVIDER_RESPONSE", { retryable: false });
      }
    } };
  } };
}
