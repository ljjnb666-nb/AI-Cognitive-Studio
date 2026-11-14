import { describe, expect, it } from "vitest";
import { resolveProviderCatalog, stableHash } from "@ai-cognitive/provider-gateway";
import {
  normalizeBookRoutePlan,
  sealFrozenBookFailoverPlan,
  verifyFrozenBookFailoverPlan,
  type BookAnalysisRoutePlan,
} from "../src/index.js";

const manifest = resolveProviderCatalog(undefined);
const configuration = {};
const baseEntry = (modelId: string, extras: Record<string, unknown> = {}) => ({
  providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE", modelId,
  configuration, configurationHash: stableHash(configuration),
  connectionId: "primary", credentialVersionId: "primary-credential",
  endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  adapterVersion: "fixture", ...extras,
});
const primary = (): BookAnalysisRoutePlan => normalizeBookRoutePlan({
  version: 1,
  routes: {
    BOOK_CHUNK_ANALYSIS: { ...baseEntry("glm-5.3-flash"), structuredOutput: "JSON_MODE" },
    BOOK_REDUCTION_ANALYSIS: { ...baseEntry("glm-5.3-flash"), structuredOutput: "JSON_MODE" },
    BOOK_SYNTHESIS: { ...baseEntry("glm-5.3-flash"), structuredOutput: "JSON_MODE" },
    EMBEDDING: {
      ...baseEntry("embedding-fixture", {
        providerKey: "qwen", protocol: "OPENAI_EMBEDDINGS",
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
      }),
      dimensions: 1024,
    },
  },
});
const connections = [
  { id: "mini", providerKey: "minimax", protocol: "OPENAI_COMPATIBLE",
    endpoint: "https://api.minimax.io/v1/text/chatcompletion_v2", region: null, status: "ACTIVE",
    credentialVersions: [{ id: "mini-credential", status: "ACTIVE" }] },
  { id: "deep", providerKey: "deepseek", protocol: "OPENAI_COMPATIBLE",
    endpoint: "https://api.deepseek.com/chat/completions", region: null, status: "ACTIVE",
    credentialVersions: [{ id: "deep-credential", status: "ACTIVE" }] },
];
const candidates = [
  { connectionId: "mini", modelId: "MiniMax-M3", configuration: {} },
  { connectionId: "deep", modelId: "deepseek-v4-flash", configuration: {} },
];
const preference = (overrides: Record<string, unknown> = {}) => {
  const draft = {
    routeSlot: "BOOK_CHUNK_ANALYSIS",
    requestedEnabled: true,
    maxSwitches: 2,
    revision: 4,
    candidates,
    ...overrides,
  };
  return { ...draft, preferenceHash: stableHash({
    version: 1, routeSlot: draft.routeSlot,
    requestedEnabled: draft.requestedEnabled, maxSwitches: draft.maxSwitches,
    candidates: draft.candidates,
  }) };
};

