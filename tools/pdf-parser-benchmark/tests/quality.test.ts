import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { beforeEach, describe, expect, it } from "vitest";
import { runParser } from "../src/harness.js";
import { evaluateQuality, runQualityEvaluation } from "../src/quality/index.js";
import { parseQualityReport, type QualityReport } from "../src/quality/schema.js";
import { normalizeText } from "../src/quality/metrics.js";
import type { GroundTruth } from "../src/ground-truth.js";
import type { NormalizedOutput } from "../src/schema.js";
import { FIXTURES_ROOT, OUTPUTS_ROOT } from "../src/filesystem-guard.js";

/**
 * Deterministic quality-evaluation tests (Phase 2B spec #23). Pure evaluator
 * tests use synthetic ground truth + synthetic normalized output; harness
 * tests use the real pdfjs child on tiny synthetic fixtures — never any
 * Docling/MinerU model download.
 */

const PAGE_SIZE = { width: 595.28, height: 841.89 };

function makeGroundTruth(overrides: Partial<GroundTruth> = {}): GroundTruth {
  return {
    fixtureId: "quality-unit",
    generator: "tests (synthetic)",
    pages: 2,
    pageSize: PAGE_SIZE,
    ocrRequired: false,
    ocrRequiredPages: [],
    normalizationPolicy: "NFKC + remove whitespace",
    text: "第一章 引言这是第一段正文内容,包含足够多的字符用于匹配。第二段继续展开论述,同样具备足够的长度。第三段出现在第二个物理页面上。第四段继续第二页的内容,长度同样充足。",
    keyMarkers: ["第一章 引言"],
    ocrKeyPhrases: [],
    blocks: [
      { id: "B1", page: 0, column: null, role: "heading", text: "第一章 引言" },
      { id: "B2", page: 0, column: null, role: "paragraph", text: "这是第一段正文内容,包含足够多的字符用于匹配。" },
      { id: "B3", page: 0, column: null, role: "paragraph", text: "第二段继续展开论述,同样具备足够的长度。" },
      { id: "B4", page: 1, column: null, role: "paragraph", text: "第三段出现在第二个物理页面上。" },
      { id: "B5", page: 1, column: null, role: "paragraph", text: "第四段继续第二页的内容,长度同样充足。" },
    ],
    headings: [{ page: 0, text: "第一章 引言" }],
    lists: [],
    tables: [],
    formulas: [],
    noise: [],
    ...overrides,
  };
}

let blockSeq = 0;
function outBlock(kind: string, text: string, pageIndex: number | null, bbox: NormalizedOutput["pages"][number]["blocks"][number]["bbox"] = null): NormalizedOutput["pages"][number]["blocks"][number] {
  blockSeq += 1;
  return { kind, text, pageIndex, bbox, confidence: null, sourceMethod: "synthetic" };
}
function normOutput(pages: Array<{ pageIndex: number; blocks: ReturnType<typeof outBlock>[] }>, ocr?: NormalizedOutput["ocr"]): NormalizedOutput {
  return {
    parser: { name: "synthetic", version: "0" },
    fixtureId: "quality-unit",
    readingOrderAvailable: true,
    pages: pages.map((page) => ({ pageIndex: page.pageIndex, printedPageLabel: null, blocks: page.blocks })),
    ...(ocr ? { ocr } : {}),
  };
}

const PERFECT_OUTPUT = () =>
  normOutput([
    {
      pageIndex: 0,
      blocks: [outBlock("heading", "第一章 引言", 0), outBlock("paragraph", "这是第一段正文内容,包含足够多的字符用于匹配。", 0), outBlock("paragraph", "第二段继续展开论述,同样具备足够的长度。", 0)],
    },
    {
      pageIndex: 1,
      blocks: [outBlock("paragraph", "第三段出现在第二个物理页面上。", 1), outBlock("paragraph", "第四段继续第二页的内容,长度同样充足。", 1)],
    },
  ]);

function evaluate(gt: GroundTruth, normalized: NormalizedOutput): QualityReport {
  return parseQualityReport(
    evaluateQuality({ runId: "unit-run", fixtureId: gt.fixtureId, parserKey: "synthetic", parserMode: "unit", groundTruth: gt, normalized, ocrMetadata: null }),
  );
}

