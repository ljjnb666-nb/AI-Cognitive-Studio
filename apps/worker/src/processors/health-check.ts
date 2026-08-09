import {
  healthCheckPayloadSchema,
  healthCheckResultSchema,
  type HealthCheckPayload,
  type HealthCheckResult,
} from "@ai-cognitive/domain";

export function processHealthCheck(payload: HealthCheckPayload): HealthCheckResult {
  const validatedPayload = healthCheckPayloadSchema.parse(payload);
  return healthCheckResultSchema.parse({ ok: true, message: validatedPayload.message });
}
