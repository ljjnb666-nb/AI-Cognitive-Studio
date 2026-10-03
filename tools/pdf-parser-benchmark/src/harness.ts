import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DATA_ROOT,
  FIXTURES_ROOT,
  OUTPUTS_ROOT,
  REPORTS_ROOT,
  TEMP_ROOT,
  assertFixturePath,
} from "./filesystem-guard.js";
import { diskFreeBytes, gpuState, ramAvailableBytes } from "./resource-monitor.js";
import { Runner, ensureCleanDir, sha256File, writeJsonFileAtomic } from "./runner.js";
import {
  buildBenchmarkResult,
  parseBenchmarkResult,
  parseNormalizedOutput,
  type BenchmarkResult,
  type NormalizedOutput,
  type ParserDescriptor,
} from "./schema.js";
import { pdfjsAdapter, liteparseAdapter, doclingAdapter, mineruAdapter, type ParserAdapter, type ParserMode } from "../adapters/index.js";

export type ParserId = "pdfjs" | "liteparse" | "docling" | "mineru";

export const ADAPTERS: Record<ParserId, ParserAdapter> = {
  pdfjs: pdfjsAdapter,
  liteparse: liteparseAdapter,
  docling: doclingAdapter,
  mineru: mineruAdapter,
};

export type FixtureManifestEntry = {
  id: string;
  filename: string;
  fixtureClass: string;
  generator: string;
  declaredPages: number;
  notes: string;
};

export type FixtureRecord = {
  entry: FixtureManifestEntry;
  path: string;
  sha256: string;
  bytes: number;
};

