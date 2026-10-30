import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createChapterBudget, maximumPricedCny, maximumPaidPricedCny, maximumResilientPricedCny, maximumAirPricedCny, maximumCitablePricedCny, maximumSourcePricedCny } from "../../../tools/book-to-podcast/chapter-budget.js";
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
it("reserves the full published FlashX context and bounds its paid grant to twenty calls", async () => {
  const path = await root(), input = wire();
  Object.assign(input.snapshot, { routeSlot: "BOOK_CHUNK_ANALYSIS", protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.7-flashx", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", capability: { modelId: "glm-4.7-flashx", families: ["TEXT_GENERATION"], confidence: "DECLARED", structuredOutput: "JSON_MODE" } });
  const upstream = new DeterministicProviderHttpTransport(request => {
    expect(JSON.parse(request.body)).toMatchObject({ model: "glm-4.7-flashx", max_tokens: 8000, thinking: { type: "disabled" } });
    return { status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }) };
  });
  const selection = { providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE" as const, modelId: "glm-4.7-flashx", family: "TEXT_GENERATION" as const };
  input.request.text = { messages: [{ role: "user", content: "initial" }], structuredOutput: { mode: "JSON_MODE" } };
  const free = await createChapterBudget(await root(), "CHAPTER_I_0.50_CNY_ONCE", upstream);
  await expect(free.adapterResolver(selection)!.execute(input)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" }); expect(upstream.calls).toHaveLength(0);
  const paid = await createChapterBudget(path, "CHAPTER_I_FLASHX_3.00_CNY_ONCE", upstream);
  for (let i = 0; i < 20; i++) { input.request.text.messages = [{ role: "user", content: `item-${i}` }]; await paid.adapterResolver(selection)!.execute(input); }
  input.request.text.messages = [{ role: "user", content: "over-limit" }];
  await expect(paid.adapterResolver(selection)!.execute(input)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false });
  expect(upstream.calls).toHaveLength(20);
  const ledger = JSON.parse(await readFile(join(path, "chapter-call-reservations.private.json"), "utf8"));
  expect(ledger.limits.approvedCny).toBe(3); expect(ledger.reservations.every((r: { reservedCny: number }) => r.reservedCny === 0.124)).toBe(true);
  expect(maximumPaidPricedCny).toBeCloseTo(2.927456); expect(maximumPaidPricedCny).toBeLessThan(3);
});
it("retains all three prior paid reservations when separately authorized after the timeout", async () => {
  const path = await root(), initial = await createChapterBudget(path, "CHAPTER_I_FLASHX_3.00_CNY_ONCE"); await initial.stop();
  const ledgerPath = join(path, "chapter-call-reservations.private.json"), ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.reservations = Array.from({ length: 3 }, (_, i) => ({ ordinal: i + 1, model: "glm-4.7-flashx", bodySha256: `prior-${i}`, characters: 0, embeddingItems: 0, reservedCny: 0.124 }));
  await writeFile(ledgerPath, JSON.stringify(ledger));
  for (const ordinal of [1, 2]) await writeFile(join(path, `chapter-response-${ordinal}.meta.private.json`), '{"httpStatus":200}');
  const resumed = await createChapterBudget(path, "CHAPTER_I_FLASHX_RESUME_TIMEOUT_ONCE_SAME_3.00_CNY"); await resumed.stop();
  const result = JSON.parse(await readFile(ledgerPath, "utf8"));
  expect(result.reservations).toEqual(ledger.reservations); expect(result.limits.approvedCny).toBe(3);
  await expect(createChapterBudget(path, "CHAPTER_I_FLASHX_RESUME_TIMEOUT_ONCE_SAME_3.00_CNY")).rejects.toMatchObject({ code: "EEXIST" });
});
it("allows only one explicitly approved transient retry, counting both physical calls", async () => {
  const path = await root(), initial = await createChapterBudget(path, "CHAPTER_I_FLASHX_3.00_CNY_ONCE"); await initial.stop();
  const ledgerPath = join(path, "chapter-call-reservations.private.json"), ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.reservations = Array.from({ length: 9 }, (_, i) => ({ ordinal: i + 1, model: "glm-4.7-flashx", bodySha256: `prior-${i}`, characters: 0, embeddingItems: 0, reservedCny: 0.124 }));
  await writeFile(ledgerPath, JSON.stringify(ledger));
  for (const ordinal of [1, 2, 4, 5, 6, 8]) await writeFile(join(path, `chapter-response-${ordinal}.meta.private.json`), '{"httpStatus":200}');
  const upstream: DeterministicProviderHttpTransport = new DeterministicProviderHttpTransport(() => upstream.calls.length === 1 ? { status: 500, headers: {}, body: "{}" } : { status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }) });
  const budget = await createChapterBudget(path, "CHAPTER_I_FLASHX_BOUNDED_RETRY_5.50_CNY_ONCE", upstream), input = wire();
  Object.assign(input.snapshot, { routeSlot: "BOOK_CHUNK_ANALYSIS", protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.7-flashx", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", capability: { modelId: "glm-4.7-flashx", families: ["TEXT_GENERATION"], confidence: "DECLARED", structuredOutput: "JSON_MODE" } });
  input.request.text = { messages: [{ role: "user", content: "bounded retry" }], structuredOutput: { mode: "JSON_MODE" } };
  const adapter = budget.adapterResolver({ providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.7-flashx", family: "TEXT_GENERATION" })!;
  await expect(adapter.execute(input)).rejects.toMatchObject({ code: "TRANSIENT_UPSTREAM", retryable: true });
  await adapter.execute(input);
  await expect(adapter.execute(input)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false });
  expect(upstream.calls).toHaveLength(2);
  const result = JSON.parse(await readFile(ledgerPath, "utf8")); expect(result.reservations).toHaveLength(11); expect(result.stopped).toBe(true);
  expect(result.reservations.reduce((sum: number, item: { reservedCny: number }) => sum + item.reservedCny, 0)).toBeCloseTo(11 * 0.124);
  expect(maximumResilientPricedCny).toBeCloseTo(5.407456); expect(maximumResilientPricedCny).toBeLessThan(5.50);
});
it("preserves text and embedding charges for a separately approved JSON-contract regeneration", async () => {
  const path = await root(), initial = await createChapterBudget(path, "CHAPTER_I_FLASHX_3.00_CNY_ONCE"); await initial.stop();
  const ledgerPath = join(path, "chapter-call-reservations.private.json"), ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.limits.approvedCny = 5.5;
  ledger.reservations = Array.from({ length: 17 }, (_, i) => ({ ordinal: i + 1, model: i === 12 || i === 13 ? "embedding-3" : "glm-4.7-flashx", bodySha256: `prior-${i}`, characters: 0, embeddingItems: i === 12 ? 18 : i === 13 ? 1 : 0, reservedCny: i === 12 ? 18 * 3072 * 0.5 / 1_000_000 : i === 13 ? 3072 * 0.5 / 1_000_000 : 0.124 }));
  await writeFile(ledgerPath, JSON.stringify(ledger));
  for (const ordinal of [1, 2, 4, 5, 6, 8, 10, 12, 13, 14, 15, 16, 17]) await writeFile(join(path, `chapter-response-${ordinal}.meta.private.json`), '{"httpStatus":200}');
  const resumed = await createChapterBudget(path, "CHAPTER_I_FLASHX_JSON_V2_ONCE_SAME_5.50_CNY"); await resumed.stop();
  expect(JSON.parse(await readFile(ledgerPath, "utf8")).reservations).toEqual(ledger.reservations);
  await expect(createChapterBudget(path, "CHAPTER_I_FLASHX_JSON_V2_ONCE_SAME_5.50_CNY")).rejects.toMatchObject({ code: "EEXIST" });
});
it("retries a schema echo only with the separate data-v3 grant and keeps all prior reservations", async () => {
  const path = await root(), initial = await createChapterBudget(path, "CHAPTER_I_FLASHX_3.00_CNY_ONCE"); await initial.stop();
  const ledgerPath = join(path, "chapter-call-reservations.private.json"), ledger = JSON.parse(await readFile(ledgerPath, "utf8")); ledger.limits.approvedCny = 5.5;
  ledger.reservations = Array.from({ length: 24 }, (_, i) => { const items = i === 12 ? 18 : [13, 17, 21].includes(i) ? 1 : 0; return { ordinal: i + 1, model: items ? "embedding-3" : "glm-4.7-flashx", bodySha256: `prior-${i}`, characters: 0, embeddingItems: items, reservedCny: items ? items * 3072 * 0.5 / 1_000_000 : 0.124 }; });
  await writeFile(ledgerPath, JSON.stringify(ledger));
  for (const ordinal of [1, 2, 4, 5, 6, 8, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24]) await writeFile(join(path, `chapter-response-${ordinal}.meta.private.json`), '{"httpStatus":200}');
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  const upstream: DeterministicProviderHttpTransport = new DeterministicProviderHttpTransport(() => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(upstream.calls.length === 1 ? schema : { answer: "actual data" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }) }));
  const budget = await createChapterBudget(path, "CHAPTER_I_FLASHX_DATA_V3_ONCE_SAME_5.50_CNY", upstream), input = wire();
  Object.assign(input.snapshot, { protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.7-flashx", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions" });
  input.request.capability = { family: "TEXT_GENERATION", structuredOutput: "JSON_MODE" }; input.request.text = { messages: [{ role: "user", content: "generate data" }], structuredOutput: { mode: "JSON_MODE", schema } };
  const adapter = budget.adapterResolver({ providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.7-flashx", family: "TEXT_GENERATION" })!;
  await expect(adapter.execute(input)).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE", retryable: true, usage: { inputTokens: 5, outputTokens: 3 } });
  expect(await adapter.execute(input)).toMatchObject({ response: { structured: { answer: "actual data" } } });
  expect(upstream.calls).toHaveLength(2); expect(JSON.parse(await readFile(ledgerPath, "utf8")).reservations).toHaveLength(26);
});
it("bounds the Air script alternative to ten actual requests and retains all old costs", async () => {
  const path = await root(), initial = await createChapterBudget(path, "CHAPTER_I_FLASHX_3.00_CNY_ONCE"); await initial.stop();
  const ledgerPath = join(path, "chapter-call-reservations.private.json"), ledger = JSON.parse(await readFile(ledgerPath, "utf8")); ledger.limits.approvedCny = 5.5;
  ledger.reservations = Array.from({ length: 27 }, (_, i) => { const items = i === 12 ? 18 : [13, 17, 21, 24].includes(i) ? 1 : 0; return { ordinal: i + 1, model: items ? "embedding-3" : "glm-4.7-flashx", bodySha256: `prior-${i}`, characters: 0, embeddingItems: items, reservedCny: items ? items * 3072 * 0.5 / 1_000_000 : 0.124 }; });
  await writeFile(ledgerPath, JSON.stringify(ledger));
  for (const ordinal of [1, 2, 4, 5, 6, 8, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25]) await writeFile(join(path, `chapter-response-${ordinal}.meta.private.json`), '{"httpStatus":200}');
  const upstream = new DeterministicProviderHttpTransport(() => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '{"answer":"data"}' }, finish_reason: "stop" }] }) }));
  const budget = await createChapterBudget(path, "CHAPTER_I_AIR_SCRIPT_ONCE_SAME_5.50_CNY", upstream), input = wire();
  Object.assign(input.snapshot, { routeSlot: "PODCAST_SCRIPT", protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.5-air", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions" });
  input.request.routeSlot = "PODCAST_SCRIPT"; input.request.capability = { family: "TEXT_GENERATION", structuredOutput: "JSON_MODE" };
  const adapter = budget.adapterResolver({ providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.5-air", family: "TEXT_GENERATION" })!;
  for (let i = 0; i < 10; i++) { input.request.idempotencyKey = `air-${i}`; input.request.text = { messages: [{ role: "user", content: `data-${i}` }], structuredOutput: { mode: "JSON_MODE" } }; await adapter.execute(input); }
  input.request.idempotencyKey = "air-over-limit";
  await expect(adapter.execute(input)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false }); expect(upstream.calls).toHaveLength(10);
  const result = JSON.parse(await readFile(ledgerPath, "utf8")); expect(result.reservations).toHaveLength(37); expect(result.reservations[27].reservedCny).toBeCloseTo(0.2176);
  expect(maximumAirPricedCny).toBeCloseTo(5.351456); expect(maximumAirPricedCny).toBeLessThan(5.50);
});
it("keeps four old Air calls counted when a rejected evidence draft is separately regenerated", async () => {
  const path = await root(), initial = await createChapterBudget(path, "CHAPTER_I_FLASHX_3.00_CNY_ONCE"); await initial.stop();
  const ledgerPath = join(path, "chapter-call-reservations.private.json"), ledger = JSON.parse(await readFile(ledgerPath, "utf8")); ledger.limits.approvedCny = 5.5;
  ledger.reservations = Array.from({ length: 33 }, (_, i) => { const items = i === 12 ? 18 : [13, 17, 21, 24, 27, 31].includes(i) ? 1 : 0, air = [28, 29, 30, 32].includes(i); return { ordinal: i + 1, model: items ? "embedding-3" : air ? "glm-4.5-air" : "glm-4.7-flashx", bodySha256: `prior-${i}`, characters: 0, embeddingItems: items, reservedCny: items ? items * 3072 * 0.5 / 1_000_000 : air ? 0.2176 : 0.124 }; });
  await writeFile(ledgerPath, JSON.stringify(ledger));
  for (const ordinal of [1, 2, 4, 5, 6, 8, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 28, 29, 30, 31, 32, 33]) await writeFile(join(path, `chapter-response-${ordinal}.meta.private.json`), '{"httpStatus":200}');
  const upstream = new DeterministicProviderHttpTransport(() => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '{"answer":"data"}' }, finish_reason: "stop" }] }) }));
  const budget = await createChapterBudget(path, "CHAPTER_I_AIR_EVIDENCE_V4_ONCE_SAME_5.50_CNY", upstream), input = wire();
  Object.assign(input.snapshot, { protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.5-air", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions" });
  input.request.routeSlot = "PODCAST_SCRIPT"; input.request.capability = { family: "TEXT_GENERATION", structuredOutput: "JSON_MODE" };
  const adapter = budget.adapterResolver({ providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.5-air", family: "TEXT_GENERATION" })!;
  for (let i = 0; i < 6; i++) { input.request.idempotencyKey = `remaining-air-${i}`; input.request.text = { messages: [{ role: "user", content: `remaining-${i}` }], structuredOutput: { mode: "JSON_MODE" } }; await adapter.execute(input); }
  input.request.idempotencyKey = "eleventh-air";
  await expect(adapter.execute(input)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false }); expect(upstream.calls).toHaveLength(6);
  const result = JSON.parse(await readFile(ledgerPath, "utf8")); expect(result.reservations.slice(0, 33)).toEqual(ledger.reservations); expect(result.reservations).toHaveLength(39);
});

