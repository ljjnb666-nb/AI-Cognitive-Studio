import { describe, expect, it } from "vitest";
import { displayMastery, rubricLabel, statusTone } from "../lib/studio-display";

describe("Phase 14 product display helpers", () => {
  it("maps mastery and every current rubric key into stable Chinese product language", () => {
    expect(displayMastery("NEEDS_REVIEW")).toBe("需要再梳理");
    expect(displayMastery("DEVELOPING")).toBe("正在形成");
    expect(displayMastery("DEMONSTRATED")).toBe("已讲清楚");
    expect(["CORE_MEANING", "COVERAGE", "NO_OVERCLAIM", "DEFINITION", "DISTINCTION", "EXAMPLE", "CORE_CLAIM", "REASONING_LINK", "BOUNDARY_OR_COUNTEREXAMPLE", "PARAPHRASE", "IMPLICATION", "PROBLEM", "ASSUMPTIONS", "PRINCIPLE_LINK", "RELEVANT_DETAIL", "GENERALIZATION_BOUNDARY"].every((key) => rubricLabel(key) !== "理解要点")).toBe(true);
  });

  it("keeps status colors meaningful rather than enum-specific", () => {
    expect(statusTone("理解完成")).toBe("success");
    expect(statusTone("生成中")).toBe("warning");
    expect(statusTone("失败")).toBe("danger");
    expect(statusTone("等待处理")).toBe("muted");
  });
});
