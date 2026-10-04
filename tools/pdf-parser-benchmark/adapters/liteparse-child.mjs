import { readFileSync, writeFileSync } from "node:fs";
import { LiteParse } from "@llamaindex/liteparse";

const args = process.argv.slice(2);
const [input, resultPath] = args;
const ocrRequested = args.includes("--ocr");

function tableText(block) {
  const header = (block.header ?? []).map((cell) => cell.text).join(" | ");
  const rows = (block.rows ?? []).map((row) => row.map((cell) => cell.text).join(" | "));
  return [header, ...rows].filter(Boolean).join("\n");
}

// OCR provenance (Phase 2B spec #6): the binding exposes no engine/model fields,
// so they stay null — what is factual is the requested flag, that the binding
// accepted it (parse succeeded), and its own needsOcr page classification.
function ocrProvenance(needsOcrCount) {
  return {
    ocrModeRequested: ocrRequested,
    ocrEnabled: ocrRequested,
    engine: null,
    model: null,
    modelRevision: null,
    language: null,
    pagesOcrProcessed: null,
    pagesRequiringOcr: needsOcrCount,
    pagesOcrSucceeded: null,
  };
}

try {
  const parser = new LiteParse({
    extractBlocks: true,
    includeComplexity: true,
    quiet: true,
    ocrEnabled: ocrRequested,
    outputFormat: "json",
  });
  const result = await parser.parse(input);
  const pages = result.pages.map((page) => ({
    pageIndex: page.pageNum - 1,
    printedPageLabel: page.pageLabel ?? null,
    needsOcr: page.complexity?.needsOcr ?? false,
    blocks: (page.blocks ?? []).map((block) => ({
      kind: block.kind,
      text: block.text ?? (block.kind === "table" ? tableText(block) : (block.lines ?? []).join("\n")),
      pageIndex: page.pageNum - 1,
      bbox: block.bbox
        ? { x0: block.bbox.x, y0: block.bbox.y, x1: block.bbox.x + block.bbox.width, y1: block.bbox.y + block.bbox.height }
        : null,
      confidence: null,
      sourceMethod: "native-text",
    })),
  }));
  const needsOcrPageIndexes = pages.filter((p) => p.needsOcr).map((p) => p.pageIndex);
  parser.close();
  writeFileSync(
    resultPath,
    JSON.stringify({
      ok: true,
      totalPages: result.totalPages,
      pageErrors: result.pageErrors,
      needsOcrPageIndexes,
      ocr: ocrProvenance(needsOcrPageIndexes.length),
      selfRssMb: process.memoryUsage.rss() / (1024 * 1024),
      pages: pages.map(({ needsOcr, ...rest }) => rest),
    }),
  );
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({ ok: false, error: String(error), ocrRequested }));
  process.exitCode = 3;
}
