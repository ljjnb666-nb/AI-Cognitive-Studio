import { readFileSync, writeFileSync } from "node:fs";
import { LiteParse } from "@llamaindex/liteparse";

const [input, resultPath] = process.argv.slice(2);

function tableText(block) {
  const header = (block.header ?? []).map((cell) => cell.text).join(" | ");
  const rows = (block.rows ?? []).map((row) => row.map((cell) => cell.text).join(" | "));
  return [header, ...rows].filter(Boolean).join("\n");
}

try {
  const parser = new LiteParse({
    extractBlocks: true,
    includeComplexity: true,
    quiet: true,
    ocrEnabled: false,
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
  parser.close();
  writeFileSync(
    resultPath,
    JSON.stringify({
      ok: true,
      totalPages: result.totalPages,
      pageErrors: result.pageErrors,
      needsOcrPageIndexes: pages.filter((p) => p.needsOcr).map((p) => p.pageIndex),
      selfRssMb: process.memoryUsage.rss() / (1024 * 1024),
      pages: pages.map(({ needsOcr, ...rest }) => rest),
    }),
  );
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({ ok: false, error: String(error) }));
  process.exitCode = 3;
}
