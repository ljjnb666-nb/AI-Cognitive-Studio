import { z } from "zod";

export const healthCheckPayloadSchema = z.object({
  message: z.literal("phase-0"),
});

export const healthCheckResultSchema = z.object({
  ok: z.literal(true),
  message: z.literal("phase-0"),
});

export type HealthCheckPayload = z.infer<typeof healthCheckPayloadSchema>;
export type HealthCheckResult = z.infer<typeof healthCheckResultSchema>;