beforeEach(() => {
  blockSeq = 0;
});

describe("deterministic quality evaluation (spec #23)", () => {
  it("1. perfect extraction yields perfect expected metrics", () => {
    const quality = evaluate(makeGroundTruth(), PERFECT_OUTPUT());
    expect(quality.status).toBe("EVALUATED");
    expect(quality.text?.charRecall).toBe(1);
    expect(quality.text?.charPrecision).toBe(1);
    expect(quality.text?.editDistance).toBe(0);
    expect(quality.text?.duplicateRatio).toBe(0);
    expect(quality.text?.missingKeyMarkers).toEqual([]);
    expect(quality.readingOrder?.orderedPairAccuracy).toBe(1);
    expect(quality.readingOrder?.interleavingDetected).toBeNull();
    expect(quality.pages?.pageIndexAccuracy).toBe(1);
    expect(quality.contamination?.noiseCharRatio).toBe(0);
  });

  it("2. missing text is detected via recall, markers and edit distance", () => {
    const gt = makeGroundTruth({ keyMarkers: ["第一章 引言", "第三段出现在第二个物理页面上"] });
    const output = PERFECT_OUTPUT();
    output.pages = output.pages.filter((page) => page.pageIndex === 0);
    const quality = evaluate(gt, output);
    expect(quality.text?.charRecall).toBeLessThan(1);
    expect(quality.text?.editDistance).toBeGreaterThan(0);
    expect(quality.text?.missingKeyMarkers).toContain("第三段出现在第二个物理页面上");
    expect(quality.text?.charRecall).toBeGreaterThan(0.5);
  });

  it("3. duplicate extraction raises duplicateRatio even though charRecall stays high", () => {
    const output = PERFECT_OUTPUT();
    output.pages[0]!.blocks.push(outBlock("paragraph", "这是第一段正文内容,包含足够多的字符用于匹配。", 0));
    const quality = evaluate(makeGroundTruth(), output);
    expect(quality.text?.duplicateRatio).toBeGreaterThan(0);
    expect(quality.text?.charRecall).toBe(1);
    expect(quality.text?.charPrecision).toBeLessThan(1);
    expect(quality.text?.unexpectedRatio).toBeGreaterThan(0);
  });

  it("4. wrong reading order lowers orderedPairAccuracy", () => {
    const output = normOutput([
      {
        pageIndex: 0,
        blocks: [outBlock("heading", "第一章 引言", 0), outBlock("paragraph", "这是第一段正文内容,包含足够多的字符用于匹配。", 0), outBlock("paragraph", "第二段继续展开论述,同样具备足够的长度。", 0)],
      },
      {
        pageIndex: 1,
        blocks: [outBlock("paragraph", "第四段继续第二页的内容,长度同样充足。", 1), outBlock("paragraph", "第三段出现在第二个物理页面上。", 1)],
      },
    ]);
    const quality = evaluate(makeGroundTruth(), output);
    expect(quality.readingOrder?.orderedPairAccuracy).toBeLessThan(1);
    expect(quality.readingOrder?.comparablePairs).toBeGreaterThan(0);
  });

  it("5. two-column interleaving (左1右1左2右2) is detected as degradation", () => {
    const gt = makeGroundTruth({
      pages: 1,
      text: "左栏第一块左栏第二块右栏第一块右栏第二块",
      blocks: [
        { id: "B1", page: 0, column: 0, role: "paragraph", text: "左栏第一块,带有足够长的独特句子。" },
        { id: "B2", page: 0, column: 0, role: "paragraph", text: "左栏第二块,同样带有足够长的独特句子。" },
        { id: "B3", page: 0, column: 1, role: "paragraph", text: "右栏第一块,带有足够长的独特句子。" },
        { id: "B4", page: 0, column: 1, role: "paragraph", text: "右栏第二块,同样带有足够长的独特句子。" },
      ],
      headings: [],
      keyMarkers: [],
    });
    const interleaved = normOutput([
      {
        pageIndex: 0,
        blocks: [
          outBlock("paragraph", "左栏第一块,带有足够长的独特句子。", 0),
          outBlock("paragraph", "右栏第一块,带有足够长的独特句子。", 0),
          outBlock("paragraph", "左栏第二块,同样带有足够长的独特句子。", 0),
          outBlock("paragraph", "右栏第二块,同样带有足够长的独特句子。", 0),
        ],
      },
    ]);
    const degraded = evaluate(gt, interleaved);
    expect(degraded.readingOrder?.interleavingDetected).toBe(true);
    expect(degraded.readingOrder?.columnMajorPreserved).toBe(false);
    expect(degraded.readingOrder?.orderedPairAccuracy).toBeLessThan(1);

    const columnMajor = normOutput([
      {
        pageIndex: 0,
        blocks: [
          outBlock("paragraph", "左栏第一块,带有足够长的独特句子。", 0),
          outBlock("paragraph", "左栏第二块,同样带有足够长的独特句子。", 0),
          outBlock("paragraph", "右栏第一块,带有足够长的独特句子。", 0),
          outBlock("paragraph", "右栏第二块,同样带有足够长的独特句子。", 0),
        ],
      },
    ]);
    const preserved = evaluate(gt, columnMajor);
    expect(preserved.readingOrder?.interleavingDetected).toBe(false);
    expect(preserved.readingOrder?.orderedPairAccuracy).toBe(1);
  });

  it("6. OCR normalization policy folds full-width chars and ignores whitespace only", () => {
    const gt = makeGroundTruth({
      pages: 1,
      ocrRequired: true,
      ocrRequiredPages: [0],
      text: "温度２０２６年度报告",
      ocrKeyPhrases: [{ page: 0, phrase: "温度２０２６年度报告" }],
      blocks: [{ id: "B1", page: 0, column: null, role: "paragraph", text: "温度２０２６年度报告" }],
      headings: [],
      keyMarkers: [],
    });
    const output = normOutput([{ pageIndex: 0, blocks: [outBlock("paragraph", "温度 2026 年度\n\n报告", 0)] }]);
    const quality = evaluate(gt, output);
    expect(quality.text?.charRecall).toBe(1);
    expect(quality.ocr?.charRecall).toBe(1);
    expect(quality.ocr?.keyPhrasesRecovered).toBe(1);
    expect(quality.ocr?.pageCoverage).toBe(1);
    expect(normalizeText("温度 2026 年度\n\n报告")).toBe(normalizeText("温度２０２６年度报告"));
  });

  it("7. OCR missing Chinese characters lowers recall and raises edit distance", () => {
    const gt = makeGroundTruth({
      pages: 1,
      ocrRequired: true,
      ocrRequiredPages: [0],
      text: "扫描识别偶尔会丢失个别汉字导致召回率下降",
      ocrKeyPhrases: [],
      blocks: [{ id: "B1", page: 0, column: null, role: "paragraph", text: "扫描识别偶尔会丢失个别汉字导致召回率下降" }],
      headings: [],
      keyMarkers: [],
    });
    const output = normOutput([{ pageIndex: 0, blocks: [outBlock("paragraph", "扫描识别偶尔会丢失个别汉字导召率下", 0)] }]);
    const quality = evaluate(gt, output);
    expect(quality.ocr?.charRecall).toBeGreaterThan(0.5);
    expect(quality.ocr?.charRecall).toBeLessThan(1);
    expect(quality.ocr?.editDistance).toBeGreaterThan(0);
    expect(quality.ocr?.trigramRecall).toBeLessThan(1);
  });

  it("8. missing table cells are counted, not silently recovered", () => {
    const gt = makeGroundTruth({
      pages: 1,
      blocks: [{ id: "B1", page: 0, column: null, role: "table", text: "名称 数量 备注" }],
      tables: [{ page: 0, rows: 2, cols: 3, cells: [["名称", "数量", "备注"], ["甲物品", "12", "唯一备注值"]] }],
      headings: [],
      keyMarkers: [],
    });
    const output = normOutput([{ pageIndex: 0, blocks: [outBlock("paragraph", "名称 数量 备注 甲物品 12", 0)] }]);
    const quality = evaluate(gt, output);
    expect(quality.table?.cellTextsExpected).toBe(6);
    expect(quality.table?.cellTextsMissing).toBe(1);
    expect(quality.table?.cellTextsRecoveredInPlainText).toBe(5);
  });

  it("9. table flattened to plain text is recorded as such, structural extraction as structural", () => {
    const gt = makeGroundTruth({
      pages: 1,
      blocks: [{ id: "B1", page: 0, column: null, role: "table", text: "名称 数量" }],
      tables: [{ page: 0, rows: 2, cols: 2, cells: [["名称", "数量"], ["甲物品", "12"]] }],
      headings: [],
      keyMarkers: [],
    });
    const flattened = normOutput([{ pageIndex: 0, blocks: [outBlock("paragraph", "名称 数量 甲物品 12", 0)] }]);
    const flattenedQuality = evaluate(gt, flattened);
    expect(flattenedQuality.table?.structuralTablesDetected).toBe(0);
    expect(flattenedQuality.table?.flattenedToText).toBe(true);

    const structural = normOutput([{ pageIndex: 0, blocks: [outBlock("table", "名称 数量 甲物品 12", 0)] }]);
    const structuralQuality = evaluate(gt, structural);
    expect(structuralQuality.table?.structuralTablesDetected).toBe(1);
    expect(structuralQuality.table?.flattenedToText).toBe(false);
    expect(structuralQuality.table?.cellTextsRecoveredStructural).toBe(4);
  });

  it("10. formula unsupported vs preserved vs structural are distinct states", () => {
    const gt = makeGroundTruth({
      pages: 1,
      text: "质能公式 E = m * c^2 与勾股 a^2 + b^2 = c^2",
      blocks: [
        { id: "B1", page: 0, column: null, role: "formula", text: "E = m * c^2" },
        { id: "B2", page: 0, column: null, role: "formula", text: "a^2 + b^2 = c^2" },
      ],
      headings: [],
      keyMarkers: [],
      formulas: [
        { page: 0, display: false, text: "E = m * c^2" },
        { page: 0, display: true, text: "a^2 + b^2 = c^2" },
      ],
    });
    const flattened = evaluate(gt, normOutput([{ pageIndex: 0, blocks: [outBlock("paragraph", "质能公式 E = m * c^2 与勾股 a^2 + b^2 = c^2", 0)] }]));
    expect(flattened.formula?.preservedAsText).toBe(2);
    expect(flattened.formula?.detectedStructural).toBe(0);
    expect(flattened.formula?.structuralEquationKindSeenInRun).toBe(false);

    const structural = evaluate(gt, normOutput([{ pageIndex: 0, blocks: [outBlock("equation", "E = m * c^2", 0), outBlock("equation", "a^2 + b^2 = c^2", 0)] }]));
    expect(structural.formula?.detectedStructural).toBe(2);
    expect(structural.formula?.structuralEquationKindSeenInRun).toBe(true);

    const dropped = evaluate(gt, normOutput([{ pageIndex: 0, blocks: [outBlock("paragraph", "完全无关的内容文本。", 0)] }]));
    expect(dropped.formula?.dropped).toBe(2);
    expect(dropped.formula?.preservedAsText).toBe(0);
  });

  it("11. incorrect page mapping lowers pageIndexAccuracy", () => {
    const output = normOutput([
      {
        pageIndex: 0,
        blocks: [
          outBlock("heading", "第一章 引言", 0),
          outBlock("paragraph", "这是第一段正文内容,包含足够多的字符用于匹配。", 0),
          outBlock("paragraph", "第二段继续展开论述,同样具备足够的长度。", 0),
          outBlock("paragraph", "第三段出现在第二个物理页面上。", 0),
          outBlock("paragraph", "第四段继续第二页的内容,长度同样充足。", 0),
        ],
      },
    ]);
    const quality = evaluate(makeGroundTruth(), output);
    expect(quality.pages?.pageIndexMismatched).toBe(2);
    expect(quality.pages?.pageIndexAccuracy).toBeLessThan(1);
  });

  it("12. invalid bbox is flagged wildly-invalid; valid bbox counted in-bounds", () => {
    const gt = makeGroundTruth({
      pages: 1,
      blocks: [{ id: "B1", page: 0, column: null, role: "paragraph", text: "这是第一段正文内容,包含足够多的字符用于匹配。" }],
      headings: [],
      keyMarkers: [],
    });
    const output = normOutput([
      {
        pageIndex: 0,
        blocks: [
          outBlock("paragraph", "这是第一段正文内容,包含足够多的字符用于匹配。", 0, { x0: -5000, y0: 0, x1: -4000, y1: 50 }),
          outBlock("paragraph", "补充的第二块内容,同样用于边界检查用途。", 0, { x0: 10, y0: 10, x1: 200, y1: 40 }),
        ],
      },
    ]);
    const quality = evaluate(gt, output);
    expect(quality.pages?.bboxSupported).toBe(true);
    expect(quality.pages?.bboxWildlyInvalid).toBe(1);
    expect(quality.pages?.bboxWithinPageBounds).toBe(1);
  });

  it("13. repeated header/footer noise is measured as contamination", () => {
    const gt = makeGroundTruth({
      noise: [
        { kind: "header", text: "合成质量基准" },
        { kind: "footer", text: "第 1 页 — 合成基准测试" },
        { kind: "footer", text: "第 2 页 — 合成基准测试" },
      ],
    });
    const output = PERFECT_OUTPUT();
    output.pages[0]!.blocks.unshift(outBlock("paragraph", "合成质量基准 第 1 页 — 合成基准测试", 0));
    output.pages[1]!.blocks.unshift(outBlock("paragraph", "合成质量基准 第 2 页 — 合成基准测试", 1));
    const quality = evaluate(gt, output);
    expect(quality.contamination?.noiseSources).toBe(3);
    expect(quality.contamination?.noiseOccurrences).toBeGreaterThanOrEqual(3);
    expect(quality.contamination?.noiseCharRatio).toBeGreaterThan(0);
    expect(quality.contamination?.repeatedNoiseBlocks).toBe(2);
  });

  it("14. unknown capabilities remain null (never fabricated zeros)", () => {
    const quality = evaluate(makeGroundTruth(), PERFECT_OUTPUT());
    expect(quality.table?.tablesExpected).toBe(0);
    expect(quality.table?.flattenedToText).toBeNull();
    expect(quality.table?.rowOrderPreserved).toBeNull();
    expect(quality.ocr?.required).toBe(false);
    expect(quality.ocr?.charRecall).toBeNull();
    expect(quality.ocr?.pageCoverage).toBeNull();
    expect(quality.readingOrder?.interleavingDetected).toBeNull();
  });

  it("15. NaN and Infinity are rejected in quality metrics", () => {
    const quality = evaluate(makeGroundTruth(), PERFECT_OUTPUT());
    const infected = structuredClone(quality) as unknown as Record<string, unknown>;
    ((infected.text as Record<string, unknown>).charRecall) = Number.NaN;
    expect(() => parseQualityReport(infected)).toThrow();
    const infected2 = structuredClone(quality) as unknown as Record<string, unknown>;
    ((infected2.text as Record<string, unknown>).editDistance) = Number.POSITIVE_INFINITY;
    expect(() => parseQualityReport(infected2)).toThrow();
  });

  it("16. quality evaluation failure never replaces or corrupts parser output", async () => {
    const normalized = PERFECT_OUTPUT();
    const snapshot = structuredClone(normalized);
    const report = await runQualityEvaluation({
      runId: "unit-run",
      fixtureId: "quality-unit",
      parserKey: "synthetic",
      parserMode: "unit",
      normalized,
      ocrMetadata: null,
      loadGroundTruthFn: async () => ({ status: "LOADED", groundTruth: makeGroundTruth() }),
      evaluateFn: () => {
        throw new Error("SIMULATED_EVALUATOR_CRASH");
      },
    });
    expect(report.status).toBe("QUALITY_EVALUATION_FAILED");
    expect(report.error).toContain("SIMULATED_EVALUATOR_CRASH");
    expect(report.text).toBeNull();
    expect(normalized).toEqual(snapshot);
  });

  it("17+18. quality artifacts are run-scoped and immutable across cold/warm runs", async () => {
    const fixtureId = "quality-immutability";
    await writeTinyPdfWithGroundTruth(fixtureId);
    try {
      const cold = await runParser("pdfjs", "default", fixtureId, { cold: true, skipPreflight: true });
      expect(cold.status).toBe("OK");
      const coldDir = join(OUTPUTS_ROOT, fixtureId, "pdfjs", "runs", cold.result!.run.id);
      const coldQualityPath = join(coldDir, "quality.json");
      const coldQualityRaw = await readFile(coldQualityPath, "utf8");
      const coldQuality = JSON.parse(coldQualityRaw) as QualityReport;
      expect(coldQuality.runId).toBe(cold.result!.run.id);
      expect(coldQuality.status).toBe("EVALUATED");

      const warm = await runParser("pdfjs", "default", fixtureId, { cold: false, skipPreflight: true });
      expect(warm.status).toBe("OK");
      const warmDir = join(OUTPUTS_ROOT, fixtureId, "pdfjs", "runs", warm.result!.run.id);
      const warmQuality = JSON.parse(await readFile(join(warmDir, "quality.json"), "utf8")) as QualityReport;
      expect(warmQuality.runId).toBe(warm.result!.run.id);
      expect(warmQuality.runId).not.toBe(coldQuality.runId);

      // warm run did not touch the cold run's quality artifact
      expect(await readFile(coldQualityPath, "utf8")).toBe(coldQualityRaw);
    } finally {
      await cleanupFixture(fixtureId);
    }
  }, 180_000);

  it("19. malformed ground truth or malformed output cannot fabricate quality", async () => {
    const fixtureId = "quality-malformed";
    await writeTinyPdfWithGroundTruth(fixtureId, "{ this is not valid json");
    try {
      const outcome = await runParser("pdfjs", "default", fixtureId, { cold: true, skipPreflight: true });
      expect(outcome.status).toBe("OK"); // parser evidence unaffected by GT problems
      const runDir = join(OUTPUTS_ROOT, fixtureId, "pdfjs", "runs", outcome.result!.run.id);
      const quality = JSON.parse(await readFile(join(runDir, "quality.json"), "utf8")) as QualityReport;
      expect(quality.status).toBe("SKIPPED_GROUND_TRUTH_INVALID");
      expect(quality.text).toBeNull();
      expect(quality.readingOrder).toBeNull();
    } finally {
      await cleanupFixture(fixtureId);
    }
  }, 180_000);

  it("19b. schema-invalid ground truth is also rejected", async () => {
    const report = await runQualityEvaluation({
      runId: "unit-run",
      fixtureId: "quality-unit",
      parserKey: "synthetic",
      parserMode: "unit",
      normalized: PERFECT_OUTPUT(),
      ocrMetadata: null,
      loadGroundTruthFn: async () => ({ status: "LOADED", groundTruth: { fixtureId: "x" } as unknown as GroundTruth }),
    });
    expect(report.status).toBe("QUALITY_EVALUATION_FAILED");
  });

  it("19c. missing normalized output skips quality without touching parser evidence", async () => {
    const report = await runQualityEvaluation({
      runId: "unit-run",
      fixtureId: "quality-unit",
      parserKey: "synthetic",
      parserMode: "unit",
      normalized: null,
      ocrMetadata: null,
      loadGroundTruthFn: async () => ({ status: "LOADED", groundTruth: makeGroundTruth() }),
    });
    expect(report.status).toBe("SKIPPED_NO_NORMALIZED_OUTPUT");
    const missing = await runQualityEvaluation({
      runId: "unit-run",
      fixtureId: "quality-unit",
      parserKey: "synthetic",
      parserMode: "unit",
      normalized: PERFECT_OUTPUT(),
      ocrMetadata: null,
      loadGroundTruthFn: async () => ({ status: "MISSING" }),
    });
    expect(missing.status).toBe("SKIPPED_GROUND_TRUTH_MISSING");
  });

  it("20. OCR metadata truthfulness: unknown upstream fields stay null, never invented", async () => {
    const gt = makeGroundTruth({
      pages: 1,
      ocrRequired: true,
      ocrRequiredPages: [0],
      text: "扫描页面模拟 1-1:这是光栅化后的中文文本。",
      ocrKeyPhrases: [{ page: 0, phrase: "扫描页面模拟 1-1" }],
      blocks: [{ id: "B1", page: 0, column: null, role: "paragraph", text: "扫描页面模拟 1-1:这是光栅化后的中文文本。" }],
      headings: [],
      keyMarkers: [],
    });
    const metadata = {
      ocrModeRequested: true,
      ocrEnabled: null,
      engine: null,
      model: null,
      modelRevision: null,
      language: null,
      pagesOcrProcessed: null,
      pagesRequiringOcr: null,
      pagesOcrSucceeded: null,
    };
    const report = await runQualityEvaluation({
      runId: "unit-run",
      fixtureId: gt.fixtureId,
      parserKey: "mineru-flash",
      parserMode: "flash",
      normalized: normOutput([{ pageIndex: 0, blocks: [outBlock("paragraph", "扫描页面模拟 1-1:这是光栅化后的中文文本。", 0)] }], metadata),
      ocrMetadata: metadata,
      loadGroundTruthFn: async () => ({ status: "LOADED", groundTruth: gt }),
    });
    expect(report.status).toBe("EVALUATED");
    expect(report.ocr?.metadata?.ocrEnabled).toBeNull();
    expect(report.ocr?.metadata?.engine).toBeNull();
    expect(report.ocr?.metadata?.ocrModeRequested).toBe(true);
    expect(report.ocr?.required).toBe(true);
  });
});