it("requires the distinct citable-contract grant and retains forty prior physical requests", async () => {
  const path = await root(), initial = await createChapterBudget(path, "CHAPTER_I_FLASHX_3.00_CNY_ONCE"); await initial.stop();
  const ledgerPath = join(path, "chapter-call-reservations.private.json"), ledger = JSON.parse(await readFile(ledgerPath, "utf8")); ledger.limits.approvedCny = 5.5;
  ledger.reservations = Array.from({ length: 40 }, (_, i) => {
    const ordinal = i + 1, items = ordinal === 13 ? 18 : [14, 18, 22, 25, 28, 32, 34, 38].includes(ordinal) ? 1 : 0;
    const air = [29, 30, 31, 33, 35, 36, 37, 39, 40].includes(ordinal);
    return { ordinal, model: items ? "embedding-3" : air ? "glm-4.5-air" : "glm-4.7-flashx", bodySha256: `prior-${i}`, characters: 0, embeddingItems: items, reservedCny: items ? items * 3072 * 0.5 / 1_000_000 : air ? 0.2176 : 0.124 };
  });
  await writeFile(ledgerPath, JSON.stringify(ledger));
  for (let ordinal = 1; ordinal <= 40; ordinal++) if (![3, 7, 9, 11, 23, 26, 27].includes(ordinal)) await writeFile(join(path, `chapter-response-${ordinal}.meta.private.json`), '{"httpStatus":200}');
  const upstream = new DeterministicProviderHttpTransport(() => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '{"answer":"data"}' }, finish_reason: "stop" }] }) }));
  await expect(createChapterBudget(path, "CHAPTER_I_AIR_EVIDENCE_V4_ONCE_SAME_5.50_CNY", upstream)).rejects.toThrow("CHAPTER_PAID_RESUME_SCOPE_MISMATCH");
  const budget = await createChapterBudget(path, "CHAPTER_I_AIR_CITABLE_V5_ONCE_CUMULATIVE_6.50_CNY", upstream), input = wire();
  Object.assign(input.snapshot, { protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.5-air", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions" });
  input.request.routeSlot = "PODCAST_SCRIPT"; input.request.capability = { family: "TEXT_GENERATION", structuredOutput: "JSON_MODE" };
  const adapter = budget.adapterResolver({ providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.5-air", family: "TEXT_GENERATION" })!;
  for (let i = 0; i < 6; i++) { input.request.idempotencyKey = `citable-${i}`; input.request.text = { messages: [{ role: "user", content: `citable-${i}` }], structuredOutput: { mode: "JSON_MODE" } }; await adapter.execute(input); }
  input.request.idempotencyKey = "sixteenth-air";
  await expect(adapter.execute(input)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false });
  expect(upstream.calls).toHaveLength(6);
  const result = JSON.parse(await readFile(ledgerPath, "utf8")); expect(result.reservations.slice(0, 40)).toEqual(ledger.reservations); expect(result.limits.approvedCny).toBe(6.5);
  expect(maximumCitablePricedCny).toBeCloseTo(6.439456); expect(maximumCitablePricedCny).toBeLessThan(6.5);
  await expect(createChapterBudget(path, "CHAPTER_I_AIR_CITABLE_V5_ONCE_CUMULATIVE_6.50_CNY", upstream)).rejects.toThrow();
});

