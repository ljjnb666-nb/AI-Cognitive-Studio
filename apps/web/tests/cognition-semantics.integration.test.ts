import { isBibliographicMemory } from "../lib/bibliographic-memory";
import { describe, expect, it } from "vitest";
import { cognitionTypeLabels } from "../lib/cognitions";

describe("Phase 18.2.1 cognition semantics", () => {
  it("keeps claims distinct from source quotations", () => {
    expect(cognitionTypeLabels.CLAIM).toBe("关键主张");
    expect(cognitionTypeLabels.QUOTE).toBe("原文证据");
  });
});

it("只将完整书目条目归入书籍资料", () => {
  expect(isBibliographicMemory("作者为美国的纳西姆·尼古拉斯·塔勒布，译者为雨珂。")).toBe(true);
  expect(isBibliographicMemory("英文原书题为《Antifragile: Things That Gain from Disorder》，英文版权年份为2012年，简体中文译本版权年份为2014年；中文版ISBN为978–7–5086–4333–5。")).toBe(true);
  expect(isBibliographicMemory("作者为此担忧。")).toBe(false);
  expect(isBibliographicMemory("作者为人民服务。")).toBe(false);
  expect(isBibliographicMemory("英文版权年份为2012年，作者认为波动可以增强某些系统。")).toBe(false);
  expect(isBibliographicMemory("ISBN 编码可以作为版本研究的依据。")).toBe(false);
});
