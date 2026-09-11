import { ProviderGatewayError } from "@ai-cognitive/provider-gateway";

const safeProviderSettingsCodes = new Set([
  "PROVIDER_CONNECTION_NAME_CONFLICT",
  "PROVIDER_GATEWAY_MODEL_MANIFEST_MISSING",
  "PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID",
  "PROVIDER_GATEWAY_KEYRING_MISSING",
  "PROVIDER_CONNECTION_ENDPOINT_INVALID",
  "PROVIDER_CONNECTION_PROTOCOL_INVALID",
  "PROVIDER_CONFIGURATION_SECRET_FORBIDDEN",
  "CAPABILITY_MISMATCH",
  "AUTHORIZATION_FAILED",
  "TEST_CONNECTION_FAILED",
  "NETWORK_POLICY_REJECTED",
  "WEB_IDENTITY_REQUIRED",
]);

export function providerSettingsFailure(error: unknown): { code: string; status: number } {
  const candidate = error instanceof ProviderGatewayError
    ? safeProviderSettingsCodes.has(error.code)
      ? error.code
      : safeProviderSettingsCodes.has(error.message)
        ? error.message
        : undefined
    : error instanceof Error && safeProviderSettingsCodes.has(error.message)
      ? error.message
      : undefined;
  const code = candidate && safeProviderSettingsCodes.has(candidate) ? candidate : "PROVIDER_SETTINGS_REQUEST_FAILED";
  const status = code === "PROVIDER_CONNECTION_NAME_CONFLICT" ? 409
    : code === "WEB_IDENTITY_REQUIRED" ? 401
    : code === "AUTHORIZATION_FAILED" ? 403
    : code === "PROVIDER_SETTINGS_REQUEST_FAILED" ? 500
    : 400;
  return { code, status };
}
