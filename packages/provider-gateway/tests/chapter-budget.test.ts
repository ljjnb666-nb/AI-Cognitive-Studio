import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createChapterBudget, maximumPricedCny } from "../../../tools/book-to-podcast/chapter-budget.js";
import { builtInProviderCatalog, DeterministicProviderHttpTransport, type ProviderAdapter } from "../src/index.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }); });
async function root() { const value = await mkdtemp(join(tmpdir(), "chapter-budget-")); roots.push(value); return value; }
const wire = (): Parameters<ProviderAdapter["execute"]>[0] => ({ snapshot: { id: "s", workspaceId: "w", routeSlot: "EMBEDDING", correlationId: "c", source: "WORKSPACE", providerKey: "zhipu", protocol: "OPENAI_EMBEDDINGS", endpoint: "https://open.bigmodel.cn/api/paas/v4/embeddings", modelId: "embedding-3", adapterVersion: "builtin-v1", capability: builtInProviderCatalog.providers.find(p => p.providerKey === "zhipu")!.models.find(m => m.modelId === "embedding-3")!, configuration: { embeddingDimensions: 256 }, configurationHash: "h", createdAt: new Date() }, request: { workspaceId: "w", routeSlot: "EMBEDDING", correlationId: "c", idempotencyKey: "i", inputHash: "h", requestFingerprint: "f", capability: { family: "EMBEDDING" }, embedding: { texts: ["first"], purpose: "DOCUMENT" } }, signal: new AbortController().signal, credential: "synthetic-secret" });
it("requires the exact separate grant and never reopens an existing reservation ledger", async () => {
  const path = await root();
  await expect(createChapterBudget(path, undefined)).rejects.toThrow("AUTHORIZATION_REQUIRED");
  await createChapterBudget(path, "CHAPTER_I_0.50_CNY_ONCE");
  await expect(createChapterBudget(path, "CHAPTER_I_0.50_CNY_ONCE")).rejects.toMatchObject({ code: "EEXIST" });
  expect(maximumPricedCny).toBeCloseTo(0.447456); expect(maximumPricedCny).toBeLessThan(0.50);
});
it("persists reservations before network and bounds aggregate embedding items and requests", async () => {
  const path = await root();
  const upstream: DeterministicProviderHttpTransport = new DeterministicProviderHttpTransport(async request => {
    const ledger = JSON.parse(await readFile(join(path, "chapter-call-reservations.private.json"), "utf8"));
    expect(ledger.stopped).toBe(true); expect(ledger.reservations.length).toBe(upstream.calls.length);
    const body = JSON.parse(request.body);
    return { status: 200, headers: {}, body: JSON.stringify({ model: body.model, data: body.input.map((_: string, index: number) => ({ index, embedding: Array(256).fill(1) })) }) };
  });
  const budget = await createChapterBudget(path, "CHAPTER_I_0.50_CNY_ONCE", upstream);
  const adapter = budget.adapterResolver({ providerKey: "zhipu", protocol: "OPENAI_EMBEDDINGS", modelId: "embedding-3", family: "EMBEDDING" })!;
  for (let n = 0; n < 16; n++) { const input = wire(); input.request.embedding!.texts = Array.from({ length: 6 }, (_, i) => `item-${n}-${i}`); await adapter.execute(input); }
  const input = wire(); input.request.embedding!.texts = ["over-limit"];
  await expect(adapter.execute(input)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false });
  expect(upstream.calls).toHaveLength(16);
  const ledger = await readFile(join(path, "chapter-call-reservations.private.json"), "utf8");
  expect(ledger).not.toContain("synthetic-secret"); expect(ledger).not.toContain("item-0-0");
});
it.each(["http", "malformed", "duplicate"])("stops permanently after %s without another remote attempt", async fault => {
  const upstream: DeterministicProviderHttpTransport = new DeterministicProviderHttpTransport(() => ({ status: fault === "http" ? 500 : 200, headers: {}, body: fault === "malformed" ? "invalid" : JSON.stringify({ model: "embedding-3", data: [{ index: 0, embedding: Array(256).fill(1) }] }) }));
  const budget = await createChapterBudget(await root(), "CHAPTER_I_0.50_CNY_ONCE", upstream);
  const adapter = budget.adapterResolver({ providerKey: "zhipu", protocol: "OPENAI_EMBEDDINGS", modelId: "embedding-3", family: "EMBEDDING" })!;
  if (fault === "duplicate") await adapter.execute(wire());
  await expect(adapter.execute(wire())).rejects.toMatchObject({ retryable: false });
  const next = wire(); next.request.embedding!.texts = ["different"];
  await expect(adapter.execute(next)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false });
  expect(upstream.calls).toHaveLength(1);
});
it("enforces the cumulative TTS character ceiling before the next paid POST", async () => {
  const wav = Buffer.alloc(4844); wav.write("RIFF"); wav.writeUInt32LE(4836, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(4800, 40);
  const upstream: DeterministicProviderHttpTransport = new DeterministicProviderHttpTransport(() => { throw Error("wrong transport"); }, () => ({ status: 200, headers: {}, bytes: wav }));
  const budget = await createChapterBudget(await root(), "CHAPTER_I_0.50_CNY_ONCE", upstream), input = wire();
  Object.assign(input.snapshot, { routeSlot: "PODCAST_TTS", protocol: "CUSTOM_SPEECH", modelId: "glm-tts", endpoint: "https://open.bigmodel.cn/api/paas/v4/audio/speech", capability: { modelId: "glm-tts", families: ["SPEECH"], confidence: "DECLARED", speechFormats: ["wav"] } });
  input.request.speech = { text: "中".repeat(1000), language: "zh-CN", voice: { providerVoiceId: "tongtong", voiceVersion: "1", speakingRate: 1, pitch: 0 }, outputFormat: "wav" };
  const adapter = budget.adapterResolver({ providerKey: "zhipu", protocol: "CUSTOM_SPEECH", modelId: "glm-tts", family: "SPEECH" })!;
  await adapter.execute(input);
  input.request.speech.text = "文".repeat(500); await adapter.execute(input);
  input.request.speech.text = "超";
  await expect(adapter.execute(input)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false });
  expect(upstream.calls).toHaveLength(2);
});
it("requires a separate one-use grant to resume the observed free-model 429 and retains its reservation", async () => {
  const path = await root(), input = wire();
  Object.assign(input.snapshot, { routeSlot: "BOOK_CHUNK_ANALYSIS", protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.7-flash", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", capability: { modelId: "glm-4.7-flash", families: ["TEXT_GENERATION"], confidence: "DECLARED", structuredOutput: "JSON_MODE" } });
  input.request.text = { messages: [{ role: "user", content: "test" }], structuredOutput: { mode: "JSON_MODE" } };
  const upstream: DeterministicProviderHttpTransport = new DeterministicProviderHttpTransport(request => {
    expect(JSON.parse(request.body).max_tokens).toBe(8000);
    return upstream.calls.length === 1 ? { status: 429, headers: {}, body: '{"error":{"code":"1305"}}' } : { status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }) };
  });
  const selection = { providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE" as const, modelId: "glm-4.7-flash", family: "TEXT_GENERATION" as const };
  const initial = await createChapterBudget(path, "CHAPTER_I_0.50_CNY_ONCE", upstream);
  await expect(initial.adapterResolver(selection)!.execute(input)).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: false });
  await expect(createChapterBudget(path, "CHAPTER_I_0.50_CNY_ONCE", upstream)).rejects.toMatchObject({ code: "EEXIST" });
  const resumed = await createChapterBudget(path, "CHAPTER_I_RESUME_429_ONCE_SAME_0.50_CNY", upstream);
  await resumed.adapterResolver(selection)!.execute(input);
  const ledger = JSON.parse(await readFile(join(path, "chapter-call-reservations.private.json"), "utf8"));
  expect(ledger.reservations).toHaveLength(2); expect(upstream.calls).toHaveLength(2);
  await expect(createChapterBudget(path, "CHAPTER_I_RESUME_429_ONCE_SAME_0.50_CNY", upstream)).rejects.toThrow("CHAPTER_429_RESUME_SCOPE_MISMATCH");
});
