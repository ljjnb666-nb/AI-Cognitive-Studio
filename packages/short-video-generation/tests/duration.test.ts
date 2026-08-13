import { describe, expect, it } from "vitest";
import { shortVideoPlanSchema } from "../src/index.js";

const plan = (targetDurationSeconds: number) => ({
  centralQuestion: "q", viewerAssumption: "a", coreInsight: "i", cognitiveShift: "s",
  hook: "h", supportingIdeas: ["x"], evidenceStrategy: "e", ending: "end", tone: "t", targetDurationSeconds,
});

describe("Phase 5 duration boundaries", () => {
  it.each([15, 180])("accepts %is", (seconds) => expect(shortVideoPlanSchema.parse(plan(seconds)).targetDurationSeconds).toBe(seconds));
  it.each([14, 181])("rejects %is", (seconds) => expect(() => shortVideoPlanSchema.parse(plan(seconds))).toThrow());
});
