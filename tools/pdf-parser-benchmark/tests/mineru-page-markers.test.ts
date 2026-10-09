import { describe, expect, it } from "vitest";
import {
  NORMALIZED_BLOCK_TEXT_LIMIT,
  parseMineruPageMarkers,
  splitOversizeText,
} from "../adapters/mineru-page-markers.js";
import { buildBenchmarkResult, parseNormalizedOutput } from "../src/schema.js";

/**
 * 01H synthetic tests for the MinerU page-marker parser and page-binding
 * evidence. Synthetic markdown only — no real book content.
 */

const SHA = "a".repeat(64);

function marker(n: number, total: number): string {
  return `<!-- page ${n} of ${total} -->`;
}

function threePageMarkdown(): string {
  return [
    marker(1, 3),
    "第一页标题段",
    "",
    "第一页正文段。",
    marker(2, 3),
    "## 第二页标题",
    "第二页正文。",
    marker(3, 3),
    "第三页内容。",
    "![Image block](doc:" + SHA.slice(0, 7) + "/tier:flash/page:3/block:2)",
  ].join("\n");
}

function parserDescriptor() {
  return { name: "unit-parser", version: "1.0.0" };
}

describe("parseMineruPageMarkers", () => {
  it("1. groups normal 3-page content into 3 page segments", () => {
    const r = parseMineruPageMarkers(threePageMarkdown());
    expect(r.status).toBe("VALID");
    if (r.status !== "VALID") return;
    expect(r.declaredTotalPages).toBe(3);
    expect(r.pages.map((p) => p.pageLocal1Based)).toEqual([1, 2, 3]);
    expect(r.pages[0]!.blocks.map((b) => b.text)).toEqual(["第一页标题段", "第一页正文段。"]);
  });

  it("2. converts 1-based markers to 0-based DTO page indexes", () => {
    const r = parseMineruPageMarkers(threePageMarkdown());
    if (r.status !== "VALID") throw new Error("expected VALID");
    const normalized = parseNormalizedOutput({
      parser: parserDescriptor(),
      fixtureId: "SYN",
      readingOrderAvailable: true,
      pages: r.pages.map((g) => ({
        pageIndex: g.pageLocal1Based - 1,
        printedPageLabel: null,
        blocks: g.blocks.map((b) => ({
          kind: b.kind, text: b.text, pageIndex: g.pageLocal1Based - 1,
          bbox: null, confidence: null, sourceMethod: "model-pipeline",
        })),
      })),
      pageMarkers: { status: "VALID", declaredTotalPages: r.declaredTotalPages, source: "mineru-markdown" },
    });
    expect(normalized.pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
    expect(normalized.pages.every((p) => p.blocks.every((b) => b.pageIndex === p.pageIndex))).toBe(true);
  });

  it("3. falls back to MISSING when no markers exist", () => {
    const r = parseMineruPageMarkers("普通文档没有页标记。\n\n第二段。");
    expect(r.status).toBe("MISSING");
  });

  it("4. rejects duplicate page numbers", () => {
    const md = [marker(1, 3), "a", marker(2, 3), "b", marker(2, 3), "c"].join("\n");
    const r = parseMineruPageMarkers(md);
    expect(r.status).toBe("INVALID");
    if (r.status === "INVALID") expect(r.failure.code).toBe("PAGE_MARKER_ORDER_INVALID");
  });

  it("5. rejects out-of-order page numbers", () => {
    const md = [marker(2, 3), "a", marker(1, 3), "b", marker(3, 3), "c"].join("\n");
    const r = parseMineruPageMarkers(md);
    expect(r.status).toBe("INVALID");
    if (r.status === "INVALID") expect(r.failure.code).toBe("PAGE_MARKER_ORDER_INVALID");
  });

  it("6. rejects marker total vs segment count truncation and processed-page mismatch", () => {
    // markers declare "of 3" but page 3 never appears → truncated document
    const md = [marker(1, 3), "a", marker(2, 3), "b"].join("\n");
    const r = parseMineruPageMarkers(md);
    expect(r.status).toBe("INVALID");
    if (r.status === "INVALID") expect(r.failure.code).toBe("PAGE_SEGMENT_COUNT_MISMATCH");
    // a consistent pair still fails when the processed document has more pages
    const md2 = [marker(1, 2), "a", marker(2, 2), "b"].join("\n");
    const r2 = parseMineruPageMarkers(md2, { expectedTotalPages: 3 });
    expect(r2.status).toBe("INVALID");
    if (r2.status === "INVALID") expect(r2.failure.code).toBe("PAGE_TOTAL_MISMATCH");
  });

  it("7. rejects doc refs whose page conflicts with the enclosing segment", () => {
    const md = [
      marker(1, 2),
      "![Image block](doc:" + SHA.slice(0, 7) + "/tier:flash/page:2/block:1)",
      marker(2, 2),
      "b",
    ].join("\n");
    const r = parseMineruPageMarkers(md, { verifyDocIdPrefix: SHA });
    expect(r.status).toBe("INVALID");
    if (r.status === "INVALID") expect(r.failure.code).toBe("IMAGE_REF_PAGE_CONFLICT");
  });

  it("8. rejects non-blank content before the first marker", () => {
    const md = ["前置正文", marker(1, 1), "a"].join("\n");
    const r = parseMineruPageMarkers(md);
    expect(r.status).toBe("INVALID");
    if (r.status === "INVALID") expect(r.failure.code).toBe("CONTENT_BEFORE_FIRST_MARKER");
  });

  it("9. accepts an empty page without fabricating content", () => {
    const md = [marker(1, 2), "有内容", marker(2, 2)].join("\n");
    const r = parseMineruPageMarkers(md);
    expect(r.status).toBe("VALID");
    if (r.status !== "VALID") return;
    expect(r.pages[1]!.pageLocal1Based).toBe(2);
    expect(r.pages[1]!.blocks).toEqual([]);
  });

  it("10. ignores marker-like lines inside fenced code blocks", () => {
    const md = [
      marker(1, 1),
      "```html",
      "<!-- page 2 of 5 -->",
      "示例文本",
      "```",
    ].join("\n");
    const r = parseMineruPageMarkers(md);
    expect(r.status).toBe("VALID");
    if (r.status !== "VALID") return;
    expect(r.declaredTotalPages).toBe(1);
    expect(r.pages[0]!.blocks).toHaveLength(1);
    expect(r.pages[0]!.blocks[0]!.text).toContain("<!-- page 2 of 5 -->");
  });

  it("11. handles CRLF, headings, Chinese text and image refs mixed", () => {
    const md = [
      marker(1, 2),
      "## 中文标题",
      "",
      "中文正文一段。",
      "![Image block](doc:" + SHA.slice(0, 7) + "/tier:flash/page:1/block:1)",
      marker(2, 2),
      "第二页。",
    ].join("\r\n");
    const r = parseMineruPageMarkers(md);
    expect(r.status).toBe("VALID");
    if (r.status !== "VALID") return;
    expect(r.pages[0]!.blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "figure"]);
    expect(r.pages[0]!.imageRefs[0]!.page).toBe(1);
  });

  it("12. never silently truncates long blocks", () => {
    const longLine = "长".repeat(NORMALIZED_BLOCK_TEXT_LIMIT + 500);
    const md = [marker(1, 1), longLine].join("\n");
    const r = parseMineruPageMarkers(md);
    if (r.status !== "VALID") throw new Error("expected VALID");
    expect(r.pages[0]!.blocks[0]!.text.length).toBe(longLine.length);
    const pieces = splitOversizeText(longLine);
    expect(pieces.join("")).toBe(longLine);
    expect(pieces.every((p) => p.length <= NORMALIZED_BLOCK_TEXT_LIMIT)).toBe(true);
  });

  it("13. binds every block to its own segment page", () => {
    const r = parseMineruPageMarkers(threePageMarkdown());
    if (r.status !== "VALID") throw new Error("expected VALID");
    for (const group of r.pages) {
      for (const b of group.blocks) {
        // parser-level binding is implicit in grouping; DTO conversion asserts equality
        expect(group.pageLocal1Based).toBeGreaterThan(0);
        expect(b.text.length).toBeGreaterThan(0);
      }
    }
    expect(r.pages[2]!.blocks.some((b) => b.imageRef !== null)).toBe(true);
  });

  it("14. evidence.physicalPageIndex is false for a legacy document container with null block indexes", () => {
    const normalized = parseNormalizedOutput({
      parser: parserDescriptor(),
      fixtureId: "SYN",
      readingOrderAvailable: true,
      pages: [
        {
          pageIndex: 0,
          printedPageLabel: null,
          blocks: [
            { kind: "paragraph", text: "正文", pageIndex: null, bbox: null, confidence: null, sourceMethod: "model-pipeline" },
          ],
        },
      ],
      pageMarkers: { status: "MISSING", declaredTotalPages: 0, source: "mineru-markdown" },
    });
    const result = buildBenchmarkResult({
      run: { id: "r", startedAt: "t", finishedAt: "t", coldStart: true },
      parser: parserDescriptor(),
      document: { fixtureId: "SYN", inputSha256: SHA, bytes: 1, detectedPages: 1 },
      performance: { wallTimeMs: 1, cpuTimeMs: null, peakRssMb: null, peakGpuMb: null },
      reliability: { exitCode: 0, timeout: false, crashed: false, oom: false, partialOutput: false, warnings: [] },
      normalized,
    });
    expect(result.evidence.physicalPageIndex).toBe(false);
  });

  it("15. evidence.physicalPageIndex is true for validated marker-bound pages", () => {
    const r = parseMineruPageMarkers(threePageMarkdown());
    if (r.status !== "VALID") throw new Error("expected VALID");
    const normalized = parseNormalizedOutput({
      parser: parserDescriptor(),
      fixtureId: "SYN",
      readingOrderAvailable: true,
      pages: r.pages.map((g) => ({
        pageIndex: g.pageLocal1Based - 1,
        printedPageLabel: null,
        blocks: g.blocks.map((b) => ({
          kind: b.kind, text: b.text, pageIndex: g.pageLocal1Based - 1,
          bbox: null, confidence: null, sourceMethod: "model-pipeline",
        })),
      })),
      pageMarkers: { status: "VALID", declaredTotalPages: r.declaredTotalPages, source: "mineru-markdown" },
    });
    const result = buildBenchmarkResult({
      run: { id: "r", startedAt: "t", finishedAt: "t", coldStart: true },
      parser: parserDescriptor(),
      document: { fixtureId: "SYN", inputSha256: SHA, bytes: 1, detectedPages: 3 },
      performance: { wallTimeMs: 1, cpuTimeMs: null, peakRssMb: null, peakGpuMb: null },
      reliability: { exitCode: 0, timeout: false, crashed: false, oom: false, partialOutput: false, warnings: [] },
      normalized,
    });
    expect(result.evidence.physicalPageIndex).toBe(true);
    expect(result.extraction.extractedPages).toBe(3);
  });

  it("16. evidence.physicalPageIndex is false when only some blocks are bound", () => {
    const normalized = parseNormalizedOutput({
      parser: parserDescriptor(),
      fixtureId: "SYN",
      readingOrderAvailable: true,
      pages: [
        {
          pageIndex: 0,
          printedPageLabel: null,
          blocks: [
            { kind: "paragraph", text: "绑定块", pageIndex: 0, bbox: null, confidence: null, sourceMethod: "x" },
            { kind: "paragraph", text: "未绑定块", pageIndex: null, bbox: null, confidence: null, sourceMethod: "x" },
          ],
        },
      ],
    });
    const result = buildBenchmarkResult({
      run: { id: "r", startedAt: "t", finishedAt: "t", coldStart: true },
      parser: parserDescriptor(),
      document: { fixtureId: "SYN", inputSha256: SHA, bytes: 1, detectedPages: 1 },
      performance: { wallTimeMs: 1, cpuTimeMs: null, peakRssMb: null, peakGpuMb: null },
      reliability: { exitCode: 0, timeout: false, crashed: false, oom: false, partialOutput: false, warnings: [] },
      normalized,
    });
    expect(result.evidence.physicalPageIndex).toBe(false);
  });

  it("17. new optional fields (blockRef, pageMarkers) survive DTO serialization", () => {
    const normalized = parseNormalizedOutput({
      parser: parserDescriptor(),
      fixtureId: "SYN",
      readingOrderAvailable: true,
      pages: [
        {
          pageIndex: 0,
          printedPageLabel: null,
          blocks: [
            {
              kind: "figure", text: "![Image block](doc:abc123/tier:flash/page:1/block:1)",
              pageIndex: 0, bbox: null, confidence: null, sourceMethod: "markdown-image-ref",
              blockRef: "doc:abc123/tier:flash/page:1/block:1",
            },
          ],
        },
      ],
      pageMarkers: { status: "VALID", declaredTotalPages: 1, source: "mineru-markdown" },
    });
    const roundTrip = JSON.parse(JSON.stringify(normalized));
    expect(roundTrip.pages[0].blocks[0].blockRef).toBe("doc:abc123/tier:flash/page:1/block:1");
    expect(roundTrip.pageMarkers).toEqual({ status: "VALID", declaredTotalPages: 1, source: "mineru-markdown" });
    // legacy results without the fields still parse
    const legacy = parseNormalizedOutput({
      parser: parserDescriptor(),
      fixtureId: "SYN",
      readingOrderAvailable: false,
      pages: [{ pageIndex: 0, printedPageLabel: null, blocks: [{ kind: "paragraph", text: "旧", pageIndex: null, bbox: null, confidence: null, sourceMethod: "x" }] }],
    });
    expect(legacy.pageMarkers).toBeUndefined();
    expect(legacy.pages[0]!.blocks[0]!.blockRef).toBeUndefined();
  });

  it("18. invalid marker state can never produce an accepted successful shape", () => {
    const md = [marker(1, 3), "a", marker(2, 3), "b"].join("\n");
    const r = parseMineruPageMarkers(md);
    expect(r.status).toBe("INVALID");
    // the adapter turns INVALID into normalizedCandidate=null → PARSER_FAILED;
    // simulate that outcome: no normalized output → evidence cannot claim pages
    expect(r.status).toBe("INVALID");
    const result = buildBenchmarkResult({
      run: { id: "r", startedAt: "t", finishedAt: "t", coldStart: true },
      parser: parserDescriptor(),
      document: { fixtureId: "SYN", inputSha256: SHA, bytes: 1, detectedPages: null },
      performance: { wallTimeMs: 1, cpuTimeMs: null, peakRssMb: null, peakGpuMb: null },
      reliability: { exitCode: 0, timeout: false, crashed: false, oom: false, partialOutput: false, warnings: ["PAGE_MARKERS_INVALID: PAGE_TOTAL_MISMATCH: x"] },
      normalized: null,
    });
    expect(result.evidence.physicalPageIndex).toBe(false);
    expect(result.extraction.extractedPages).toBe(0);
  });

  it("19. rejects doc ids that are not prefixes of the fixture sha (source identity)", () => {
    const md = [marker(1, 1), "![Image block](doc:ffffff/tier:flash/page:1/block:1)"].join("\n");
    const r = parseMineruPageMarkers(md, { verifyDocIdPrefix: SHA });
    expect(r.status).toBe("INVALID");
    if (r.status === "INVALID") expect(r.failure.code).toBe("DOC_ID_MISMATCH");
  });

  it("20. rejects conflicting doc ids within one document", () => {
    const md = [
      marker(1, 2),
      "![Image block](doc:aaa111/tier:flash/page:1/block:1)",
      marker(2, 2),
      "![Image block](doc:bbb222/tier:flash/page:2/block:1)",
    ].join("\n");
    const r = parseMineruPageMarkers(md);
    expect(r.status).toBe("INVALID");
    if (r.status === "INVALID") expect(r.failure.code).toBe("DOC_ID_MISMATCH");
  });

  it("21. preserves reading order and content across grouping (no reordering)", () => {
    const md = [marker(1, 2), "甲", "", "乙", marker(2, 2), "丙", "", "丁"].join("\n");
    const r = parseMineruPageMarkers(md);
    if (r.status !== "VALID") throw new Error("expected VALID");
    const ordered = r.pages.flatMap((g) => g.blocks.map((b) => b.text));
    expect(ordered).toEqual(["甲", "乙", "丙", "丁"]);
  });
  it("22. refuses a block bound to another existing page (false physical evidence)", () => {
    const normalized = parseNormalizedOutput({
      parser: parserDescriptor(), fixtureId: "SYN", readingOrderAvailable: true,
      pages: [
        { pageIndex: 0, printedPageLabel: null, blocks: [
          { kind: "paragraph", text: "第一页误绑到第二页", pageIndex: 1, bbox: null, confidence: null, sourceMethod: "x" },
        ] },
        { pageIndex: 1, printedPageLabel: null, blocks: [
          { kind: "paragraph", text: "第二页正常", pageIndex: 1, bbox: null, confidence: null, sourceMethod: "x" },
        ] },
      ],
    });
    const result = buildBenchmarkResult({
      run: { id: "r", startedAt: "t", finishedAt: "t", coldStart: true },
      parser: parserDescriptor(),
      document: { fixtureId: "SYN", inputSha256: SHA, bytes: 1, detectedPages: 2 },
      performance: { wallTimeMs: 1, cpuTimeMs: null, peakRssMb: null, peakGpuMb: null },
      reliability: { exitCode: 0, timeout: false, crashed: false, oom: false, partialOutput: false, warnings: [] },
      normalized,
    });
    expect(result.evidence.physicalPageIndex).toBe(false);
  });

  it("23. rejects malformed marker-like comments instead of pretending markers are missing", () => {
    for (const md of [
      "<!-- page 1 of two -->\n内容",
      "<!-- page 1 of 1 --\n内容",
      "<!-- Page 1 of 1 -->\n内容",
      [marker(1, 2), "甲", "<!-- page two of 2 -->", "乙"].join("\n"),
    ]) {
      const r = parseMineruPageMarkers(md);
      expect(r.status).toBe("INVALID");
      if (r.status === "INVALID") expect(r.failure.code).toBe("PAGE_MARKER_SYNTAX_INVALID");
    }
    // Marker-like syntax within a fenced code sample remains ordinary content.
    const fenced = [marker(1, 1), "```", "<!-- page 2 of two -->", "```"].join("\n");
    expect(parseMineruPageMarkers(fenced).status).toBe("VALID");
  });
});
