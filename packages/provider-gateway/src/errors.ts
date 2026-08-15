export const providerErrorCodes = ["AUTHENTICATION_FAILED", "AUTHORIZATION_FAILED", "MODEL_NOT_FOUND", "CAPABILITY_MISMATCH", "CONTEXT_LIMIT_EXCEEDED", "RATE_LIMITED", "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_POLICY_REJECTED", "TRANSIENT_UPSTREAM", "INVALID_PROVIDER_RESPONSE", "CONTENT_REJECTED", "CANCELLED", "BUDGET_EXCEEDED", "CIRCUIT_OPEN", "IDEMPOTENCY_CONFLICT", "ROUTE_UNAVAILABLE", "CONNECTION_DISABLED", "CREDENTIAL_REVOKED", "INTERNAL_PROVIDER_ERROR"] as const;
export type ProviderErrorCode = (typeof providerErrorCodes)[number];
export class ProviderGatewayError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: ProviderErrorCode, message: string = code, options: { retryable?: boolean; correlationId?: string; remoteRequestId?: string } = {}) { super(message); this.name = "ProviderGatewayError"; this.retryable = options.retryable ?? (code === "TRANSIENT_UPSTREAM" || code === "RATE_LIMITED" || code === "TIMEOUT"); }
}
