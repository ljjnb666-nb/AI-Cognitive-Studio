import { expect, it } from "vitest";
import { builtInProviderCatalog, createProviderAdapterResolver, DeterministicProviderHttpTransport, ZhipuEmbeddingAdapter, type ProviderAdapter } from "../src/index.js";
const model = builtInProviderCatalog.providers.find(p => p.providerKey === "zhipu")!.models.find(m => m.modelId === "embedding-3")!;
function fixture(data: unknown = [{ index: 1, embedding: Array(256).fill(2) }, { index: 0, embedding: Array(256).fill(1) }]) {
  const transport = new DeterministicProviderHttpTransport(() => ({ status: 200, headers: {}, body: JSON.stringify({ model: "embedding-3", data, usage: { prompt_tokens: 17 } }) }));
  const input: Parameters<ProviderAdapter["execute"]>[0] = { snapshot: { id: "s", workspaceId: "w", routeSlot: "EMBEDDING", correlationId: "c", source: "WORKSPACE", providerKey: "zhipu", protocol: "OPENAI_EMBEDDINGS", endpoint: "https://open.bigmodel.cn/api/paas/v4/embeddings", modelId: "embedding-3", adapterVersion: "builtin-v1", capability: model, configuration: { embeddingDimensions: 256 }, configurationHash: "h", createdAt: new Date() }, request: { workspaceId: "w", routeSlot: "EMBEDDING", correlationId: "c", idempotencyKey: "i", inputHash: "h", requestFingerprint: "f", capability: { family: "EMBEDDING" }, embedding: { texts: ["first", "second"], purpose: "DOCUMENT" } }, signal: new AbortController().signal, credential: "synthetic" };
  return { transport, input, adapter: new ZhipuEmbeddingAdapter(transport) };
}
it("uses the native documented body, ordered vectors and reported tokens", async () => {
  const f = fixture(), result = await f.adapter.execute(f.input);
  expect(JSON.parse(f.transport.calls[0]!.body)).toEqual({ model: "embedding-3", input: ["first", "second"], dimensions: 256 });
  expect(result.response.vectors.map(v => v[0])).toEqual([1, 2]);
  expect(result.usage?.embeddingInputTokens).toBe(17);
  expect(createProviderAdapterResolver(f.transport)({ providerKey: "zhipu", protocol: "OPENAI_EMBEDDINGS", modelId: "embedding-3", family: "EMBEDDING" })).toBeInstanceOf(ZhipuEmbeddingAdapter);
});
it.each([[], [{ index: 0, embedding: Array(256).fill(1) }], [{ index: 0, embedding: Array(256).fill(1) }, { index: 0, embedding: Array(256).fill(2) }], [{ index: 0, embedding: [1] }, { index: 1, embedding: [1] }]].map(data => ({ data })))("rejects incomplete, duplicate or dimensionally invalid vectors %#", async ({ data }) => {
  const f = fixture(data); await expect(f.adapter.execute(f.input)).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" }); expect(f.transport.calls).toHaveLength(1);
});
it.each(["endpoint", "dimensions", "batch", "model"])("rejects invalid %s before network", async fault => {
  const f = fixture();
  if (fault === "endpoint") f.input.snapshot.endpoint = "https://other.example/embeddings";
  if (fault === "dimensions") f.input.snapshot.configuration = { embeddingDimensions: 2 };
  if (fault === "batch") f.input.request.embedding!.texts = Array(65).fill("a");
  if (fault === "model") f.input.snapshot.modelId = "embedding-2";
  await expect(f.adapter.execute(f.input)).rejects.toThrow(); expect(f.transport.calls).toHaveLength(0);
});
