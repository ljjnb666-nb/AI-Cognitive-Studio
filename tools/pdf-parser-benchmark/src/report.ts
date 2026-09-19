import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OUTPUTS_ROOT } from "./filesystem-guard.js";
import type { BenchmarkResult } from "./schema.js";

export type AggregateReport = {
  markdown: string;
  results: BenchmarkResult[];
};

/**
 * Aggregates every outputs/<fixture>/<parser>/result.json into a factual
 * summary: metrics table + capability matrix + text samples. Facts only —
 * no scores, no winner (#40).
 */
export async function buildAggregateReport(): Promise<AggregateReport> {
  const results: BenchmarkResult[] = [];
  const fixtureDirs = await readdir(OUTPUTS_ROOT, { withFileTypes: true }).catch(() => []);
  for (const fixtureDir of fixtureDirs.filter((entry) => entry.isDirectory())) {
    const parserDirs = await readdir(join(OUTPUTS_ROOT, fixtureDir.name), { withFileTypes: true }).catch(() => []);
    for (const parserDir of parserDirs.filter((entry) => entry.isDirectory())) {
      const resultPath = join(OUTPUTS_ROOT, fixtureDir.name, parserDir.name, "result.json");
      const raw = await readFile(resultPath, "utf8").catch(() => null);
      if (!raw) continue;
      try {
        results.push(JSON.parse(raw) as BenchmarkResult);
      } catch {
        // unreadable result — skip, note below
      }
    }
  }

  const lines: string[] = [];
  lines.push("# PDF Parser Smoke Benchmark — Factual Summary");
  lines.push("");
  lines.push("Phase 1 smoke results. Facts only; no scoring and no winner determination (#40).");
  lines.push("");

  lines.push("## Metrics (per run)");
  lines.push("");
  lines.push("| fixture | parser | cold | status | wall ms | peak RSS MB | pages | chars | blocks | exit | timeout |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const result of results.sort((a, b) => a.document.fixtureId.localeCompare(b.document.fixtureId) || a.parser.name.localeCompare(b.parser.name))) {
    lines.push(
      `| ${result.document.fixtureId} | ${result.parser.name}${result.parser.mode && result.parser.mode !== "default" ? `:${result.parser.mode}` : ""} | ${result.run.coldStart ? "C" : "W"} | ${result.reliability.crashed ? "FAILED" : "OK"} | ${result.performance.wallTimeMs} | ${result.performance.peakRssMb ?? "n/a"} | ${result.extraction.extractedPages} | ${result.extraction.characters} | ${result.extraction.blocks} | ${result.reliability.exitCode ?? "null"} | ${result.reliability.timeout} |`,
    );
  }
  lines.push("");

  lines.push("## Warnings / failures");
  lines.push("");
  for (const result of results) {
    for (const warning of result.reliability.warnings) lines.push(`- ${result.document.fixtureId} / ${result.parser.name}: ${warning}`);
  }
  lines.push("");

  lines.push("## Capability matrix (observed across ALL fixtures per parser)");
  lines.push("");
  lines.push("| parser | page | bbox | heading | table | figure | equation | list | rule | reading-order | confidence | printed-label |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const byParser = new Map<string, BenchmarkResult[]>();
  for (const result of results) {
    const list = byParser.get(resultKey(result)) ?? [];
    list.push(result);
    byParser.set(resultKey(result), list);
  }
  for (const [key, group] of byParser.entries()) {
    const kinds = new Set<string>();
    let bbox = false;
    let page = false;
    let readingOrder = false;
    let confidence = false;
    let printedLabel = false;
    for (const result of group) {
      const normalizedPath = join(OUTPUTS_ROOT, result.document.fixtureId, key, "normalized.json");
      const raw = await readFile(normalizedPath, "utf8").catch(() => null);
      if (!raw) continue;
      const normalized = JSON.parse(raw) as { pages: Array<{ pageIndex: number; printedPageLabel: string | null; blocks: Array<{ kind: string; bbox: unknown; confidence: unknown }> }> };
      for (const pageEntry of normalized.pages) {
        if (Number.isInteger(pageEntry.pageIndex)) page = true;
        if (pageEntry.printedPageLabel !== null) printedLabel = true;
        for (const block of pageEntry.blocks) {
          kinds.add(block.kind);
          if (block.bbox !== null) bbox = true;
          if (block.confidence !== null) confidence = true;
        }
      }
      readingOrder = readingOrder || group.some((g) => g.evidence.readingOrder);
    }
    const has = (kind: string) => (kinds.has(kind) ? "true" : "false");
    lines.push(
      `| ${key} | ${page} | ${bbox} | ${has("heading")} | ${has("table")} | ${has("figure")} | ${has("equation")} | ${has("list_item")} | ${has("rule")} | ${readingOrder} | ${confidence} | ${printedLabel} |`,
    );
  }
  lines.push("");

  lines.push("## Text samples (first page, up to 3 blocks, 300 chars each)");
  lines.push("");
  for (const [key, group] of byParser.entries()) {
    lines.push(`### ${key}`);
    const first = group[0]!;
    const normalizedPath = join(OUTPUTS_ROOT, first.document.fixtureId, key, "normalized.json");
    const raw = await readFile(normalizedPath, "utf8").catch(() => null);
    if (!raw) {
      lines.push("_no normalized output_");
      continue;
    }
    const normalized = JSON.parse(raw) as { pages: Array<{ blocks: Array<{ kind: string; text: string }> }> };
    for (const block of (normalized.pages[0]?.blocks ?? []).slice(0, 3)) {
      lines.push(`- [${block.kind}] ${block.text.slice(0, 300).replaceAll("\n", " ⏎ ")}`);
    }
    lines.push("");
  }

  return { markdown: lines.join("\n"), results };
}

function resultKey(result: BenchmarkResult): string {
  return result.parser.name === "mineru" ? `mineru-${result.parser.mode ?? "flash"}` : result.parser.name === "pdfjs-isolated" ? "pdfjs" : result.parser.name;
}
