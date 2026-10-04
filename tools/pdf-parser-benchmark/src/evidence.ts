import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_ROOT, DATA_ROOT, FIXTURES_ROOT, MODELS_ROOT, OUTPUTS_ROOT, REPORTS_ROOT, TEMP_ROOT } from "./filesystem-guard.js";
import { buildAggregateReport } from "./report.js";
import { diskFreeBytes, gpuState, ramAvailableBytes, ramTotalBytes } from "./resource-monitor.js";

/**
 * Decision evidence pack (Phase 2B spec #26). Facts only: observed metrics,
 * tradeoffs, unsupported capabilities, failure cases, resource cost. No
 * winner, no production recommendation, no scoring.
 */

export type EvidencePack = { dir: string; files: string[] };

export async function writeEvidencePack(): Promise<EvidencePack> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(REPORTS_ROOT, stamp);
  await mkdir(dir, { recursive: true });

  const report = await buildAggregateReport();
  await writeFile(join(dir, "summary.md"), report.markdown, "utf8");

  const runRows = report.results.map((result) => ({
    runId: result.run.id,
    fixtureId: result.document.fixtureId,
    parser: result.parser.name,
    mode: result.parser.mode,
    coldStart: result.run.coldStart,
    wallTimeMs: result.performance.wallTimeMs,
    peakRssMb: result.performance.peakRssMb,
    cpuTimeMs: result.performance.cpuTimeMs,
    peakGpuMb: result.performance.peakGpuMb,
    extractedPages: result.extraction.extractedPages,
    characters: result.extraction.characters,
    blocks: result.extraction.blocks,
    timeout: result.reliability.timeout,
    crashed: result.reliability.crashed,
    oom: result.reliability.oom,
    warnings: result.reliability.warnings,
  }));
  await writeFile(join(dir, "run-all-summary.json"), JSON.stringify({ runs: runRows }, null, 2), "utf8");

  const evaluated = report.quality.filter((q) => q.status === "EVALUATED");
  await writeFile(
    join(dir, "quality-summary.json"),
    JSON.stringify({ evaluatedRuns: evaluated.length, quality: report.quality }, null, 2),
    "utf8",
  );

  await writeFile(
    join(dir, "capability-matrix.json"),
    JSON.stringify({ note: "observed facts per parserKey across all persisted runs; no scoring", parsers: deriveCapabilityRows(report) }, null, 2),
    "utf8",
  );

  const cFreeGb = (await diskFreeBytes("C:\\")) / 1024 ** 3;
  const dFreeGb = (await diskFreeBytes(DATA_ROOT)) / 1024 ** 3;
  const gpu = await gpuState();
  await writeFile(
    join(dir, "environment.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        ramTotalGb: Number((ramTotalBytes() / 1024 ** 3).toFixed(2)),
        ramAvailableGb: Number((ramAvailableBytes() / 1024 ** 3).toFixed(2)),
        cFreeGb: Number(cFreeGb.toFixed(2)),
        dFreeGb: Number(dFreeGb.toFixed(2)),
        gpu,
        paths: { dataRoot: DATA_ROOT, fixtures: FIXTURES_ROOT, outputs: OUTPUTS_ROOT, reports: REPORTS_ROOT, temp: TEMP_ROOT, cache: CACHE_ROOT, models: MODELS_ROOT },
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeFile(join(dir, "versions.json"), JSON.stringify(await collectVersions(), null, 2), "utf8");

  const decisionEvidence = buildDecisionEvidence(report);
  await writeFile(join(dir, "decision-evidence.md"), decisionEvidence, "utf8");

  return { dir, files: ["summary.md", "run-all-summary.json", "quality-summary.json", "capability-matrix.json", "environment.json", "versions.json", "decision-evidence.md"] };
}

function deriveCapabilityRows(report: Awaited<ReturnType<typeof buildAggregateReport>>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const byKey = new Map<string, { ocrEnabled: boolean | null; ocrRequested: boolean; ocrField: boolean; evaluatedRuns: number }>();
  for (const q of report.quality) {
    const entry = byKey.get(q.parserKey) ?? { ocrEnabled: null, ocrRequested: false, ocrField: false, evaluatedRuns: 0 };
    entry.evaluatedRuns++;
    if (q.ocr?.metadata) {
      entry.ocrField = true;
      entry.ocrEnabled = q.ocr.metadata.ocrEnabled;
      entry.ocrRequested = q.ocr.metadata.ocrModeRequested || entry.ocrRequested;
    }
    byKey.set(q.parserKey, entry);
  }
  for (const [key, entry] of byKey.entries()) {
    rows.push({
      parserKey: key,
      evaluatedRuns: entry.evaluatedRuns,
      ocrProvenanceRecorded: entry.ocrField,
      ocrModeRequested: entry.ocrRequested,
      ocrEnabledUpstreamReport: entry.ocrEnabled,
    });
  }
  return rows;
}

async function collectVersions(): Promise<Record<string, unknown>> {
  const versions: Record<string, unknown> = { node: process.version };
  try {
    versions.benchmarkPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).dependencies;
  } catch {
    versions.benchmarkPackage = "unknown";
  }
  const doclingVersion = await pythonPackageVersion("docling");
  versions.docling = doclingVersion;
  const mineruVersion = await pythonPackageVersion("mineru");
  versions.mineru = mineruVersion;
  try {
    versions.fixtures = JSON.parse(await readFile(join(FIXTURES_ROOT, "fixtures.manifest.json"), "utf8")).fixtures.map(
      (fixture: { id: string; declaredPages: number; groundTruth: string | null }) => ({ id: fixture.id, declaredPages: fixture.declaredPages, groundTruth: fixture.groundTruth }),
    );
  } catch {
    versions.fixtures = "unknown";
  }
  return versions;
}

