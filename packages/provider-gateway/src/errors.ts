export const providerErrorCodes = ["AUTHENTICATION_FAILED", "AUTHORIZATION_FAILED", "MODEL_NOT_FOUND", "CAPABILITY_MISMATCH", "CONTEXT_LIMIT_EXCEEDED", "RATE_LIMITED", "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_POLICY_REJECTED", "TRANSIENT_UPSTREAM", "INVALID_PROVIDER_RESPONSE", "CONTENT_REJECTED", "CANCELLED", "BUDGET_EXCEEDED", "CIRCUIT_OPEN", "IDEMPOTENCY_CONFLICT", "ROUTE_UNAVAILABLE", "CONNECTION_DISABLED", "CREDENTIAL_REVOKED", "INTERNAL_PROVIDER_ERROR"] as const;
export type ProviderErrorCode = (typeof providerErrorCodes)[number];
export class ProviderGatewayError extends Error {
  readonly retryable: boolean;
  readonly correlationId?: string;
  readonly remoteRequestId?: string;
  readonly retryAfterMs?: number;
  constructor(readonly code: ProviderErrorCode, message: string = code, options: { retryable?: boolean; correlationId?: string; remoteRequestId?: string; retryAfterMs?: number } = {}) { super(message); this.name = "ProviderGatewayError"; this.retryable = options.retryable ?? (code === "TRANSIENT_UPSTREAM" || code === "RATE_LIMITED" || code === "TIMEOUT"); this.correlationId = bounded(options.correlationId, 256); this.remoteRequestId = bounded(options.remoteRequestId, 256); this.retryAfterMs = options.retryAfterMs !== undefined && Number.isSafeInteger(options.retryAfterMs) && options.retryAfterMs >= 0 && options.retryAfterMs <= 86_400_000 ? options.retryAfterMs : undefined; }
}
function bounded(value: string | undefined, limit: number): string | undefined { return value && value.length <= limit ? value : undefined; }
