import { describe, expect, it } from "vitest";
import {
  bookRoutePlanHash, normalizeBookRoutePlan,
  type BookAnalysisRoutePlan,
} from "@ai-cognitive/book-intelligence";
import { stableHash, type GatewayRequest, type ResolvedRoute } from "@ai-cognitive/provider-gateway";
import { assertBookBackupGatewayDispatchFenced } from "../src/book-backup-gateway-dispatch-fence.js";

const cfg = {};
const entry = (modelId: string) => ({
  providerKey: "fixture", protocol: "TEST" as const,
  modelId, connectionId: "connection-" + modelId,
  credentialVersionId: "credential-" + modelId,
  endpoint: "https://fixture.example.test/v1",
  adapterVersion: "fixture-v1", configuration: cfg,
  configurationHash: stableHash(cfg),
  structuredOutput: "JSON_MODE" as const,
});
const primary = normalizeBookRoutePlan({
  version: 1,
  routes: {
    BOOK_CHUNK_ANALYSIS: entry("primary"),
    BOOK_REDUCTION_ANALYSIS: entry("primary"),
    BOOK_SYNTHESIS: entry("primary"),
    EMBEDDING: { ...entry("vector"), dimensions: 3 },
  },
} satisfies BookAnalysisRoutePlan);
const unsigned = {
  version: 1 as const,
  executionEnabled: false as const,
  primaryPlanHash: primary.integrityHash!,
  slots: {
    BOOK_CHUNK_ANALYSIS: {
      preferenceRevision: 1, preferenceHash: "a".repeat(64),
      requestedEnabled: true as const, maxSwitches: 1 as const,
      candidates: [primary.routes.BOOK_CHUNK_ANALYSIS, entry("backup")],
    },
  },
};
const frozen = { ...unsigned, integrityHash: stableHash(unsigned) };
const payload = {
  routePlan: primary, routePlanHash: bookRoutePlanHash(primary),
  failoverPlan: frozen,
};
const pinned = (modelId: string): ResolvedRoute => ({
  source: "WORKSPACE", ...entry(modelId),
  capability: {
    modelId, families: ["TEXT_GENERATION"] as const,
    confidence: "VERIFIED", structuredOutput: "JSON_MODE",
  },
});
const request: GatewayRequest = {
  workspaceId: "workspace", executionRunId: "analysis-run",
  routeSlot: "BOOK_CHUNK_ANALYSIS", correlationId: "test",
  idempotencyKey: "fenced-fallback", inputHash: "a".repeat(64),
  capability: { family: "TEXT_GENERATION", structuredOutput: "JSON_MODE" },
  text: {
    system: "Return a structured answer",
    messages: [{ role: "user", content: "Test-only material" }],
    structuredOutput: { mode: "JSON_MODE" },
  },
  pinnedRoute: pinned("primary"),
};

describe("Book production Gateway backup dispatch fence", () => {
  it("keeps the frozen primary model available without sending any adapter request", () => {
    expect(() => assertBookBackupGatewayDispatchFenced(payload, request)).not.toThrow();
    expect(frozen.executionEnabled).toBe(false);
  });

  it("rejects an explicitly reserved backup or arbitrary third model despite an OWNER grant", () => {
    for (const modelId of ["backup", "unrelated"]) {
      expect(() => assertBookBackupGatewayDispatchFenced(payload, {
        ...request, pinnedRoute: pinned(modelId),
      })).toThrow("Book backup execution is disabled");
    }
  });

  it("rejects model and credential identity drift, without silently falling back to a current workspace route", () => {
    const original = request.pinnedRoute!;
    for (const mutation of [
      { connectionId: "different-connection" },
      { credentialVersionId: "different-credential" },
      { endpoint: "https://attacker.example.test/v1" },
      { adapterVersion: "untrusted-adapter" },
      { region: "foreign-region" },
      { configuration: { maxOutputTokens: 1 } },
      { capability: { ...original.capability, modelId: "other" } },
      { capability: { ...original.capability, structuredOutput: "STRICT_JSON_SCHEMA" as const } },
    ]) {
      expect(() => assertBookBackupGatewayDispatchFenced(payload, {
        ...request, pinnedRoute: { ...original, ...mutation },
      })).toThrow("Book backup execution is disabled");
    }
    expect(() => assertBookBackupGatewayDispatchFenced(payload, {
      ...request, pinnedRoute: undefined,
    })).toThrow("Book backup execution is disabled");
  });

  it("fails closed when frozen intent, primary route hash or paid-execution flag is tampered with", () => {
    for (const altered of [
      { ...payload, routePlanHash: "b".repeat(64) },
      { ...payload, failoverPlan: { ...frozen, integrityHash: "b".repeat(64) } },
      { ...payload, failoverPlan: { ...frozen, executionEnabled: true } },
      { ...payload, failoverPlan: null },
    ]) {
      expect(() => assertBookBackupGatewayDispatchFenced(altered, request))
        .toThrow("Book backup execution is disabled");
    }
  });

  it("does not impact legacy jobs or other route slots when no backup is configured", () => {
    expect(() => assertBookBackupGatewayDispatchFenced({ routePlan: primary }, request)).not.toThrow();
    expect(() => assertBookBackupGatewayDispatchFenced(null, request)).not.toThrow();
    expect(() => assertBookBackupGatewayDispatchFenced(payload, {
      ...request, routeSlot: "BOOK_SYNTHESIS",
      pinnedRoute: pinned("backup"),
    })).not.toThrow();
    expect(() => assertBookBackupGatewayDispatchFenced(payload, {
      ...request, routeSlot: "PODCAST_SCRIPT",
      pinnedRoute: pinned("backup"),
    })).not.toThrow();
  });
});