/* ---------- integration helpers ---------- */

async function writeTinyPdfWithGroundTruth(fixtureId: string, groundTruthRaw?: string): Promise<void> {
  await mkdir(FIXTURES_ROOT, { recursive: true });
  const filename = `${fixtureId}.pdf`;
  const path = join(FIXTURES_ROOT, filename);
  const doc = new PDFDocument({ size: "A4", margin: 64 });
  const stream = createWriteStream(path);
  doc.pipe(stream);
  doc.fontSize(14).font("Helvetica").text(`Quality fixture ${fixtureId} page one with synthetic English content.`);
  doc.addPage();
  doc.text("Second page continues the synthetic content for quality evaluation.");
  await new Promise<void>((resolve) => {
    stream.on("finish", () => resolve());
    doc.end();
  });
  const groundTruth =
    groundTruthRaw ??
    JSON.stringify({
      fixtureId,
      generator: "tests (synthetic)",
      pages: 2,
      pageSize: PAGE_SIZE,
      ocrRequired: false,
      ocrRequiredPages: [],
      normalizationPolicy: "NFKC + remove whitespace",
      text: "Quality fixture page one with synthetic English content.Second page continues the synthetic content for quality evaluation.",
      keyMarkers: ["Quality fixture"],
      ocrKeyPhrases: [],
      blocks: [
        { id: "B1", page: 0, column: null, role: "paragraph", text: `Quality fixture ${fixtureId} page one with synthetic English content.` },
        { id: "B2", page: 1, column: null, role: "paragraph", text: "Second page continues the synthetic content for quality evaluation." },
      ],
      headings: [],
      lists: [],
      tables: [],
      formulas: [],
      noise: [],
    });
  await writeFile(join(FIXTURES_ROOT, `${fixtureId}.ground-truth.json`), groundTruth, "utf8");
  await writeFile(
    join(FIXTURES_ROOT, "fixtures.manifest.json"),
    JSON.stringify({
      fixtures: [
        {
          id: fixtureId,
          filename,
          fixtureClass: "native-en",
          generator: "tests (synthetic)",
          declaredPages: 2,
          notes: "quality integration fixture",
        },
      ],
    }),
    "utf8",
  );
}

async function cleanupFixture(fixtureId: string): Promise<void> {
  await rm(join(FIXTURES_ROOT, `${fixtureId}.pdf`), { force: true });
  await rm(join(FIXTURES_ROOT, `${fixtureId}.ground-truth.json`), { force: true });
  await rm(join(FIXTURES_ROOT, "fixtures.manifest.json"), { force: true });
  await rm(join(OUTPUTS_ROOT, fixtureId), { recursive: true, force: true });
}
