import { describe, expect, it } from "vitest";
import { healthCheckPayloadSchema } from "../src/schemas/health-check.js";

describe("healthCheckPayloadSchema", () => {
  it("accepts the Phase 0 health payload", () => {
    expect(healthCheckPayloadSchema.parse({ message: "phase-0" })).toEqual({
      message: "phase-0",
    });
  });

  it("rejects invalid payloads", () => {
    expect(healthCheckPayloadSchema.safeParse({ message: "other" }).success).toBe(false);
  });
});
