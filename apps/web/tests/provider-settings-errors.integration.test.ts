import { describe, expect, it } from "vitest";
import { providerSettingsFailure } from "../lib/provider-settings-errors.js";
import { readableProviderError } from "../lib/provider-settings-ui-errors.js";
import { ProviderGatewayError } from "@ai-cognitive/provider-gateway";

describe("Provider settings public errors", () => {
  it("maps duplicate Provider names to a stable conflict response and Chinese UI message", () => {
    expect(providerSettingsFailure(new ProviderGatewayError("PROVIDER_CONNECTION_NAME_CONFLICT"))).toEqual({ code: "PROVIDER_CONNECTION_NAME_CONFLICT", status: 409 });
    expect(readableProviderError("PROVIDER_CONNECTION_NAME_CONFLICT")).toBe("已存在同名 Provider，请换一个名称。");
  });
  it("does not expose arbitrary internal messages", () => {
    expect(providerSettingsFailure(new Error("Invalid `prisma.providerConnection.create()` invocation: secret"))).toEqual({ code: "PROVIDER_SETTINGS_REQUEST_FAILED", status: 500 });
  });
});
