import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADAPTERS, runParser } from "../src/harness.js";
import { buildAggregateReport } from "../src/report.js";
import { sha256File } from "../src/runner.js";
import { FIXTURES_ROOT, OUTPUTS_ROOT } from "../src/filesystem-guard.js";
import type { AdapterRunContext, AdapterRunOutput } from "../adapters/index.js";

/**
 * Regression tests for immutable run-level evidence persistence: every parser
 * execution gets its own runs/<runId>/ directory that no later run can
 * overwrite, failed runs preserve prior successes, and the aggregate report
 * reads ALL persisted runs while skipping corrupt/incomplete artifacts with an
 * explicit warning. Real pdfjs child on synthetic fixtures; adapter stubs for
 * mode-isolation — never any Docling/MinerU model download.
 */

const FIXTURE_IDS = ["immu-coldwarm", "immu-isolation", "immu-failure", "immu-partial", "immu-mode"];
const FIXTURE_FILES = FIXTURE_IDS.map((id) => `${id}.pdf`);
const scratchRoot = join(tmpdir(), "bench-immutability-tests");

function runsRoot(fixtureId: string, parserKey: string): string {
  return join(OUTPUTS_ROOT, fixtureId, parserKey, "runs");
}

async function listRunDirs(fixtureId: string, parserKey: string): Promise<string[]> {
  try {
    const entries = await readdir(runsRoot(fixtureId, parserKey), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** relative-path → sha256 snapshot of every file below a run directory. */
async function snapshotDir(dir: string): Promise<Array<[string, string]>> {
  const snapshot = new Map<string, string>();
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else snapshot.set(rel, await sha256File(full));
    }
  };
  if (existsSync(dir)) await walk(dir, "");
  return [...snapshot.entries()].sort();
}

async function writeTinyPdf(filename: string, pages = 2): Promise<void> {
  await mkdir(FIXTURES_ROOT, { recursive: true });
  const path = join(FIXTURES_ROOT, filename);
  const doc = new PDFDocument({ size: "A4", margin: 64 });
  const stream = createWriteStream(path);
  doc.pipe(stream);
  for (let page = 0; page < pages; page++) {
    doc.fontSize(12).text(`Immutability regression page ${page + 1}. Synthetic content only.`);
    if (page < pages - 1) doc.addPage();
  }
  await new Promise<void>((resolve) => {
    stream.on("finish", () => resolve());
    doc.end();
  });
}

async function registerManifest(entries: Array<{ id: string; filename: string; declaredPages: number; fixtureClass: string }>): Promise<void> {
  await mkdir(FIXTURES_ROOT, { recursive: true });
  const manifest = {
    fixtures: entries.map((entry) => ({
      ...entry,
      generator: "tests (synthetic)",
      notes: "immutability regression fixture",
    })),
  };
  await writeFile(join(FIXTURES_ROOT, "fixtures.manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function validStoredResult(runId: string): Record<string, unknown> {
  return {
    run: { id: runId, startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z", coldStart: true },
    parser: { name: "pdfjs-isolated", version: "test" },
    document: { fixtureId: "immu-partial", inputSha256: "a".repeat(64), bytes: 10, detectedPages: 1 },
    performance: { wallTimeMs: 5, cpuTimeMs: null, peakRssMb: null, peakGpuMb: null },
    reliability: { exitCode: 0, timeout: false, crashed: false, oom: false, partialOutput: false, warnings: [] },
    extraction: { extractedPages: 1, emptyPages: 0, characters: 4, blocks: 1, headings: null, tables: null, figures: null, equations: null, ocrPages: null },
    evidence: { physicalPageIndex: true, bbox: false, confidence: false, readingOrder: false, printedPageLabel: false },
  };
}

beforeEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
  for (const id of FIXTURE_IDS) await rm(join(OUTPUTS_ROOT, id), { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of FIXTURE_IDS) await rm(join(OUTPUTS_ROOT, id), { recursive: true, force: true });
  for (const file of FIXTURE_FILES) await rm(join(FIXTURES_ROOT, file), { force: true });
  await rm(join(FIXTURES_ROOT, "fixtures.manifest.json"), { force: true });
  await rm(scratchRoot, { recursive: true, force: true });
});

describe("immutable run evidence persistence", () => {
  it("cold + warm + third run each get their own run dir; aggregate reads all of them", async () => {
    await writeTinyPdf("immu-coldwarm.pdf", 2);
    await registerManifest([{ id: "immu-coldwarm", filename: "immu-coldwarm.pdf", declaredPages: 2, fixtureClass: "native-en" }]);

    const cold = await runParser("pdfjs", "default", "immu-coldwarm", { cold: true, skipPreflight: true });
    const warm = await runParser("pdfjs", "default", "immu-coldwarm", { cold: false, skipPreflight: true });
    const third = await runParser("pdfjs", "default", "immu-coldwarm", { cold: true, skipPreflight: true });
    expect(cold.status).toBe("OK");
    expect(warm.status).toBe("OK");
    expect(third.status).toBe("OK");
    expect(cold.tempClean).toBe(true);
    expect(warm.tempClean).toBe(true);

    // contract 1: after cold + warm, both results exist (and a third run adds a third dir)
    const runDirs = await listRunDirs("immu-coldwarm", "pdfjs");
    expect(runDirs).toHaveLength(3);

    // contract 2: distinct run ids, each matching its own run directory and stored result
    const ids = [cold.result!.run.id, warm.result!.run.id, third.result!.run.id];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(runDirs).toContain(id);
      const stored = JSON.parse(await readFile(join(runsRoot("immu-coldwarm", "pdfjs"), id, "result.json"), "utf8")) as { run: { id: string } };
      expect(stored.run.id).toBe(id);
    }

    // contract 3: coldStart flags are true / false / true
    expect(cold.result!.run.coldStart).toBe(true);
    expect(warm.result!.run.coldStart).toBe(false);
    expect(third.result!.run.coldStart).toBe(true);

    // per-run log + metrics artifacts live inside the run dir
    const firstRunDir = join(runsRoot("immu-coldwarm", "pdfjs"), ids[0]!);
    expect(existsSync(join(firstRunDir, "stdout.log"))).toBe(true);
    expect(existsSync(join(firstRunDir, "stderr.log"))).toBe(true);
    expect(existsSync(join(firstRunDir, "metrics.json"))).toBe(true);

    // contract 5: the aggregate report reads cold AND warm as separate rows
    const report = await buildAggregateReport();
    const mine = report.results.filter((result) => result.document.fixtureId === "immu-coldwarm");
    expect(mine.map((result) => result.run.id).sort()).toEqual([...ids].sort());
    expect(mine.map((result) => (result.run.coldStart ? "COLD" : "WARM")).sort()).toEqual(["COLD", "COLD", "WARM"]);
    for (const id of ids) expect(report.markdown).toContain(id);

    // contract 6: the third run did not remove the first two
    expect(await listRunDirs("immu-coldwarm", "pdfjs")).toHaveLength(3);
  }, 180_000);

  it("warm run never modifies the cold run's result, normalized, metrics or raw evidence", async () => {
    await writeTinyPdf("immu-isolation.pdf", 1);
    await registerManifest([{ id: "immu-isolation", filename: "immu-isolation.pdf", declaredPages: 1, fixtureClass: "native-en" }]);

    const cold = await runParser("pdfjs", "default", "immu-isolation", { cold: true, skipPreflight: true });
    expect(cold.status).toBe("OK");
    const coldDir = join(runsRoot("immu-isolation", "pdfjs"), cold.result!.run.id);
    // seed raw evidence the way raw-producing adapters do (pdfjs itself writes none)
    await writeFile(join(coldDir, "raw", "cold-evidence.bin"), "cold raw evidence", "utf8");
    const before = await snapshotDir(coldDir);
    expect(before.length).toBeGreaterThanOrEqual(5); // result, normalized, metrics, stdout, stderr, raw

    // contract 4: the warm run must not touch any cold artifact
    const warm = await runParser("pdfjs", "default", "immu-isolation", { cold: false, skipPreflight: true });
    expect(warm.status).toBe("OK");
    expect(warm.result!.run.id).not.toBe(cold.result!.run.id);
    expect(await snapshotDir(coldDir)).toEqual(before);

    // the warm run has its own separate raw dir, not the cold one's
    const warmDir = join(runsRoot("immu-isolation", "pdfjs"), warm.result!.run.id);
    expect(existsSync(join(warmDir, "raw", "cold-evidence.bin"))).toBe(false);
  }, 180_000);

  it("a failed run persists failure evidence in its own dir and preserves the prior success", async () => {
    await writeTinyPdf("immu-failure.pdf", 1);
    await registerManifest([{ id: "immu-failure", filename: "immu-failure.pdf", declaredPages: 1, fixtureClass: "native-en" }]);

    const success = await runParser("pdfjs", "default", "immu-failure", { cold: true, skipPreflight: true });
    expect(success.status).toBe("OK");
    const successDir = join(runsRoot("immu-failure", "pdfjs"), success.result!.run.id);
    const before = await snapshotDir(successDir);

    // contract 7: a later failing execution must not destroy earlier evidence
    const crash = vi.spyOn(ADAPTERS.pdfjs, "run").mockRejectedValue(new Error("SIMULATED_ADAPTER_CRASH"));
    try {
      const failed = await runParser("pdfjs", "default", "immu-failure", { cold: false, skipPreflight: true });
      expect(failed.status).toBe("PARSER_FAILED");
      expect(failed.tempClean).toBe(true);
      expect(failed.result?.reliability.crashed).toBe(true);

      // the failure is persisted as its own run artifact
      const failedDir = join(runsRoot("immu-failure", "pdfjs"), failed.result!.run.id);
      expect(existsSync(join(failedDir, "result.json"))).toBe(true);
      const storedFailure = JSON.parse(await readFile(join(failedDir, "result.json"), "utf8")) as { reliability: { crashed: boolean; warnings: string[] } };
      expect(storedFailure.reliability.crashed).toBe(true);
      expect(storedFailure.reliability.warnings.some((warning) => warning.includes("SIMULATED_ADAPTER_CRASH"))).toBe(true);

      // both runs still exist; the success run is byte-identical
      expect(await listRunDirs("immu-failure", "pdfjs")).toHaveLength(2);
      expect(await snapshotDir(successDir)).toEqual(before);
    } finally {
      crash.mockRestore();
    }
  }, 180_000);

  it("corrupt or incomplete artifacts are skipped with explicit warnings, never reported as success", async () => {
    await writeTinyPdf("immu-partial.pdf", 1);
    await registerManifest([{ id: "immu-partial", filename: "immu-partial.pdf", declaredPages: 1, fixtureClass: "native-en" }]);

    const base = runsRoot("immu-partial", "pdfjs");
    // contract 8: one valid run, one half-written result, one crash before the
    // completion marker, one schema-invalid result
    await mkdir(join(base, "good-run"), { recursive: true });
    await writeFile(join(base, "good-run", "result.json"), JSON.stringify(validStoredResult("good-run"), null, 2), "utf8");
    await mkdir(join(base, "truncated-run"), { recursive: true });
    await writeFile(join(base, "truncated-run", "result.json"), '{"run": { "id": ', "utf8");
    await mkdir(join(base, "incomplete-run", "raw"), { recursive: true });
    await writeFile(join(base, "incomplete-run", "raw", "orphan.bin"), "partial", "utf8");
    await writeFile(join(base, "incomplete-run", "result.json.tmp-abc"), "{}", "utf8");
    await mkdir(join(base, "schema-invalid-run"), { recursive: true });
    await writeFile(join(base, "schema-invalid-run", "result.json"), "{}", "utf8");

    const report = await buildAggregateReport();
    const mine = report.results.filter((result) => result.document.fixtureId === "immu-partial");
    expect(mine.map((result) => result.run.id)).toEqual(["good-run"]);

    const skippedMine = report.skipped.filter((item) => item.path.includes("immu-partial"));
    expect(skippedMine).toHaveLength(3);
    const reasons = skippedMine.map((item) => item.reason).join("\n");
    expect(reasons).toContain("INCOMPLETE_RUN");
    expect(reasons).toContain("UNPARSABLE_RESULT");
    expect(reasons).toContain("SCHEMA_INVALID_RESULT");
    expect(report.markdown).toContain("SKIPPED_INVALID_ARTIFACT");

    // exactly one metrics table row for this fixture — the good run only
    const tableRows = report.markdown.split("\n").filter((line) => line.startsWith("| immu-partial |"));
    expect(tableRows).toHaveLength(1);
    expect(tableRows[0]).toContain("good-run");
  }, 60_000);

  it("mineru-flash and mineru-basic never share result or raw directories", async () => {
    await writeTinyPdf("immu-mode.pdf", 1);
    await registerManifest([{ id: "immu-mode", filename: "immu-mode.pdf", declaredPages: 1, fixtureClass: "native-en" }]);

    // stub the mineru adapter so no model download happens; the real
    // parserKey(mode) mapping drives the directory layout under test
    const stub = vi.spyOn(ADAPTERS.mineru, "run").mockImplementation(async (context: AdapterRunContext): Promise<AdapterRunOutput> => {
      await writeFile(join(context.rawDir, "stub-evidence.json"), JSON.stringify({ mode: context.mode }), "utf8");
      return {
        parser: { name: "mineru", version: "stub", mode: context.mode },
        normalizedCandidate: {
          parser: { name: "mineru", version: "stub", mode: context.mode },
          fixtureId: context.fixture.entry.id,
          pages: [
            {
              pageIndex: 0,
              printedPageLabel: null,
              blocks: [{ kind: "paragraph", text: `stub ${context.mode}`, pageIndex: 0, bbox: null, confidence: null, sourceMethod: "stub" }],
            },
          ],
          readingOrderAvailable: false,
        },
        metrics: { wallTimeMs: 1, exitCode: 0, timedOut: false, outputLimitExceeded: false, peakRssMb: null, cpuTimeMs: null, peakGpuMb: null },
        stdout: "",
        stderr: "",
        warnings: [],
      };
    });
    try {
      const flash = await runParser("mineru", "flash", "immu-mode", { cold: true, skipPreflight: true });
      expect(flash.status).toBe("OK");
      const flashDir = join(runsRoot("immu-mode", "mineru-flash"), flash.result!.run.id);
      const flashBefore = await snapshotDir(flashDir);

      const basic = await runParser("mineru", "basic", "immu-mode", { cold: true, skipPreflight: true });
      expect(basic.status).toBe("OK");
      const basicDir = join(runsRoot("immu-mode", "mineru-basic"), basic.result!.run.id);

      // contract 9: each mode persists into its own parser dir with its own raw evidence
      expect(existsSync(join(flashDir, "raw", "stub-evidence.json"))).toBe(true);
      expect(existsSync(join(basicDir, "raw", "stub-evidence.json"))).toBe(true);
      expect(await listRunDirs("immu-mode", "mineru-flash")).toHaveLength(1);
      expect(await listRunDirs("immu-mode", "mineru-basic")).toHaveLength(1);
      // the basic run did not touch the flash run
      expect(await snapshotDir(flashDir)).toEqual(flashBefore);

      // the aggregate reports the two modes as separate parsers, separate rows
      const report = await buildAggregateReport();
      const mine = report.results.filter((result) => result.document.fixtureId === "immu-mode");
      expect(mine).toHaveLength(2);
      expect(report.markdown).toContain("| immu-mode | mineru-flash |");
      expect(report.markdown).toContain("| immu-mode | mineru-basic |");
    } finally {
      stub.mockRestore();
    }
  }, 60_000);
});