async function pythonPackageVersion(packageName: string): Promise<unknown> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const pythonExe = packageName === "docling" ? "D:\\ai-cognitive-pdf-benchmark-data\\python\\docling\\Scripts\\python.exe" : "D:\\ai-cognitive-pdf-benchmark-data\\python\\mineru\\Scripts\\python.exe";
  try {
    const { stdout } = await promisify(execFile)(pythonExe, ["-c", `import importlib.metadata;print(importlib.metadata.version("${packageName}"))`], { timeout: 30_000 });
    return stdout.trim();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function buildDecisionEvidence(report: Awaited<ReturnType<typeof buildAggregateReport>>): string {
  const lines: string[] = [];
  lines.push("# PDF Parser Benchmark — Decision Evidence (facts only)");
  lines.push("");
  lines.push("This document states observed facts, tradeoffs, unsupported capabilities, failure cases and resource costs.");
  lines.push("It deliberately contains NO winner, NO total score and NO production recommendation.");
  lines.push("The production parser routing architecture decision belongs to the external gatekeeper reviewing this pack.");
  lines.push("");

  const byKey = new Map<string, { runs: number; failed: number; wallMs: number[]; peakRssMb: Array<number | null> }>();
  for (const result of report.results) {
    const key = result.parser.name.split(" ")[0]!;
    const entry = byKey.get(key) ?? { runs: 0, failed: 0, wallMs: [], peakRssMb: [] };
    entry.runs++;
    const failed = result.reliability.crashed || result.reliability.timeout || result.reliability.oom || result.reliability.partialOutput;
    if (failed) entry.failed++;
    entry.wallMs.push(result.performance.wallTimeMs);
    entry.peakRssMb.push(result.performance.peakRssMb);
    byKey.set(key, entry);
  }
  lines.push("## Observed reliability & resource cost (per parser family, all persisted runs)");
  lines.push("");
  lines.push("| parser | runs | failed | wall ms (min/median/max) | peak RSS MB (max observed) |");
  lines.push("| --- | --- | --- | --- | --- |");
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? "n/a" : String(sorted[Math.floor(sorted.length / 2)]);
  };
  for (const [key, entry] of byKey.entries()) {
    const rssValues = entry.peakRssMb.filter((value): value is number => value !== null);
    lines.push(
      `| ${key} | ${entry.runs} | ${entry.failed} | ${entry.wallMs.length ? `${Math.min(...entry.wallMs)}/${median(entry.wallMs)}/${Math.max(...entry.wallMs)}` : "n/a"} | ${rssValues.length ? Math.max(...rssValues) : "n/a"} |`,
    );
  }
  lines.push("");

  lines.push("## Unsupported / degraded capabilities observed");
  lines.push("");
  const evaluated = report.quality.filter((q) => q.status === "EVALUATED");
  const ocrUnsupported = evaluated.filter((q) => q.ocr && !q.ocr.required && q.fixtureId.startsWith("F3"));
  if (ocrUnsupported.length > 0) {
    lines.push(`- Scanned-Chinese runs WITHOUT an OCR-enabled mode (F3, no OCR evaluation possible): ${ocrUnsupported.length} — native-text-only parsers cannot score scanned content.`);
  }
  const flattened = evaluated.filter((q) => q.table?.flattenedToText === true);
  for (const item of flattened) lines.push(`- TABLE_FLATTENED_TO_TEXT: ${item.parserKey} on ${item.fixtureId} (usable for text intelligence, not equivalent to structural table extraction).`);
  const noEquation = evaluated.filter((q) => q.formula && q.formula.formulasExpected > 0 && !q.formula.structuralEquationKindSeenInRun);
  for (const item of noEquation) lines.push(`- Formula structure not emitted by ${item.parserKey} on ${item.fixtureId} (unsupported in that run; flattened text only).`);
  const interleaved = evaluated.filter((q) => q.readingOrder?.interleavingDetected === true);
  for (const item of interleaved) lines.push(`- READING_ORDER_INTERLEAVING detected: ${item.parserKey} on ${item.fixtureId}.`);
  const missingGt = report.quality.filter((q) => q.status === "SKIPPED_GROUND_TRUTH_MISSING");
  if (missingGt.length > 0) lines.push(`- Runs without ground truth (quality not measurable): ${missingGt.length}.`);
  lines.push("");

  lines.push("## Failure cases");
  lines.push("");
  const failures = report.results.filter(
    (result) => result.reliability.crashed || result.reliability.timeout || result.reliability.oom || result.reliability.partialOutput,
  );
  if (failures.length === 0) lines.push("_none recorded in persisted runs._");
  for (const failure of failures) {
    lines.push(`- ${failure.document.fixtureId} / ${failure.parser.name} / ${failure.run.id}: crashed=${failure.reliability.crashed} timeout=${failure.reliability.timeout} oom=${failure.reliability.oom} partial=${failure.reliability.partialOutput} warnings=${JSON.stringify(failure.reliability.warnings.slice(0, 3))}`);
  }
  lines.push("");

  lines.push("## Tradeoffs visible in the data (facts, no verdict)");
  lines.push("");
  lines.push("- Native-text parsers are faster and cheaper per run than model-backed pipelines; quality per fixture is recorded in quality-summary.json alongside the same run's wall time and peak RSS.");
  lines.push("- OCR-enabled modes add inference cost; their scanned-Chinese fidelity is recorded per run (char recall, trigram recall, key-phrase recovery).");
  lines.push("- PAGE_SUBSET caps apply to model-backed parsers on long documents; their long-book rows are page subsets, never full-book results.");
  lines.push("");

  return lines.join("\n");
}
