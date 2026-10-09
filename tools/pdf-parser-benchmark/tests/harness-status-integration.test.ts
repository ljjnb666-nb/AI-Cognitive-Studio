import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ADAPTERS, runParser } from "../src/harness.js";
import { buildAggregateReport } from "../src/report.js";
import { isSuccessfulRun } from "../src/outcome-gate.js";
import { FIXTURES_ROOT, OUTPUTS_ROOT } from "../src/filesystem-guard.js";
import type { AdapterRunOutput } from "../adapters/index.js";

const fixtureId = "harness-status-boundary";
const filename = fixtureId + ".pdf";
const manifest = join(FIXTURES_ROOT, "fixtures.manifest.json");
function normalized(text = "TRUSTED_TEXT", id = fixtureId, kind = "paragraph") {
  return {
    parser: { name: "synthetic", version: "1" }, fixtureId: id,
    pages: [{ pageIndex: 0, printedPageLabel: null,
      blocks: [{ kind, text, pageIndex: 0, bbox: null, confidence: null, sourceMethod: "test" }] }],
    readingOrderAvailable: false,
  };
}
function result(overrides: Partial<AdapterRunOutput> = {}): AdapterRunOutput {
  return {
    parser: { name: "synthetic", version: "1" }, normalizedCandidate: normalized(),
    metrics: { wallTimeMs: 1, exitCode: 0, timedOut: false, outputLimitExceeded: false,
      peakRssMb: null, cpuTimeMs: null, peakGpuMb: null },
    stdout: "", stderr: "", warnings: [], ...overrides,
  };
}
beforeAll(async () => {
  await mkdir(FIXTURES_ROOT, { recursive: true });
  await rm(join(OUTPUTS_ROOT, fixtureId), { recursive: true, force: true });
  await writeFile(join(FIXTURES_ROOT, filename), "%PDF-1.4\n% synthetic stub-only input\n%%EOF\n");
  await writeFile(manifest, JSON.stringify({ fixtures: [{
    id: fixtureId, filename, declaredPages: 1, fixtureClass: "synthetic",
    generator: "test", notes: "not passed to any child process",
  }] }));
});
afterAll(async () => {
  vi.restoreAllMocks();
  await rm(join(OUTPUTS_ROOT, fixtureId), { recursive: true, force: true });
  await rm(join(FIXTURES_ROOT, filename), { force: true });
  await rm(manifest, { force: true });
});
describe("real runParser path with isolated synthetic adapter", () => {
  it("keeps process status, persisted evidence and aggregate consumers consistent", async () => {
    const stub = vi.spyOn(ADAPTERS.pdfjs, "run");
    const failures: Array<{ name: string; output: AdapterRunOutput; kind: string }> = [
      { name: "nonzero", output: result({ metrics: { ...result().metrics, exitCode: 9 } }), kind: "PROCESS_FAILURE" },
      { name: "timeout", output: result({ metrics: { ...result().metrics, timedOut: true } }), kind: "TIMEOUT" },
      { name: "oom", output: result({ stderr: "out of memory" }), kind: "OUT_OF_MEMORY" },
      { name: "cap", output: result({ metrics: { ...result().metrics, outputLimitExceeded: true } }), kind: "PROCESS_FAILURE" },
      { name: "schema", output: result({ normalizedCandidate: { pages: "invalid" } }), kind: "INVALID_OUTPUT" },
      { name: "cross-fixture", output: result({ normalizedCandidate: normalized("WRONG_BOOK", "other-fixture") }), kind: "INVALID_OUTPUT" },
      { name: "missing", output: result({ normalizedCandidate: null }), kind: "INVALID_OUTPUT" },
    ];
    for (const c of failures) {
      stub.mockResolvedValueOnce(c.output);
      const outcome = await runParser("pdfjs", "default", fixtureId, { cold: true, skipPreflight: true });
      expect(outcome.status, c.name).toBe("PARSER_FAILED");
      expect(isSuccessfulRun(outcome), c.name).toBe(false);
      expect(outcome.result?.reliability.failureKind, c.name).toBe(c.kind);
      expect(outcome.normalized, c.name).toBeNull();
      expect(existsSync(join(outcome.outputDir!, "normalized.json")), c.name).toBe(false);
      const persisted = JSON.parse(await readFile(join(outcome.outputDir!, "result.json"), "utf8"));
      expect(persisted.reliability.failureKind, c.name).toBe(c.kind);
      if (c.name === "cross-fixture")
        expect(persisted.reliability.warnings.join(" ")).toContain("FIXTURE_ID_MISMATCH");
      if (c.name === "nonzero") {
        // Legacy failed runs could retain valid-looking diagnostics.
        await writeFile(join(outcome.outputDir!, "normalized.json"),
          JSON.stringify(normalized("FAILED_LEGACY_TEXT", fixtureId, "table")));
        await writeFile(join(outcome.outputDir!, "quality.json"), JSON.stringify({
          evaluatorVersion: "pdf-quality-eval-v2", runId: outcome.result!.run.id,
          fixtureId, parserKey: "pdfjs", parserMode: "default",
          status: "EVALUATED", error: null, evaluatedAt: new Date().toISOString(),
          text: null, readingOrder: null, structure: null, pages: null,
          table: null, formula: null, ocr: null, contamination: null,
        }));
      }
    }
    // Inject a deterministic, real filesystem persistence error at result.json.
    stub.mockImplementationOnce(async (context) => {
      await mkdir(join(dirname(context.rawDir), "result.json"), { recursive: true });
      return result();
    });
    const incomplete = await runParser("pdfjs", "default", fixtureId, { cold: true, skipPreflight: true });
    expect(incomplete.status).toBe("PARSER_FAILED");
    expect(isSuccessfulRun(incomplete)).toBe(false);
    expect(incomplete.result?.reliability.failureKind).toBe("HARNESS_ERROR");
    expect(incomplete.result?.reliability.warnings.join(" ")).toContain("RESULT_PERSIST_FAILED");

    stub.mockResolvedValueOnce(result());
    const ok = await runParser("pdfjs", "default", fixtureId, { cold: true, skipPreflight: true });
    expect(ok.status).toBe("OK");
    expect(isSuccessfulRun(ok)).toBe(true);
    expect(existsSync(join(ok.outputDir!, "normalized.json"))).toBe(true);
    const summary = await buildAggregateReport();
    const rows = summary.markdown.split("\n").filter(s => s.startsWith("| " + fixtureId + " |"));
    expect(rows.filter(s => s.includes("| FAILED |"))).toHaveLength(failures.length);
    expect(rows.filter(s => s.includes("| OK |"))).toHaveLength(1);
    expect(summary.markdown).toContain("TRUSTED_TEXT");
    expect(summary.markdown).not.toContain("FAILED_LEGACY_TEXT");
    const matrixRow = summary.markdown.split("\n").find(s => s.startsWith("| pdfjs |"));
    expect(matrixRow?.split("|")[5]?.trim()).toBe("false"); // failed-only "table"
    expect(summary.skipped.some(x => x.reason.startsWith("UNTRUSTED_EVALUATED_QUALITY"))).toBe(true);
    expect(summary.skipped.some(x => x.reason.startsWith("INCOMPLETE_RUN"))).toBe(true);
    stub.mockRestore();
  }, 60_000);
});
