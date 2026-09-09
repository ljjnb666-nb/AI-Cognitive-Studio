import { describe, expect, it } from "vitest";
import { checkReadiness } from "../lib/readiness";

describe("readiness", () => {
  it("keeps provider-independent liveness separate and reports only safe dependency codes", async () => {
    const result = await checkReadiness({ database: async () => { throw new Error("password=sk-phase18-secret-must-never-leak DATABASE_DOWN"); }, redis: async () => undefined, objectStorage: async () => true });
    expect(result).toEqual({ status: "not_ready", service: "web", checks: [{ name: "database", ok: false, code: "DATABASE_DOWN" }, { name: "redis", ok: true }, { name: "objectStorage", ok: true }] });
    expect(JSON.stringify(result)).not.toContain("sk-phase18-secret-must-never-leak");
  });
});
