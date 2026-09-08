import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCredentialKeyring, resolveProviderCatalog, validateRouteManifestSelection } from "../src/index.js";

describe("Beta provider setup catalog", () => {
  it("loads useful built-ins without an operator manifest and preserves Teach Back strictness", () => {
    const catalog = resolveProviderCatalog(undefined);
    expect(catalog.providers.map(provider => provider.providerKey)).toEqual(expect.arrayContaining(["openai", "anthropic", "gemini", "deepseek", "zhipu", "openai-compatible"]));
    expect(() => validateRouteManifestSelection(catalog, { routeSlot: "TEACH_BACK_ASSESSMENT", providerKey: "deepseek", protocol: "OPENAI_COMPATIBLE", modelId: "deepseek-chat" })).toThrow("strict JSON schema");
  });

  it("lets an operator supply an authoritative catalog", () => {
    const catalog = resolveProviderCatalog(JSON.stringify({ providers: [{ providerKey: "deepseek", displayName: "DeepSeek private", protocol: "OPENAI_COMPATIBLE", adapterVersion: "operator", models: [{ modelId: "private-chat", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }] }] }));
    expect(catalog.providers).toHaveLength(1);
    expect(catalog.providers[0]?.models[0]?.modelId).toBe("private-chat");
  });

  it("creates a durable local-only keyring and never auto-generates one in production", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-keyring-")), path = join(root, "secrets", "keyring.json");
    try {
      const first = resolveCredentialKeyring({ NODE_ENV: "development", PROVIDER_GATEWAY_KEYRING: undefined, PROVIDER_GATEWAY_LOCAL_KEYRING_PATH: path }, { initializeLocal: true })!;
      const encrypted = first.encrypt("beta-secret", { workspaceId: "w", connectionId: "c", credentialVersionId: "v", providerKey: "deepseek" });
      const second = resolveCredentialKeyring({ NODE_ENV: "development", PROVIDER_GATEWAY_KEYRING: undefined, PROVIDER_GATEWAY_LOCAL_KEYRING_PATH: path })!;
      expect(second.decrypt(encrypted, { workspaceId: "w", connectionId: "c", credentialVersionId: "v", providerKey: "deepseek" })).toBe("beta-secret");
      expect(resolveCredentialKeyring({ NODE_ENV: "production", PROVIDER_GATEWAY_KEYRING: undefined, PROVIDER_GATEWAY_LOCAL_KEYRING_PATH: path }, { initializeLocal: true })).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("converges concurrent first initialization on one durable local key", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-keyring-race-")), path = join(root, "secrets", "keyring.json"), environment = { NODE_ENV: "development", PROVIDER_GATEWAY_KEYRING: undefined, PROVIDER_GATEWAY_LOCAL_KEYRING_PATH: path };
    try {
      const [first, second] = await Promise.all([Promise.resolve().then(() => resolveCredentialKeyring(environment, { initializeLocal: true })!), Promise.resolve().then(() => resolveCredentialKeyring(environment, { initializeLocal: true })!)]);
      const encrypted = first.encrypt("shared", { workspaceId: "w", connectionId: "c", credentialVersionId: "v", providerKey: "openai" });
      expect(second.decrypt(encrypted, { workspaceId: "w", connectionId: "c", credentialVersionId: "v", providerKey: "openai" })).toBe("shared");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
