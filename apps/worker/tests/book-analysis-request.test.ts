import { describe, expect, it } from "vitest";
import { bookAnalysisMessage } from "../src/book-analysis-request.js";
describe("lossless bounded Book request", () => {
  const spans = [{ sourceBlockId: "actual-block", startOffset: 9, endOffset: 13, text: "事实一。" }, { sourceBlockId: "actual-block-2", startOffset: 0, endOffset: 4, text: "观点二。" }];
  it("sends complete source once and preserves ordered IDs and exact offsets", () => {
    const content = spans.map(s => s.text).join("\n\n");
    const wire = bookAnalysisMessage({ content, sourceEvidence: spans });
    expect(JSON.parse(wire)).toEqual({ sourceEvidence: spans });
    expect(wire.match(/事实一。/g)).toHaveLength(1);
    expect(JSON.parse(wire).sourceEvidence.map((s: { text: string }) => s.text).join("\n\n")).toBe(content);
  });
  it("never discards content absent from evidence", () => {
    expect(JSON.parse(bookAnalysisMessage({ content: "重要的限定条件", sourceEvidence: spans }))).toEqual({ content: "重要的限定条件", sourceEvidence: spans });
  });
  it("preserves derived summaries with no source evidence", () => { expect(bookAnalysisMessage({ content: "章节综合" })).toBe("章节综合"); });
});
