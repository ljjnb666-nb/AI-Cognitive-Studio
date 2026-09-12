import { describe, expect, it } from "vitest";
import { cognitionTypeLabels } from "../lib/cognitions";

describe("Phase 18.2.1 cognition semantics", () => {
  it("keeps claims distinct from source quotations", () => {
    expect(cognitionTypeLabels.CLAIM).toBe("关键主张");
    expect(cognitionTypeLabels.QUOTE).toBe("原文证据");
  });
});
