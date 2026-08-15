const sensitiveKey = /authorization|api[_-]?key|token|secret|credential/i;
const secretValue = /(?:bearer\s+)?(?:sk|key|token)[_-][a-z0-9._-]{6,}/gi;
export function redactSecrets(value: unknown): unknown { if (typeof value === "string") return value.replace(secretValue, "[REDACTED]"); if (Array.isArray(value)) return value.map(redactSecrets); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : redactSecrets(item)])); return value; }
export function safeProviderDetail(value: unknown, maxLength = 512): string { return JSON.stringify(redactSecrets(value)).slice(0, maxLength); }
