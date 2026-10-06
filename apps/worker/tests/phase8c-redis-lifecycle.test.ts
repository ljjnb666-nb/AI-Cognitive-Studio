import { describe, expect, it, vi } from "vitest";
import { createBookProductionGatewayRuntime } from "../src/provider-gateway-runtime.js";

const state = vi.hoisted(() => ({ failBookWorker: false }));
const closable = () => ({ close: vi.fn(async () => undefined) });

vi.mock("../src/book-analysis.js", () => ({
  createBookAnalysisWorker: () => {
    if (state.failBookWorker) throw new Error("BOOK_WORKER_CONSTRUCTION_FAILED");
    return closable();
  },
  createBookAnalysisQueue: closable,
  dispatchBookAnalysisWithQueue: async () => 0,
}));
vi.mock("../src/source-ingestion.js", () => ({
  createSourceIngestionWorker: closable,
  createSourceIngestionQueue: closable,
  dispatchSourceIngestionWithQueue: async () => 0,
  resolveSourceIngestionOcrExecutor: async () => undefined,
}));
vi.mock("../src/worker.js", () => ({ createHealthCheckWorker: closable }));

const { startWorkerRuntime } = await import("../src/runtime.js");
const keyring = JSON.stringify({ activeVersion: "v1", keys: { v1: Buffer.alloc(32, 7).toString("base64") } });
const manifest = JSON.stringify({ providers: [{ providerKey: "fixture", displayName: "Fixture", protocol: "TEST", adapterVersion: "test", models: [{ modelId: "fixture-model", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }] }] });
const source = { REDIS_URL: "redis://127.0.0.1:6379", NODE_ENV: "test", PROVIDER_GATEWAY_KEYRING: keyring, PROVIDER_GATEWAY_MODEL_MANIFEST: manifest };
const controls = { circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async (key: string) => ({ key, token: "test" }), release: async () => true }, validateEndpoint: async () => undefined };
const fakeRedis = () => ({ quit: vi.fn(async () => "OK") }) as unknown as ReturnType<typeof import("@ai-cognitive/shared/server").createRedisConnection>;

describe("Phase 8C Checkpoint 3B Redis lifecycle", () => {
  it("L01 leaves production Gateway Redis uncreated when Book analysis is disabled", async () => {
    const redisFactory = vi.fn(fakeRedis), runtime = await startWorkerRuntime({ REDIS_URL: source.REDIS_URL } as never, { source, bookProductionGatewayOverrides: { ...controls, redisFactory } });
    await runtime.close();
    expect(redisFactory).not.toHaveBeenCalled();
  });

  it("L02 does not create Redis when every control is deterministically overridden", async () => {
    const redisFactory = vi.fn(fakeRedis), runtime = createBookProductionGatewayRuntime(source, { ...controls, redisFactory });
    await runtime.close();
    expect(redisFactory).not.toHaveBeenCalled();
  });

  it("L03 closes an owned production Redis connection exactly once", async () => {
    const redis = fakeRedis(), redisFactory = vi.fn(() => redis), runtime = createBookProductionGatewayRuntime(source, { ...controls, circuit: undefined, redisFactory });
    await runtime.close();
    expect(redisFactory).toHaveBeenCalledTimes(1);
    expect(redis.quit).toHaveBeenCalledTimes(1);
  });

  it("L05 Gateway close is idempotent", async () => {
    const redis = fakeRedis(), runtime = createBookProductionGatewayRuntime(source, { ...controls, circuit: undefined, redisFactory: () => redis });
    await Promise.all([runtime.close(), runtime.close()]);
    expect(redis.quit).toHaveBeenCalledTimes(1);
  });

  it("L04 worker runtime owns and closes only its production Gateway", async () => {
    const redis = fakeRedis(), redisFactory = vi.fn(() => redis), runtime = await startWorkerRuntime({ REDIS_URL: source.REDIS_URL } as never, { source: { ...source, BOOK_ANALYSIS_PROVIDER: "fixture" }, bookProductionGatewayOverrides: { ...controls, circuit: undefined, redisFactory } });
    await runtime.close();
    expect(redis.quit).toHaveBeenCalledTimes(1);

    const externalFactory = vi.fn(fakeRedis), external = await startWorkerRuntime({ REDIS_URL: source.REDIS_URL } as never, { source: { ...source, BOOK_ANALYSIS_PROVIDER: "fixture" }, bookDependencies: { analysisProviderForRun: async () => { throw new Error("not used"); }, embeddingGatewayForRun: () => { throw new Error("not used"); } }, bookProductionGatewayOverrides: { ...controls, redisFactory: externalFactory } });
    await external.close();
    expect(externalFactory).not.toHaveBeenCalled();
  });

  it("L06 closes the owned Gateway resource when later Book worker construction fails", async () => {
    const redis = fakeRedis(), redisFactory = vi.fn(() => redis);
    state.failBookWorker = true;
    try {
      await expect(startWorkerRuntime({ REDIS_URL: source.REDIS_URL } as never, { source: { ...source, BOOK_ANALYSIS_PROVIDER: "fixture" }, bookProductionGatewayOverrides: { ...controls, circuit: undefined, redisFactory } })).rejects.toThrow("BOOK_WORKER_CONSTRUCTION_FAILED");
      expect(redis.quit).toHaveBeenCalledTimes(1);
    } finally {
      state.failBookWorker = false;
    }
  });
});