describe("Book analysis inert frozen failover intent", () => {
  it("seals primary and backup identities without enabling paid switching", () => {
    const source = primary();
    const plan = sealFrozenBookFailoverPlan(source, [preference()], connections, manifest)!;
    expect(plan.executionEnabled).toBe(false);
    expect(plan.primaryPlanHash).toBe(source.integrityHash);
    expect(plan.slots.BOOK_CHUNK_ANALYSIS?.candidates.map(item => item.modelId))
      .toEqual(["glm-5.3-flash", "MiniMax-M3", "deepseek-v4-flash"]);
    expect(plan.slots.BOOK_CHUNK_ANALYSIS?.preferenceRevision).toBe(4);
    expect(verifyFrozenBookFailoverPlan(structuredClone(plan), source)).toEqual(plan);
    expect(plan.integrityHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps saved but disabled preferences completely inert", () => {
    expect(sealFrozenBookFailoverPlan(primary(),
      [preference({ requestedEnabled: false })], connections, manifest)).toBeUndefined();
    expect(sealFrozenBookFailoverPlan(primary(), [], connections, manifest)).toBeUndefined();
  });

  it("supports one authorized switch despite a saved two-backup chain", () => {
    const plan = sealFrozenBookFailoverPlan(primary(),
      [preference({ maxSwitches: 1 })], connections, manifest)!;
    expect(plan.slots.BOOK_CHUNK_ANALYSIS?.maxSwitches).toBe(1);
    expect(plan.slots.BOOK_CHUNK_ANALYSIS?.candidates).toHaveLength(2);
    expect(plan.executionEnabled).toBe(false);
  });

  it("rejects unknown billing/authorization substitutes such as altered execution state or changed primary route", () => {
    const source = primary();
    const plan = sealFrozenBookFailoverPlan(source, [preference()], connections, manifest)!;
    const enabled = structuredClone(plan) as unknown as { executionEnabled: boolean };
    enabled.executionEnabled = true;
    expect(() => verifyFrozenBookFailoverPlan(enabled, source)).toThrow("BOOK_FAILOVER_PLAN_INTEGRITY_FAILED");
    const changed = structuredClone(source);
    changed.routes.BOOK_CHUNK_ANALYSIS.modelId = "glm-4.7-flash";
    const resealedPrimary = normalizeBookRoutePlan({ version: 1, routes: changed.routes });
    expect(() => verifyFrozenBookFailoverPlan(plan, resealedPrimary))
      .toThrow("BOOK_FAILOVER_PLAN_INTEGRITY_FAILED");
  });

  it("detects tampered credentials, model, configuration and candidate order", () => {
    const source = primary();
    const plan = sealFrozenBookFailoverPlan(source, [preference()], connections, manifest)!;
    const mutations: Array<(value: typeof plan) => void> = [
      value => { value.slots.BOOK_CHUNK_ANALYSIS!.candidates[1]!.credentialVersionId = "another"; },
      value => { value.slots.BOOK_CHUNK_ANALYSIS!.candidates[1]!.modelId = "unapproved"; },
      value => { value.slots.BOOK_CHUNK_ANALYSIS!.candidates[1]!.configuration = { temperature: 0.7 }; },
      value => { value.slots.BOOK_CHUNK_ANALYSIS!.candidates.reverse(); },
      value => { value.slots.BOOK_CHUNK_ANALYSIS!.preferenceRevision += 1; },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(plan);
      mutate(tampered);
      expect(() => verifyFrozenBookFailoverPlan(tampered, source))
        .toThrow("BOOK_FAILOVER_PLAN_INTEGRITY_FAILED");
    }
  });

  it("fails closed on revoked credentials, same-model fallback, unsupported model, and stale preference hash", () => {
    const cases = [
      () => sealFrozenBookFailoverPlan(primary(), [preference()],
        [{ ...connections[0]!, credentialVersions: [] }, connections[1]!], manifest),
      () => sealFrozenBookFailoverPlan(primary(), [preference({
        candidates: [{ connectionId: "mini", modelId: "MiniMax-M3", configuration: {} },
          { connectionId: "mini", modelId: "MiniMax-M3", configuration: {} }],
      })], connections, manifest),
      () => sealFrozenBookFailoverPlan(primary(), [preference({
        candidates: [{ connectionId: "mini", modelId: "not-a-real-model", configuration: {} }, candidates[1]!],
      })], connections, manifest),
      () => sealFrozenBookFailoverPlan(primary(), [{
        ...preference(), preferenceHash: "0".repeat(64),
      }], connections, manifest),
      () => sealFrozenBookFailoverPlan(primary(), [preference({
        candidates: [{ connectionId: "mini", modelId: "MiniMax-M3", configuration: { api_key: "no" } }, candidates[1]!],
      })], connections, manifest),
    ];
    for (const action of cases) expect(action).toThrow();
  });
});
