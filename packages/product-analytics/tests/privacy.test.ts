import { describe, expect, it } from "vitest";
import { betaAccessMode, clientEventSchema, createInviteToken, feedbackSchema, hashInviteToken } from "../src/index.js";
describe("phase 17 privacy contract", () => {
  it("generates a 32-byte invite and stores a one-way digest", () => { const token = createInviteToken(); expect(Buffer.from(token, "base64url")).toHaveLength(32); expect(hashInviteToken(token)).toMatch(/^[a-f0-9]{64}$/); });
  it("rejects secret-like arbitrary telemetry properties", () => { expect(() => clientEventSchema.parse({ eventName: "STUDIO_SESSION_STARTED", clientEventId: "1c4ccf99-2cfa-4c18-a5d1-c70a10559221", properties: { authorization: "Bearer sk-secret" } })).toThrow(); });
  it("defaults access mode off but rejects an unrecognized deployment flag", () => { expect(betaAccessMode({})).toBe("OFF"); expect(() => betaAccessMode({ BETA_ACCESS_MODE: "yes" })).toThrow("BETA_ACCESS_MODE_INVALID"); });
  it("refuses empty feedback server-side", () => { expect(() => feedbackSchema.parse({ category: "OTHER" })).toThrow("FEEDBACK_CONTENT_REQUIRED"); });
});
