import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OUTPUTS_ROOT } from "./filesystem-guard.js";
import { parseBenchmarkResult, parseNormalizedOutput, type BenchmarkResult, type NormalizedOutput } from "./schema.js";
import { parseQualityReport, type QualityReport } from "./quality/schema.js";
import { isSuccessfulReliability } from "./outcome-gate.js";

export type AggregateReport = {
  markdown: string;
  results: BenchmarkResult[];
  /** Run directories whose evidence exists but could not be trusted as a result. */
  skipped: Array<{ path: string; reason: string }>;
  quality: QualityReport[];
};

type RunEntry = {
  parserKey: string;
  runId: string;
  runDir: string;
  result: BenchmarkResult;
};

/**
 * Aggregates EVERY persisted run directory (outputs/<fixture>/<parser>/runs/
 * <runId>/result.json) into a factual summary. Each execution — cold, warm,
 * repeated or failed — appears as its own row; nothing is merged or averaged
 * (#40 facts only, no scoring, no winner). Incomplete or corrupt run dirs are
 * reported as skipped-invalid artifacts instead of crashing the report or
 * silently passing.
 */
export async function buildAggregateReport(): Promise<AggregateReport> {
  const results: BenchmarkResult[] = [];
  const entries: RunEntry[] = [];
  const quality: QualityReport[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const fixtureDirs = await readdir(OUTPUTS_ROOT, { withFileTypes: true }).catch(() => []);
  for (const fixtureDir of fixtureDirs.filter((entry) => entry.isDirectory())) {
    const parserDirs = await readdir(join(OUTPUTS_ROOT, fixtureDir.name), { withFileTypes: true }).catch(() => []);
    for (const parserDir of parserDirs.filter((entry) => entry.isDirectory())) {
      const runsRoot = join(OUTPUTS_ROOT, fixtureDir.name, parserDir.name, "runs");
      const runDirs = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
      for (const runDir of runDirs.filter((entry) => entry.isDirectory())) {
        const runPath = join(runsRoot, runDir.name);
        const resultPath = join(runPath, "result.json");
        const raw = await readFile(resultPath, "utf8").catch(() => null);
        if (raw === null) {
          skipped.push({ path: runPath, reason: "INCOMPLETE_RUN: no result.json (run never finished or crash before completion marker)" });
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          skipped.push({ path: resultPath, reason: "UNPARSABLE_RESULT: result.json is not valid JSON" });
          continue;
        }
        let result: BenchmarkResult;
        try {
          result = parseBenchmarkResult(parsed);
          results.push(result);
          entries.push({ parserKey: parserDir.name, runId: runDir.name, runDir: runPath, result });
        } catch (error) {
          skipped.push({ path: resultPath, reason: `SCHEMA_INVALID_RESULT: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
        // quality sidecar is additive evidence: an invalid quality.json is reported, never fatal
        const qualityRaw = await readFile(join(runPath, "quality.json"), "utf8").catch(() => null);
        if (qualityRaw !== null) {
          try {
            const sidecar = parseQualityReport(JSON.parse(qualityRaw));
            const sidecarPath = join(runPath, "quality.json");
            if (sidecar.runId !== runDir.name || sidecar.fixtureId !== result.document.fixtureId || sidecar.parserKey !== parserDir.name) {
              skipped.push({ path: sidecarPath, reason: "QUALITY_IDENTITY_MISMATCH: quality sidecar belongs to a different run" });
            } else if (sidecar.status === "EVALUATED" &&
                       (!isSuccessfulReliability(result.reliability) ||
                        (await readRunNormalized(runPath, result.document.fixtureId)) === null)) {
              skipped.push({ path: sidecarPath, reason: "UNTRUSTED_EVALUATED_QUALITY: parser run has no accepted normalized evidence" });
            } else {
              quality.push(sidecar);
            }
          } catch (error) {
            skipped.push({ path: join(runPath, "quality.json"), reason: `INVALID_QUALITY_SIDECAR: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
      }
    }
  }

  entries.sort(
    (a, b) =>
      a.result.document.fixtureId.localeCompare(b.result.document.fixtureId) ||
      a.parserKey.localeCompare(b.parserKey) ||
      a.runId.localeCompare(b.runId),
  );

  const lines: string[] = [];
  lines.push("# PDF Parser Smoke Benchmark — Factual Summary");
  lines.push("");
  lines.push("Aggregated from every persisted run directory. Facts only; no scoring and no winner determination (#40). Cold and warm runs are separate rows and are never merged or averaged.");
  lines.push("");

  lines.push(`## Metrics (per run, ${entries.length} run${entries.length === 1 ? "" : "s"})`);
  lines.push("");
  if (entries.length === 0 && skipped.length === 0) lines.push("_No persisted runs found._");
  lines.push("| fixture | parser | run id | cold | status | wall ms | peak RSS MB | pages | chars | blocks | exit | timeout | warnings |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of entries) {
    const r = entry.result;
    // A result.json alone cannot prove a successful parser execution.
    // Old runs with missing normalized.json or non-null failureKind are failed.
    const failed = !isSuccessfulReliability(r.reliability) ||
      (await readRunNormalized(entry.runDir, entry.result.document.fixtureId)) === null;
    lines.push(
      `| ${r.document.fixtureId} | ${entry.parserKey} | ${entry.runId} | ${r.run.coldStart ? "COLD" : "WARM"} | ${failed ? "FAILED" : "OK"} | ${r.performance.wallTimeMs} | ${r.performance.peakRssMb ?? "n/a"} | ${r.extraction.extractedPages} | ${r.extraction.characters} | ${r.extraction.blocks} | ${r.reliability.exitCode ?? "null"} | ${r.reliability.timeout} | ${r.reliability.warnings.length} |`,
    );
  }
  lines.push("");

  lines.push("## Warnings / failures");
  lines.push("");
  let warningCount = 0;
  for (const entry of entries) {
    for (const warning of entry.result.reliability.warnings) {
      warningCount++;
      lines.push(`- ${entry.result.document.fixtureId} / ${entry.parserKey} / ${entry.runId}: ${warning}`);
    }
  }
  if (warningCount === 0) lines.push("_none._");
  lines.push("");

  lines.push("## Skipped / invalid artifacts");
  lines.push("");
  if (skipped.length === 0) lines.push("_none._");
  for (const item of skipped) lines.push(`- SKIPPED_INVALID_ARTIFACT ${item.path}: ${item.reason}`);
  lines.push("");

  lines.push("## Capability matrix (observed across ALL persisted runs per parser)");
  lines.push("");
  lines.push("| parser | page | bbox | heading | table | figure | equation | list | rule | reading-order | confidence | printed-label | ocr |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const byParser = new Map<string, RunEntry[]>();
  for (const entry of entries) {
    const list = byParser.get(entry.parserKey) ?? [];
    list.push(entry);
    byParser.set(entry.parserKey, list);
  }
  for (const [key, group] of byParser.entries()) {
    const kinds = new Set<string>();
    let bbox = false;
    let page = false;
    let readingOrder = false;
    let confidence = false;
    let printedLabel = false;
    let ocrEnabledSeen = false;
    let ocrRequestedSeen = false;
    let ocrFieldSeen = false;
    for (const entry of group) {
      const normalized = await readAcceptedRunNormalized(entry);
      if (!normalized) continue;
      if (normalized.ocr !== undefined) {
        ocrFieldSeen = true;
        if (normalized.ocr.ocrEnabled === true) ocrEnabledSeen = true;
        if (normalized.ocr.ocrModeRequested) ocrRequestedSeen = true;
      }
      for (const pageEntry of normalized.pages) {
        if (Number.isInteger(pageEntry.pageIndex)) page = true;
        if (pageEntry.printedPageLabel !== null) printedLabel = true;
        for (const block of pageEntry.blocks) {
          kinds.add(block.kind);
          if (block.bbox !== null) bbox = true;
          if (block.confidence !== null) confidence = true;
        }
      }
      readingOrder = readingOrder || normalized.readingOrderAvailable || entry.result.evidence.readingOrder;
    }
    const has = (kind: string) => (kinds.has(kind) ? "true" : "false");
    const ocrCell = !ocrFieldSeen
      ? "not-recorded"
      : ocrEnabledSeen
        ? "enabled (upstream-reported)"
        : ocrRequestedSeen
          ? "mode-requested; upstream-report=null"
          : byParser.has(`${key}-ocr`)
            ? "native mode; OCR is a separate mode row"
            : "OCR_UNSUPPORTED (observed ocrEnabled=false)";
    lines.push(
      `| ${key} | ${page} | ${bbox} | ${has("heading")} | ${has("table")} | ${has("figure")} | ${has("equation")} | ${has("list_item")} | ${has("rule")} | ${readingOrder} | ${confidence} | ${printedLabel} | ${ocrCell} |`,
    );
  }
  lines.push("");

  lines.push("## Text samples (first run per parser, first page, up to 3 blocks, 300 chars each)");
  lines.push("");
  for (const [key, group] of byParser.entries()) {
    lines.push(`### ${key}`);
    let normalized: NormalizedOutput | null = null;
    for (const entry of group) {
      normalized = await readAcceptedRunNormalized(entry);
      if (normalized) break;
    }
    if (!normalized) {
      lines.push("_no accepted normalized output_");
      continue;
    }
    for (const block of (normalized.pages[0]?.blocks ?? []).slice(0, 3)) {
      lines.push(`- [${block.kind}] ${block.text.slice(0, 300).replaceAll("\n", " ⏎ ")}`);
    }
    lines.push("");
  }

  appendQualitySections(lines, quality);

  return { markdown: lines.join("\n"), results, skipped, quality };
}

/** Historical failed runs may retain normalized files for diagnostics, not accepted evidence. */
async function readAcceptedRunNormalized(entry: RunEntry): Promise<NormalizedOutput | null> {
  return isSuccessfulReliability(entry.result.reliability)
    ? readRunNormalized(entry.runDir, entry.result.document.fixtureId)
    : null;
}

const pct = (value: number | null | undefined): string =>
  value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
const num = (value: number | null | undefined): string => (value === null || value === undefined ? "n/a" : String(value));

/**
 * Quality sections (Phase 2B spec #17): native-text modes and OCR-enabled
 * modes are reported in SEPARATE tables (distinct parserKey suffixes), never
 * mixed. Facts only — no total score, no winner.
 */
function appendQualitySections(lines: string[], quality: QualityReport[]): void {
  const evaluated = quality.filter((q) => q.status === "EVALUATED");
  const nonEvaluated = quality.filter((q) => q.status !== "EVALUATED");
  const isOcrKey = (key: string) => key.endsWith("-ocr");

  for (const [label, group, filter] of [
    ["Quality — native-text modes", evaluated.filter((q) => !isOcrKey(q.parserKey)), (q: QualityReport) => !isOcrKey(q.parserKey)],
    ["Quality — OCR-enabled modes", evaluated.filter((q) => isOcrKey(q.parserKey)), (q: QualityReport) => isOcrKey(q.parserKey)],
  ] as const) {
    lines.push(`## ${label}`);
    lines.push("");
    const rows = evaluated.filter(filter);
    if (rows.length === 0) {
      lines.push("_no evaluated runs in this mode group._");
      lines.push("");
      continue;
    }
    lines.push("| fixture | parser | run | text recall | trigram recall | edit dist | dup ratio | unexpected | order pairs | interleave | pages acc | bbox valid | table cells struct | flattened | formula struct | OCR recall | noise ratio |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const q of rows) {
      const order = q.readingOrder;
      const orderPairs = order && order.orderedPairAccuracy !== null ? `${pct(order.orderedPairAccuracy)} (${order.correctPairs}/${order.comparablePairs})` : "n/a";
      const interleave = order ? (order.interleavingDetected === null ? "n/a" : String(order.interleavingDetected)) : "n/a";
      const pages = q.pages;
      const bboxCell = pages
        ? pages.bboxSupported && pages.bboxBlocks !== null && pages.bboxBlocks > 0
          ? pct(pages.bboxWithinPageBounds === null ? null : pages.bboxWithinPageBounds / pages.bboxBlocks)
          : "unsupported"
        : "n/a";
      const table = q.table;
      const tableCells = table ? `${table.cellTextsRecoveredStructural}/${table.cellTextsExpected}` : "n/a";
      const flattened = table ? (table.flattenedToText === null ? "n/a" : String(table.flattenedToText)) : "n/a";
      const formula = q.formula ? `${q.formula.detectedStructural}/${q.formula.formulasExpected}` : "n/a";
      const ocrRecall = q.ocr?.required ? pct(q.ocr.charRecall) : "n/a";
      lines.push(
        `| ${q.fixtureId} | ${q.parserKey} | ${q.runId} | ${pct(q.text?.charRecall)} | ${pct(q.text?.trigramRecall)} | ${num(q.text?.editDistance)} | ${pct(q.text?.duplicateRatio)} | ${pct(q.text?.unexpectedRatio)} | ${orderPairs} | ${interleave} | ${pct(pages?.pageIndexAccuracy ?? null)} | ${bboxCell} | ${tableCells} | ${flattened} | ${formula} | ${ocrRecall} | ${pct(q.contamination?.noiseCharRatio ?? null)} |`,
      );
    }
    lines.push("");
  }

  if (nonEvaluated.length > 0) {
    lines.push("## Quality sidecar statuses (non-evaluated)");
    lines.push("");
    for (const q of nonEvaluated) {
      lines.push(`- ${q.fixtureId} / ${q.parserKey} / ${q.runId}: ${q.status}${q.error ? ` (${q.error})` : ""}`);
    }
    lines.push("");
  }
}

/**
 * Validate a persisted normalized artifact before using it as run evidence.
 * JSON syntax alone is insufficient: the DTO must be valid and belong to
 * the same fixture as the authoritative result.json in this run directory.
 */
export function parseRunNormalizedArtifact(raw: unknown, expectedFixtureId: string): NormalizedOutput | null {
  try {
    const normalized = parseNormalizedOutput(raw);
    return normalized.fixtureId === expectedFixtureId ? normalized : null;
  } catch {
    return null;
  }
}

async function readRunNormalized(runDir: string, expectedFixtureId: string): Promise<NormalizedOutput | null> {
  const raw = await readFile(join(runDir, "normalized.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    return parseRunNormalizedArtifact(JSON.parse(raw), expectedFixtureId);
  } catch {
    return null;
  }
}
