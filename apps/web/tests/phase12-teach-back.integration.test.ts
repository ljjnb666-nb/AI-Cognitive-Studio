import { describe, expect, it } from "vitest";
import { assessmentSchema, deriveMasteryState, rubricForCognitionType, validateTeachBackAssessment, type Criterion } from "../lib/teach-back";

const rubric = rubricForCognitionType("SUMMARY");
const valid: { criteria: Criterion[]; feedback: string; nextPrompt: string } = { criteria: rubric.map((key) => ({ key, status: "MET", rationale: "简洁理由", evidenceRefs: [] })), feedback: "反馈", nextPrompt: "再说明其中的关系。" };
describe("Phase 12 Teach Back deterministic assessment", () => {
  it("derives mastery without a provider score", () => { expect(deriveMasteryState(rubric, valid.criteria)).toBe("DEMONSTRATED"); expect(deriveMasteryState(rubric, [{ ...valid.criteria[0], status: "NOT_MET" }, ...valid.criteria.slice(1)])).toBe("NEEDS_REVIEW"); expect(deriveMasteryState(rubric, [{ ...valid.criteria[0], status: "PARTIAL" }, ...valid.criteria.slice(1)])).toBe("DEVELOPING"); });
  it("rejects missing, duplicate, unknown, invalid, empty, oversized, score, and invented-evidence fields", () => { for (const value of [{ ...valid, criteria: valid.criteria.slice(1) }, { ...valid, criteria: [valid.criteria[0], valid.criteria[0], valid.criteria[2]] }, { ...valid, criteria: [{ ...valid.criteria[0], key: "UNKNOWN" }, ...valid.criteria.slice(1)] }, { ...valid, criteria: [{ ...valid.criteria[0], status: "INVALID" }, ...valid.criteria.slice(1)] }, { ...valid, criteria: [{ ...valid.criteria[0], rationale: "" }, ...valid.criteria.slice(1)] }, { ...valid, feedback: "" }, { ...valid, score: 92 }, { ...valid, feedback: "x".repeat(2001) }, { ...valid, nextPrompt: "x".repeat(601) }, { ...valid, criteria: [{ ...valid.criteria[0], evidenceRefs: ["E9"] }, ...valid.criteria.slice(1)] }]) expect(() => validateTeachBackAssessment(value, rubric, ["E1"])).toThrow("TEACH_BACK_ASSESSMENT_INVALID"); });
  it("uses a valid zero-evidence schema without an empty enum", () => { const schema = assessmentSchema(rubric, []); const refs = (schema.properties.criteria.items.properties.evidenceRefs as { items: Record<string, unknown>; maxItems: number }); expect(refs.maxItems).toBe(0); expect(refs.items).toEqual({ type: "string" }); expect(refs.items).not.toHaveProperty("enum"); });
});

describe("Better Auth production-build contract", () => {
  it("creates a password account with the release environment", async () => {
    const { auth } = await import("../lib/auth");
    const response = await auth.handler(new Request("http://localhost:3001/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3001" }, body: JSON.stringify({ name: "Phase Twelve Auth", email: `phase12-auth-${Date.now()}@ai-cognitive-studio.test`, password: "Phase12Password!" }) }));
    expect(response.status, await response.text()).toBe(200);
  });
});
