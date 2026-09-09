import { describe, expect, it, vi } from "vitest";
import { logger, redactSensitive } from "../src/logger.js";

const canary = "sk-phase18-secret-must-never-leak";

describe("production diagnostic redaction", () => {
  it("removes credentials recursively from structured logs", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logger.error("phase18.redaction", { authorization: `Bearer ${canary}`, nested: { apiKey: canary, ordinary: "safe" }, source: canary });
    const serialized = String(output.mock.calls[0]?.[0]);
    expect(serialized).not.toContain(canary);
    expect(JSON.parse(serialized)).toMatchObject({ authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]", ordinary: "safe" }, source: "[REDACTED]" });
    output.mockRestore();
  });

  it("redacts sensitive values even under harmless keys", () => {
    expect(redactSensitive({ message: `provider returned ${canary}` })).toEqual({ message: "[REDACTED]" });
  });
});
