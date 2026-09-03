import { describe, expect, it } from "vitest";
import { displayMastery, rubricLabel, statusTone } from "../lib/studio-display";
import {
  bookIntelligenceErrorMessage,
  mediaGenerationErrorMessage,
  needsProviderConfiguration,
  uploadErrorMessage,
} from "../lib/product-errors";

describe("Phase 14 product display helpers", () => {
  it("maps mastery and every current rubric key into stable Chinese product language", () => {
    expect(displayMastery("NEEDS_REVIEW")).toBe("需要再梳理");
    expect(displayMastery("DEVELOPING")).toBe("正在形成");
    expect(displayMastery("DEMONSTRATED")).toBe("已表现出理解");
    expect(["CORE_MEANING", "COVERAGE", "NO_OVERCLAIM", "DEFINITION", "DISTINCTION", "EXAMPLE", "CORE_CLAIM", "REASONING_LINK", "BOUNDARY_OR_COUNTEREXAMPLE", "PARAPHRASE", "IMPLICATION", "PROBLEM", "ASSUMPTIONS", "PRINCIPLE_LINK", "RELEVANT_DETAIL", "GENERALIZATION_BOUNDARY"].every((key) => rubricLabel(key) !== "理解要点")).toBe(true);
  });

  it("keeps status colors meaningful rather than enum-specific", () => {
    expect(statusTone("理解完成")).toBe("success");
    expect(statusTone("生成中")).toBe("warning");
    expect(statusTone("失败")).toBe("danger");
    expect(statusTone("等待处理")).toBe("muted");
  });

  it("maps book and upload failures to product copy without exposing diagnostics", () => {
    const sentinels = [
      "INTERNAL_TEST_SENTINEL",
      "DATABASE_PRIVATE_ERROR",
      "PROVIDER_INTERNAL_SECRET_ERROR",
    ];
    for (const sentinel of sentinels) {
      expect(bookIntelligenceErrorMessage(sentinel)).not.toContain(sentinel);
      expect(uploadErrorMessage(sentinel)).not.toContain(sentinel);
      expect(mediaGenerationErrorMessage(sentinel)).not.toContain(sentinel);
    }
    expect(bookIntelligenceErrorMessage("AI_PROVIDER_CONFIGURATION_REQUIRED")).toContain("配置 Provider");
    expect(needsProviderConfiguration("AI_PROVIDER_CONFIGURATION_REQUIRED")).toBe(true);
    expect(needsProviderConfiguration("PROVIDER_INTERNAL_SECRET_ERROR")).toBe(false);
    expect(uploadErrorMessage("FILE_TOO_LARGE")).toBe("文件超过当前允许的大小。");
    expect(uploadErrorMessage("UNSUPPORTED_MEDIA_TYPE")).toBe("暂不支持这个文件格式。");
    expect(uploadErrorMessage("UPLOAD_FAILED")).toBe("文件没有上传完成，请重新选择后再试。");
  });
});
