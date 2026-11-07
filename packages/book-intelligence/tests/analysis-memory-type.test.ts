import { expect, it } from "vitest";
import { validateAnalysisResponse } from "../src/analysis.js";
it("完整JSON中的FACT属于分类不兼容，不误报缺字段，也不自动替换或丢弃", () => {
  const raw = {summary:"完整摘要",memory:[{type:"FACT",content:"重要事实",evidence:[{sourceBlockId:"block",startOffset:0,endOffset:4}]}]};
  const before = structuredClone(raw);
  expect(()=>validateAnalysisResponse(raw)).toThrow("ANALYSIS_MEMORY_TYPE_UNSUPPORTED");
  expect(raw).toEqual(before);
});
it("合法事实主张连同原始证据保留，缺字段仍拒绝", () => {
  const raw = {summary:"完整摘要",memory:[{type:"CLAIM",content:"重要事实",evidence:[{sourceBlockId:"block",startOffset:0,endOffset:4}]}]};
  expect(validateAnalysisResponse(raw)).toBe(raw);
  expect(()=>validateAnalysisResponse({summary:"摘要",memory:[{content:"重要事实"}]})).toThrow("ANALYSIS_PROVIDER_RESPONSE_INVALID");
});
