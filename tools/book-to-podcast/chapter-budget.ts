/** Operator-only limits for one privately authorized Chapter I acceptance.
 * No credential or content is written to the reservation ledger. Reservations
 * are persisted BEFORE network; an ambiguous result is never retried. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProviderAdapterResolver, FetchProviderHttpTransport, ProviderAdapterFailure, ProviderGatewayError, type ProviderAdapterResolver, type ProviderHttpRequest, type ProviderHttpTransport } from "../../packages/provider-gateway/src/index.js";

export const chapterLimits = Object.freeze({ approvedCny: 0.50, textRequests: 32, textOutputTokens: 8000, embeddingRequests: 16, embeddingItems: 96, embeddingTokensPerItem: 3072, speechRequests: 24, speechCharacters: 1500 });
export const maximumPricedCny = chapterLimits.speechCharacters * 2 / 10000 + chapterLimits.embeddingItems * chapterLimits.embeddingTokensPerItem * 0.5 / 1_000_000;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Reservation = { ordinal: number; model: string; bodySha256: string; characters: number; embeddingItems: number; reservedCny: number };

export async function createChapterBudget(root: string, authorization: string | undefined, upstream: ProviderHttpTransport = new FetchProviderHttpTransport()): Promise<{ adapterResolver: ProviderAdapterResolver; stop(): Promise<void> }> {
  const resume = authorization === "CHAPTER_I_RESUME_429_ONCE_SAME_0.50_CNY";
  if ((!resume && authorization !== "CHAPTER_I_0.50_CNY_ONCE") || maximumPricedCny > chapterLimits.approvedCny) throw new Error("CHAPTER_EXPLICIT_BUDGET_AUTHORIZATION_REQUIRED");
  await mkdir(root, { recursive: true });
  const ledger = join(root, "chapter-call-reservations.private.json");
  // Exclusive creation makes restarting this operator require reconciliation,
  // including after a process crash between reservation and response capture.
  const reservations: Reservation[] = [];
  if (resume) {
    const prior = JSON.parse(await readFile(ledger, "utf8")), metadata = JSON.parse(await readFile(join(root, "chapter-response-1.meta.private.json"), "utf8")), response = JSON.parse(await readFile(join(root, "chapter-response-1.private.json"), "utf8"));
    if (prior.stopped !== true || prior.reservations?.length !== 1 || prior.reservations[0].model !== "glm-4.7-flash" || prior.reservations[0].reservedCny !== 0 || metadata.httpStatus !== 429 || response.error?.code !== "1305") throw Error("CHAPTER_429_RESUME_SCOPE_MISMATCH");
    await writeFile(join(root, "chapter-resume-authorization.private.json"), JSON.stringify({ authorization, originalRequestId: metadata.requestId, limitsIncludeOriginalRequest: true }), { flag: "wx" });
    await writeFile(join(root, "chapter-call-reservations.first-attempt.private.json"), JSON.stringify(prior, null, 2), { flag: "wx" });
    reservations.push(...prior.reservations);
  } else await writeFile(ledger, JSON.stringify({ limits: chapterLimits, reservations: [], stopped: false }), { flag: "wx" });
  let stopped = false;
  let halted = false;
  const persist = () => writeFile(ledger, JSON.stringify({ limits: chapterLimits, reservations, stopped }, null, 2));
  const stop = async () => { halted = true; stopped = true; await persist(); };
  const reserve = async (request: ProviderHttpRequest) => {
    // The operator executes sequentially. Reject overlapping reservations too,
    // so a future caller cannot race read/check/write of the budget.
    if (stopped) throw new ProviderGatewayError("BUDGET_EXCEEDED");
    stopped = true;
    const body = JSON.parse(request.body) as Record<string, unknown>;
    const model = body.model, digest = hash(request.body);
    const counts = (m: string) => reservations.filter(r => r.model === m).length;
    let characters = 0, embeddingItems = 0, reservedCny = 0;
    if (reservations.some(r => r.bodySha256 === digest) && !(resume && reservations.length === 1 && reservations[0]!.model === "glm-4.7-flash" && body.model === "glm-4.7-flash")) throw new ProviderGatewayError("BUDGET_EXCEEDED");
    if (model === "glm-4.7-flash" && request.url === "https://open.bigmodel.cn/api/paas/v4/chat/completions") {
      if (counts(model) >= chapterLimits.textRequests || Buffer.byteLength(request.body) > 100_000) throw new ProviderGatewayError("BUDGET_EXCEEDED");
      body.max_tokens = Math.min(typeof body.max_tokens === "number" ? body.max_tokens : chapterLimits.textOutputTokens, chapterLimits.textOutputTokens);
      body.thinking = { type: "disabled" };
    } else if (model === "embedding-3" && request.url === "https://open.bigmodel.cn/api/paas/v4/embeddings") {
      const texts = body.input;
      if (!Array.isArray(texts) || texts.length < 1 || texts.length > 64 || texts.some(t => typeof t !== "string" || !t.trim() || Buffer.byteLength(t) > 3072) || counts(model) >= chapterLimits.embeddingRequests) throw new ProviderGatewayError("BUDGET_EXCEEDED");
      embeddingItems = texts.length;
      if (embeddingItems + reservations.reduce((n, r) => n + r.embeddingItems, 0) > chapterLimits.embeddingItems) throw new ProviderGatewayError("BUDGET_EXCEEDED");
      // Reserve the documented MAX input tokens, including failed requests.
      reservedCny = embeddingItems * chapterLimits.embeddingTokensPerItem * 0.5 / 1_000_000;
    } else if (model === "glm-tts" && request.url === "https://open.bigmodel.cn/api/paas/v4/audio/speech") {
      if (typeof body.input !== "string" || !["tongtong", "xiaochen"].includes(String(body.voice)) || body.speed !== 1 || body.response_format !== "wav" || counts(model) >= chapterLimits.speechRequests) throw new ProviderGatewayError("BUDGET_EXCEEDED");
      characters = body.input.length;
      if (characters < 1 || characters > 1024 || characters + reservations.reduce((n, r) => n + r.characters, 0) > chapterLimits.speechCharacters) throw new ProviderGatewayError("BUDGET_EXCEEDED");
      reservedCny = characters * 2 / 10000;
    } else throw new ProviderGatewayError("BUDGET_EXCEEDED");
    if (reservedCny + reservations.reduce((n, r) => n + r.reservedCny, 0) > chapterLimits.approvedCny) throw new ProviderGatewayError("BUDGET_EXCEEDED");
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
  return { stop, adapterResolver: input => {
    const adapter = resolve(input);
    return adapter && { execute: async wire => {
      try {
        const result = await adapter.execute(wire);
        stopped = halted; await persist(); return result;
      } catch (error) {
        await stop();
        if (error instanceof ProviderGatewayError) throw new ProviderAdapterFailure(error.code, { retryable: false, usage: error instanceof ProviderAdapterFailure ? error.usage : undefined, remoteRequestId: error.remoteRequestId });
        throw new ProviderAdapterFailure("INVALID_PROVIDER_RESPONSE", { retryable: false });
      }
    } };
  } };
}
