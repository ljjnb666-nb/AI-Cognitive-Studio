import { describe, expect, it } from "vitest";
import { providerSettingsFailure } from "../lib/provider-settings-errors.js";
import { readableProviderError } from "../lib/provider-settings-ui-errors.js";
import { ProviderGatewayError } from "@ai-cognitive/provider-gateway";

describe("Provider settings public errors", () => {
  it.each([
    ["PROVIDER_CONNECTION_NAME_CONFLICT", 409],
    ["WEB_IDENTITY_REQUIRED", 401],
    ["AUTHORIZATION_FAILED", 403],
    ["PROVIDER_GATEWAY_MODEL_MANIFEST_MISSING", 400],
    ["PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID", 400],
    ["PROVIDER_GATEWAY_KEYRING_MISSING", 400],
    ["PROVIDER_CONNECTION_ENDPOINT_INVALID", 400],
    ["PROVIDER_CONNECTION_PROTOCOL_INVALID", 400],
    ["PROVIDER_CONFIGURATION_SECRET_FORBIDDEN", 400],
    ["CAPABILITY_MISMATCH", 400],
    ["TEST_CONNECTION_FAILED", 400],
    ["NETWORK_POLICY_REJECTED", 400],
    ["QWEN_CONFIGURATION_INVALID", 400],
  ])("maps public code %s to its stable HTTP status", (code, status) => {
    expect(providerSettingsFailure(new ProviderGatewayError(code as never))).toEqual({ code, status });
  });

  it("preserves an exact allowlisted product message from an internal ProviderGatewayError", () => {
    expect(providerSettingsFailure(new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID"))).toEqual({ code: "PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID", status: 400 });
  });

  it("maps duplicate Provider names to the Chinese UI message", () => {
    expect(readableProviderError("PROVIDER_CONNECTION_NAME_CONFLICT")).toBe("已存在同名 Provider，请换一个名称。");
  });

  it("maps invalid Qwen configuration to its safe Chinese UI message", () => {
    expect(readableProviderError("QWEN_CONFIGURATION_INVALID")).toBe("百炼配置无效，请检查区域、工作区 ID 和向量维度。");
    expect(providerSettingsFailure(new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "qwen upstream debug detail"))).toEqual({ code: "PROVIDER_SETTINGS_REQUEST_FAILED", status: 500 });
  });

  it.each([
    new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Invalid prisma.providerConnection.create() invocation"),
    new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "secret-provider-debug-message"),
    new Error("Invalid `prisma.providerConnection.create()` invocation: secret"),
  ])("does not expose arbitrary internal messages", error => {
    expect(providerSettingsFailure(error)).toEqual({ code: "PROVIDER_SETTINGS_REQUEST_FAILED", status: 500 });
  });
});
