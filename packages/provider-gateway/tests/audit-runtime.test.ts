import { describe, expect, it, vi } from "vitest";
import { createTestProviderGateway, ProviderGatewayError, ProviderRegistry, validateProviderEndpoint } from "../src/index.js";
import { FetchProviderHttpTransport } from "../src/adapters/http-transport.js";
import type { GatewayExecutionDependencies } from "../src/runtime/gateway.js";

const request = { workspaceId: "workspace", routeSlot: "BOOK_CHUNK_ANALYSIS" as const, correlationId: "run", idempotencyKey: "invocation", inputHash: "a".repeat(64), capability: { family: "TEXT_GENERATION" as const } };
function gateway(execute: () => Promise<{ response?: unknown }>, controls: GatewayExecutionDependencies = {}) {
  const capability = { modelId: "test", families: ["TEXT_GENERATION"] as const, confidence: "VERIFIED" as const };
  const registry = new ProviderRegistry();
  registry.register({ providerKey: "fixture", displayName: "Fixture", protocol: "TEST", adapterVersion: "1", models: [capability] });
  return createTestProviderGateway(registry, { resolveWorkspaceRoute: async () => undefined }, { resolve: async () => ({ source: "PLATFORM", providerKey: "fixture", protocol: "TEST", modelId: "test", adapterVersion: "1", capability, configuration: {} }) }, () => ({ execute }), controls);
}
describe("audit runtime boundaries", () => {
  it.each(["::ffff:7f00:1", "::ffff:a00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "2001::1", "2001:100::1", "127.0.0.1", "198.18.0.1"])("rejects non-public resolution %s", async address => {
    await expect(validateProviderEndpoint("https://provider.example/v1", { environment: "production", dns: { lookup: async () => [address] } })).rejects.toMatchObject({ code: "NETWORK_POLICY_REJECTED" });
  });
  it("bounds preflight DNS even before an execution signal exists", async () => {
    await expect(validateProviderEndpoint("https://provider.example", { environment: "production", dnsTimeoutMs: 10, dns: { lookup: () => new Promise(() => undefined) } })).rejects.toMatchObject({ code: "NETWORK_POLICY_REJECTED" });
  });
  it("cancels a pending DNS lookup without opening a socket", async () => {
    const controller = new AbortController();
    const transport = new FetchProviderHttpTransport({ dns: { lookup: () => new Promise(() => undefined) } });
    const result = transport.execute({ url: "https://provider.example/v1", method: "POST", body: "{}", headers: {}, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("reauthorizes after backoff and never makes a second paid call after revocation", async () => {
    let revoked = false;
    const execute = vi.fn(async () => { throw new ProviderGatewayError("TRANSIENT_UPSTREAM"); });
    const runtime = gateway(execute, { authorize: async () => { if (revoked) throw new ProviderGatewayError("AUTHORIZATION_FAILED"); }, sleep: async () => { revoked = true; } });
    await expect(runtime.execute(request, { userId: "user" })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("does not reserve budget for a circuit rejection", async () => {
    const reserve = vi.fn(async () => "reservation");
    const runtime = gateway(vi.fn(), { resourceBudget: { reserve, release: vi.fn(), settle: vi.fn() }, circuit: { admit: async () => { throw new ProviderGatewayError("CIRCUIT_OPEN"); }, recordSuccess: vi.fn(), recordRetryableFailure: vi.fn() } });
    await expect(runtime.execute(request, { userId: "user" })).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    expect(reserve).not.toHaveBeenCalled();
  });
  it("releases the concurrency lease when budget admission fails", async () => {
    const release = vi.fn(async () => true), execute = vi.fn();
    const runtime = gateway(execute, { resourceBudget: { reserve: async () => { throw new ProviderGatewayError("BUDGET_EXCEEDED"); }, release: vi.fn(), settle: vi.fn() }, concurrency: { acquire: async key => ({ key, token: "lease" }), release } });
    await expect(runtime.execute(request, { userId: "user" })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(release).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
  });
  it("keeps a successful paid response when settlement fails", async () => {
    const execute = vi.fn(async () => ({ response: { answer: "saved" } })), release = vi.fn();
    const runtime = gateway(execute, { resourceBudget: { reserve: async () => "reservation", settle: async () => { throw new Error("DB unavailable"); }, release } });
    await expect(runtime.execute(request, { userId: "user" })).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(execute).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled();
  });
});