it("keeps all forty-eight reservations and caps the source-v6 recovery at six more Air calls", async () => {
  const path = await root(), initial = await createChapterBudget(path, "CHAPTER_I_FLASHX_3.00_CNY_ONCE"); await initial.stop();
  const ledgerPath = join(path, "chapter-call-reservations.private.json"), ledger = JSON.parse(await readFile(ledgerPath, "utf8")); ledger.limits.approvedCny = 6.5;
  ledger.reservations = Array.from({ length: 48 }, (_, i) => {
    const ordinal = i + 1, items = ordinal === 13 ? 18 : [14, 18, 22, 25, 28, 32, 34, 38, 41, 45].includes(ordinal) ? 1 : 0;
    const air = [29, 30, 31, 33, 35, 36, 37, 39, 40, 42, 43, 44, 46, 47, 48].includes(ordinal);
    return { ordinal, model: items ? "embedding-3" : air ? "glm-4.5-air" : "glm-4.7-flashx", bodySha256: `prior-${i}`, characters: 0, embeddingItems: items, reservedCny: items ? items * 3072 * 0.5 / 1_000_000 : air ? 0.2176 : 0.124 };
  });
  await writeFile(ledgerPath, JSON.stringify(ledger));
  for (let ordinal = 1; ordinal <= 48; ordinal++) if (![3, 7, 9, 11, 23, 26, 27].includes(ordinal)) await writeFile(join(path, `chapter-response-${ordinal}.meta.private.json`), '{"httpStatus":200}');
  const upstream = new DeterministicProviderHttpTransport(() => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: '{"answer":"data"}' }, finish_reason: "stop" }] }) }));
  await expect(createChapterBudget(path, "CHAPTER_I_AIR_CITABLE_V5_ONCE_CUMULATIVE_6.50_CNY", upstream)).rejects.toThrow("CHAPTER_PAID_RESUME_SCOPE_MISMATCH");
  const budget = await createChapterBudget(path, "CHAPTER_I_AIR_SOURCE_V6_ONCE_CUMULATIVE_8.00_CNY", upstream), input = wire();
  Object.assign(input.snapshot, { protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.5-air", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions" });
  input.request.routeSlot = "PODCAST_SCRIPT"; input.request.capability = { family: "TEXT_GENERATION", structuredOutput: "JSON_MODE" };
  const adapter = budget.adapterResolver({ providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE", modelId: "glm-4.5-air", family: "TEXT_GENERATION" })!;
  for (let i = 0; i < 6; i++) { input.request.idempotencyKey = `source-${i}`; input.request.text = { messages: [{ role: "user", content: `source-${i}` }], structuredOutput: { mode: "JSON_MODE" } }; await adapter.execute(input); }
  input.request.idempotencyKey = "twenty-second-air";
  await expect(adapter.execute(input)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false });
  expect(upstream.calls).toHaveLength(6);
  const result = JSON.parse(await readFile(ledgerPath, "utf8")); expect(result.reservations.slice(0, 48)).toEqual(ledger.reservations); expect(result.limits).toMatchObject({ approvedCny: 8, textRequests: 43 });
  expect(maximumSourcePricedCny).toBeCloseTo(7.745056); expect(maximumSourcePricedCny).toBeLessThan(8);
  await expect(createChapterBudget(path, "CHAPTER_I_AIR_SOURCE_V6_ONCE_CUMULATIVE_8.00_CNY", upstream)).rejects.toThrow();
});