export async function loadFixture(fixtureId: string): Promise<FixtureRecord> {
  const manifestPath = join(FIXTURES_ROOT, "fixtures.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { fixtures: FixtureManifestEntry[] };
  const entry = manifest.fixtures.find((candidate) => candidate.id === fixtureId);
  if (!entry) throw new Error(`FIXTURE_NOT_IN_MANIFEST: ${fixtureId}`);
  const path = assertFixturePath(join(FIXTURES_ROOT, entry.filename));
  if (!existsSync(path)) throw new Error(`FIXTURE_FILE_MISSING: ${path}`);
  return { entry, path, sha256: await sha256File(path), bytes: (await stat(path)).size };
}

export type Preflight = {
  ok: boolean;
  reason: string | null;
  ramAvailableGb: number;
  cFreeGb: number;
  dFreeGb: number;
  gpu: Awaited<ReturnType<typeof gpuState>>;
};

export async function preflight(minRamAvailableGb: number): Promise<Preflight> {
  const ramAvailableGb = ramAvailableBytes() / 1024 ** 3;
  const cFreeGb = (await diskFreeBytes("C:\\")) / 1024 ** 3;
  const dFreeGb = (await diskFreeBytes(DATA_ROOT)) / 1024 ** 3;
  const gpu = await gpuState();
  let reason: string | null = null;
  if (cFreeGb < 15) reason = "STOP_REASON = C_DRIVE_PRESSURE";
  else if (dFreeGb < 30) reason = "D_DRIVE_PRESSURE";
  else if (ramAvailableGb < minRamAvailableGb) reason = "SKIPPED_RESOURCE_CONSTRAINT";
  return { ok: reason === null, reason, ramAvailableGb, cFreeGb, dFreeGb, gpu };
}

export type RunOptions = {
  cold: boolean;
  timeoutOverrideMs?: number;
  pageCapOverride?: number | null;
  /** Test-only: bypass the RAM/disk preflight gate (unit tests run on busy machines). */
  skipPreflight?: boolean;
  /**
   * When the RAM gate trips, wait this long and re-check, up to 5 attempts
   * (waits for a natural memory window; never forces through pagefile).
   * C-drive pressure and D-drive pressure stop immediately without retry.
   */
  preflightRetryMs?: number;
};

export type RunOutcome = {
  status: "OK" | "PARSER_FAILED" | "SKIPPED_RESOURCE_CONSTRAINT" | "STOPPED_C_DRIVE_PRESSURE";
  result: BenchmarkResult | null;
  normalized: NormalizedOutput | null;
  preflight: Preflight | null;
  outputDir: string | null;
  tempClean: boolean | null;
  warnings: string[];
};

function runIdFor(parserKey: string, fixtureId: string, cold: boolean): string {
  return `${parserKey}-${fixtureId}-${cold ? "cold" : "warm"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Reserves a fresh run directory: outputs/<fixtureId>/<parserKey>/runs/<runId>.
 * One runId → one immutable run directory; a colliding runId (same millisecond)
 * is suffixed instead of reusing or clearing the existing directory.
 */
async function reserveRunDir(parserKey: string, fixtureId: string, runId: string): Promise<{ runId: string; dir: string }> {
  let candidate = runId;
  let dir = join(OUTPUTS_ROOT, fixtureId, parserKey, "runs", candidate);
  for (let suffix = 1; existsSync(dir); suffix++) {
    candidate = `${runId}-${suffix}`;
    dir = join(OUTPUTS_ROOT, fixtureId, parserKey, "runs", candidate);
  }
  await mkdir(join(dir, "raw"), { recursive: true });
  return { runId: candidate, dir };
}

/** One isolated parser run: preflight → spawn → normalize → persist → cleanup. */
export async function runParser(
  parserId: ParserId,
  mode: ParserMode,
  fixtureId: string,
  options: RunOptions,
): Promise<RunOutcome> {
  const adapter = ADAPTERS[parserId];
  const warnings: string[] = [];
  const parserKey = adapter.parserKey(mode);

  let check = options.skipPreflight
    ? { ok: true, reason: null, ramAvailableGb: 0, cFreeGb: 0, dFreeGb: 0, gpu: await gpuState() }
    : await preflight(adapter.minRamAvailableGb);
  if (!check.ok && check.reason !== "STOP_REASON = C_DRIVE_PRESSURE" && check.reason !== "D_DRIVE_PRESSURE") {
    const retryMs = options.preflightRetryMs ?? 15_000;
    for (let attempt = 1; attempt <= 5 && !check.ok; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      check = await preflight(adapter.minRamAvailableGb);
    }
  }
  if (!check.ok) {
    const status = check.reason === "STOP_REASON = C_DRIVE_PRESSURE" ? "STOPPED_C_DRIVE_PRESSURE" : "SKIPPED_RESOURCE_CONSTRAINT";
    return { status, result: null, normalized: null, preflight: check, outputDir: null, tempClean: null, warnings: [check.reason ?? "unknown"] };
  }

  const fixture = await loadFixture(fixtureId);
  const reserved = await reserveRunDir(parserKey, fixtureId, runIdFor(parserKey, fixtureId, options.cold));
  const runId = reserved.runId;
  const outDir = reserved.dir;
  const rawDir = join(outDir, "raw");
  const tempDir = join(TEMP_ROOT, parserKey, runId);
  await ensureCleanDir(tempDir);

  const startedAt = new Date().toISOString();
  let result: BenchmarkResult;
  let normalized: NormalizedOutput | null = null;
  let childFailed = false;
  let failureWarnings: string[] = [];

  try {
    const outcome = await adapter.run({
      mode,
      fixture,
      tempDir,
      rawDir,
      cold: options.cold,
      timeoutOverrideMs: options.timeoutOverrideMs,
      pageCapOverride: options.pageCapOverride,
      runner: new Runner(),
      warnings,
    });

    // Run-scoped evidence: stdout/stderr and every artifact land inside this
    // run's own directory, so no later run can overwrite an earlier one.
    await writeFile(join(outDir, "stdout.log"), outcome.stdout ?? "", "utf8").catch(() => undefined);
    await writeFile(join(outDir, "stderr.log"), outcome.stderr ?? "", "utf8").catch(() => undefined);
    await writeJsonFileAtomic(join(outDir, "metrics.json"), outcome.metrics);

    if (outcome.normalizedCandidate) {
      normalized = parseNormalizedOutput(outcome.normalizedCandidate);
      await writeJsonFileAtomic(join(outDir, "normalized.json"), normalized);
    } else {
      childFailed = true;
      failureWarnings = outcome.warnings;
    }

    result = buildBenchmarkResult({
      run: { id: runId, startedAt, finishedAt: new Date().toISOString(), coldStart: options.cold },
      parser: outcome.parser as ParserDescriptor,
      document: {
        fixtureId,
        inputSha256: fixture.sha256,
        bytes: fixture.bytes,
        detectedPages: normalized?.pages.length ?? null,
      },
      performance: {
        wallTimeMs: outcome.metrics.wallTimeMs,
        cpuTimeMs: outcome.metrics.cpuTimeMs ?? null,
        peakRssMb: outcome.metrics.peakRssMb ?? null,
        peakGpuMb: outcome.metrics.peakGpuMb ?? null,
      },
      reliability: {
        exitCode: outcome.metrics.exitCode ?? null,
        timeout: outcome.metrics.timedOut,
        crashed: outcome.metrics.exitCode !== 0 && !outcome.metrics.timedOut,
        oom: /heap|OOM|out of memory|killed/i.test(outcome.stderr ?? ""),
        partialOutput: outcome.metrics.outputLimitExceeded || (childFailed && outcome.metrics.exitCode === 0),
        warnings: [...warnings, ...failureWarnings],
      },
      normalized,
    });
    parseBenchmarkResult(result);
  } catch (error) {
    childFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    result = {
      run: { id: runId, startedAt, finishedAt: new Date().toISOString(), coldStart: options.cold },
      parser: { name: parserId, version: "unknown", mode },
      document: { fixtureId, inputSha256: fixture.sha256, bytes: fixture.bytes, detectedPages: null },
      performance: { wallTimeMs: 0, cpuTimeMs: null, peakRssMb: null, peakGpuMb: null },
      reliability: { exitCode: null, timeout: false, crashed: true, oom: false, partialOutput: false, warnings: [message] },
      extraction: {
        extractedPages: 0,
        emptyPages: 0,
        characters: 0,
        blocks: 0,
        headings: null,
        tables: null,
        figures: null,
        equations: null,
        ocrPages: null,
      },
      evidence: { physicalPageIndex: false, bbox: false, confidence: false, readingOrder: false, printedPageLabel: false },
    };
    warnings.push(message);
  }

  // result.json is the run-completion marker and is written LAST: a run dir
  // without a parsable result.json is an incomplete run, never valid evidence.
  try {
    await writeJsonFileAtomic(join(outDir, "result.json"), result);
  } catch (persistError) {
    const message = persistError instanceof Error ? persistError.message : String(persistError);
    warnings.push(`RESULT_PERSIST_FAILED: ${message}`);
    result.reliability.warnings.push(`RESULT_PERSIST_FAILED: ${message}`);
    childFailed = true;
  }

  // Temp cleanup (#34): success, failure and timeout paths must all clean up.
  let tempClean = true;
  try {
    await rm(tempDir, { recursive: true, force: true });
    tempClean = !existsSync(tempDir);
  } catch {
    tempClean = false;
  }

  return {
    status: childFailed ? "PARSER_FAILED" : "OK",
    result,
    normalized,
    preflight: check,
    outputDir: outDir,
    tempClean,
    warnings,
  };
}

export async function writeReportFile(name: string, content: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(REPORTS_ROOT, stamp);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}
