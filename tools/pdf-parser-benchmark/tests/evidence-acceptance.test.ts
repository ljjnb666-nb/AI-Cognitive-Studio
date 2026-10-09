import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAggregateReport } from "../src/report.js";
import { buildDecisionEvidence } from "../src/evidence.js";
import { OUTPUTS_ROOT } from "../src/filesystem-guard.js";
import { buildBenchmarkResult, type BenchmarkResult, type NormalizedOutput } from "../src/schema.js";

const id = "evidence-acceptance-synthetic";
const parser = "pdfjs";
const root = join(OUTPUTS_ROOT, id);
const normalized: NormalizedOutput = {
  parser: { name: "pdfjs-isolated", version: "test" },
  fixtureId: id,
  pages: [{ pageIndex: 0, printedPageLabel: null, blocks: [] }],
  readingOrderAvailable: false,
};

function makeResult(runId: string, reliability: BenchmarkResult["reliability"]) {
  return buildBenchmarkResult({
    run: { id: runId, startedAt: "2026-10-09T00:00:00.000Z",
      finishedAt: "2026-10-09T00:00:01.000Z", coldStart: true },
    parser: { name: "pdfjs-isolated", version: "test" },
    document: { fixtureId: id, inputSha256: "a".repeat(64), bytes: 12, detectedPages: 1 },
    performance: { wallTimeMs: 100, cpuTimeMs: null, peakRssMb: null, peakGpuMb: null },
    reliability, normalized,
  });
}

async function store(runId: string, rel: BenchmarkResult["reliability"], hasNormalized: boolean) {
  const dir = join(root, parser, "runs", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "result.json"), JSON.stringify(makeResult(runId, rel)));
  if (hasNormalized) await writeFile(join(dir, "normalized.json"), JSON.stringify(normalized));
}

beforeAll(async () => {
  await rm(root, { recursive: true, force: true });
  const good = { exitCode: 0, timeout: false, crashed: false, failureKind: null,
    oom: false, partialOutput: false, warnings: [] };
  await store("success", good, true);
  // A legacy non-success may retain valid-looking normalized evidence.
  await store("expected-refusal", { ...good, exitCode: 3,
    failureKind: "EXPECTED_CAPABILITY_REJECTION" }, true);
  // Null failureKind / zero exit alone cannot establish success without normalized.json.
  await store("orphan-evidence", good, false);
  // An otherwise parseable result moved to a different run directory is untrusted.
  const wrong = join(root, parser, "runs", "wrong-run");
  await mkdir(wrong, { recursive: true });
  await writeFile(join(wrong, "result.json"), JSON.stringify(makeResult("different-run", good)));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("benchmark decision evidence uses the same authority as the metrics table", () => {
  it("counts failureKind and missing normalized as failures without changing valid successes", async () => {
    const aggregate = await buildAggregateReport();
    const mine = aggregate.runAcceptance.filter(x => x.result.document.fixtureId === id);
    expect(mine.map(x => [x.result.run.id, x.accepted]).sort()).toEqual([
      ["expected-refusal", false], ["orphan-evidence", false], ["success", true],
    ]);
    const table = aggregate.markdown.split("\n").filter(row => row.startsWith("| " + id + " |"));
    expect(table.filter(row => row.includes("| FAILED |"))).toHaveLength(2);
    expect(table.filter(row => row.includes("| OK |"))).toHaveLength(1);
    const decision = buildDecisionEvidence(aggregate);
    expect(decision).toContain("| pdfjs-isolated | 3 | 2 |");
    expect(decision).toContain("failureKind=EXPECTED_CAPABILITY_REJECTION exitCode=3");
    expect(decision).toContain("orphan-evidence");
    expect(decision).not.toContain("different-run");
    expect(aggregate.skipped.some(row => row.reason.startsWith("RESULT_IDENTITY_MISMATCH"))).toBe(true);
    expect(existsSync(join(root, parser, "runs", "expected-refusal", "normalized.json"))).toBe(true);
  });
});
