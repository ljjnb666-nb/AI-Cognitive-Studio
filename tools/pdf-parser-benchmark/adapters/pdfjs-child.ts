import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "../../../packages/ingestion/src/document-parsers.js";

/**
 * Benchmark child: drives the REAL production parser entry point
 * (packages/ingestion parseDocument → pdfjs-isolated child spawn, production
 * limits). This file is never imported by the harness process; it only runs
 * as a spawned child. Output JSON is treated as untrusted data by the harness.
 */
const [input, resultPath] = process.argv.slice(2);
if (!input || !resultPath) {
  console.error("USAGE: node pdfjs-child.ts <input.pdf> <result.json>");
  process.exit(2);
}
try {
  const bytes = new Uint8Array(readFileSync(input));
  const parsed = await parseDocument(bytes, "application/pdf");
  writeFileSync(resultPath, JSON.stringify({ ok: true, parser: parsed.parser, selfRssMb: process.memoryUsage.rss() / (1024 * 1024), pages: parsed.pages }));
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), selfRssMb: process.memoryUsage.rss() / (1024 * 1024) }));
  process.exitCode = 3;
}
