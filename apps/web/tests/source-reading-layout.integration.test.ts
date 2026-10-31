import { describe, expect, it } from "vitest";
import { sourceReadingLayout } from "../lib/source-reading-layout";

describe("extracted text reading layout", () => {
  it("separates merged directory titles from printed page numbers without inventing PDF destinations", () => {
    expect(sourceReadingLayout("目 录序 ........ 1第一部分........ 2第一节........ 3第二节........ 3")).toEqual({ kind: "toc", entries: [
      { title: "序", pageLabel: "1" }, { title: "第一部分", pageLabel: "2" }, { title: "第一节", pageLabel: "3" }, { title: "第二节", pageLabel: "3" },
    ] });
  });
  it("preserves wrapped titles and printed page labels", () => {
    expect(sourceReadingLayout("标题换\n行...... 037下一条...... 039第三条…… 040末条...... 057")).toEqual({ kind: "toc", entries: [
      { title: "标题换\n行", pageLabel: "037" }, { title: "下一条", pageLabel: "039" }, { title: "第三条", pageLabel: "040" }, { title: "末条", pageLabel: "057" },
    ] });
  });
  it.each([
    "正文…… 1这是正文，并非目录。",
    "甲....1乙....2丙....3丁....4未匹配的结尾不能丢失。",
    "甲....4乙....3丙....5丁....6",
    "甲....1乙....2丙....3丁....42024年内容不能作为页码的一部分。",
    ".".repeat(10000),
  ])("keeps ambiguous or partially matched text complete", text => {
    const layout = sourceReadingLayout(text);
    expect(layout.kind).toBe("text");
    if (layout.kind === "text") expect(layout.paragraphs.join("")).toBe(text);
  });
  it("adds reading breaks without changing characters, punctuation or quotations", () => {
    const text = "第一句。第二句？第三句！第四句。\n原有换行和空格 保留。她说：‘原文🙂。’最后一段";
    const layout = sourceReadingLayout(text);
    expect(layout.kind).toBe("text");
    if (layout.kind === "text") { expect(layout.paragraphs.length).toBeGreaterThan(1); expect(layout.paragraphs.join("")).toBe(text); }
  });
});
