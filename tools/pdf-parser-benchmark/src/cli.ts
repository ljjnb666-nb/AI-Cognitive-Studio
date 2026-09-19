import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_ROOT, DATA_ROOT, FIXTURES_ROOT, REPORTS_ROOT, TEMP_ROOT } from "./filesystem-guard.js";
import { preflight, runParser, ADAPTERS, writeReportFile, type ParserId } from "./harness.js";
import { Runner } from "./runner.js";
import { diskFreeBytes, gpuState, ramAvailableBytes, ramTotalBytes } from "./resource-monitor.js";

const SMOKES: Array<{ fixture: string }> = [
  { fixture: "F1-native-cn" },
  { fixture: "F2-multicolumn" },
  { fixture: "F3-scanned-cn" },
  { fixture: "F4-textbook-complex" },
  { fixture: "F5-long-book" },
];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function fixtureArg(): string | undefined {
  return arg("--fixture");
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await import("node:fs/promises").then((fs) => fs.readdir(dir, { withFileTypes: true }));
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirBytes(full);
    else total += (await stat(full).then((s) => s.size).catch(() => 0));
  }
  return total;
}

async function printHostBaseline(): Promise<void> {
  const ramTotalGb = ramTotalBytes() / 1024 ** 3;
  const ramAvailGb = ramAvailableBytes() / 1024 ** 3;
  const cFreeGb = (await diskFreeBytes("C:\\")) / 1024 ** 3;
  const dFreeGb = (await diskFreeBytes("D:\\")) / 1024 ** 3;
  const gpu = await gpuState();
  console.log(JSON.stringify({
    RAM_TOTAL_GB: Number(ramTotalGb.toFixed(2)),
    RAM_AVAILABLE_GB: Number(ramAvailGb.toFixed(2)),
    C_FREE_GB: Number(cFreeGb.toFixed(2)),
    D_FREE_GB: Number(dFreeGb.toFixed(2)),
    GPU: gpu,
  }, null, 2));
}

async function mineruServer(action: "status" | "start" | "stop"): Promise<number> {
  const outcome = await new Runner().run({
    programId: "mineru_cli",
    argv: ["server", action],
    cwd: join(DATA_ROOT, "temp", "mineru"),
    env: {
      MINERU_HOME: join(CACHE_ROOT, "mineru", "home"),
      MINERU_MODEL_SOURCE: "auto",
      HF_HOME: join(CACHE_ROOT, "huggingface"),
    },
  }, { timeoutMs: 180_000 });
  console.log(outcome.stdout || outcome.stderr);
  return outcome.exitCode ?? 1;
}

async function setupModels(): Promise<void> {
  // Preload (untimed): run each model parser once on a tiny warmup PDF so the
  // smoke runs measure inference, not download (#27). Records download bytes/time.
  const { loadFixtureSafe } = await import("./fixture-setup.js");
  const warmup = await loadFixtureSafe("warmup");
  if (!warmup) {
    console.error("WARMUP_FIXTURE_MISSING — run `npm run fixtures` first");
    process.exitCode = 1;
    return;
  }
  const record: Record<string, unknown> = {};
  const beforeHf = await dirBytes(join(CACHE_ROOT, "huggingface"));
  const beforeMineru = await dirBytes(join(CACHE_ROOT, "mineru"));
  const t0 = Date.now();

  console.log("== preload docling (untimed model download) ==");
  const doclingRun = await runParser("docling", "local", warmup.entry.id, { cold: true, pageCapOverride: null });
  record.docling = { status: doclingRun.status, warnings: doclingRun.warnings, warmCacheBytes: await dirBytes(join(CACHE_ROOT, "huggingface")) };

  console.log("== preload mineru flash (untimed model download) ==");
  const serverUp = await mineruServer("start");
  record.mineruServerStartExit = serverUp;
  const mineruRun = await runParser("mineru", "flash", warmup.entry.id, { cold: true, pageCapOverride: null });
  record.mineru = { status: mineruRun.status, warnings: mineruRun.warnings, mineruHomeBytes: await dirBytes(join(CACHE_ROOT, "mineru")) };
  await mineruServer("stop");

  record.modelDownload = {
    hfDeltaBytes: (await dirBytes(join(CACHE_ROOT, "huggingface"))) - beforeHf,
    mineruDeltaBytes: (await dirBytes(join(CACHE_ROOT, "mineru"))) - beforeMineru,
    wallTimeMs: Date.now() - t0,
  };
  await mkdir(REPORTS_ROOT, { recursive: true });
  await writeFile(join(REPORTS_ROOT, "model-setup.json"), JSON.stringify(record, null, 2), "utf8");
  console.log(JSON.stringify(record, null, 2));
}

const RUN_MATRIX: Array<{ parser: ParserId; mode: string }> = [
  { parser: "pdfjs", mode: "default" },
  { parser: "liteparse", mode: "default" },
  { parser: "docling", mode: "local" },
  { parser: "mineru", mode: "flash" },
  { parser: "mineru", mode: "basic" },
];

async function runAll(): Promise<void> {
  const fixtures = arg("--fixtures")?.split(",") ?? SMOKES.map((entry) => entry.fixture);
  const summary: Array<Record<string, unknown>> = [];
  let mineruServerNeeded = RUN_MATRIX.some((entry) => entry.parser === "mineru");
  let mineruServerUp = false;

  for (const fixture of fixtures) {
    for (const entry of RUN_MATRIX) {
      for (const cold of [true, false]) {
        if (entry.parser === "mineru" && mineruServerNeeded && !mineruServerUp) {
          const exit = await mineruServer("start");
          mineruServerUp = exit === 0;
        }
        const outcome = await runParser(entry.parser, entry.mode, fixture, { cold });
        summary.push({
          fixture,
          parser: `${entry.parser}${entry.parser === "mineru" ? `-${entry.mode}` : ""}`,
          cold,
          status: outcome.status,
          wallTimeMs: outcome.result?.performance.wallTimeMs ?? null,
          peakRssMb: outcome.result?.performance.peakRssMb ?? null,
          pages: outcome.result?.extraction.extractedPages ?? null,
          characters: outcome.result?.extraction.characters ?? null,
          blocks: outcome.result?.extraction.blocks ?? null,
          warnings: outcome.result?.reliability.warnings ?? outcome.warnings,
          tempClean: outcome.tempClean,
        });
        console.log(JSON.stringify(summary[summary.length - 1]));
        // If flash failed for resource reasons, do not attempt basic/standard (spec #17 escalation guard).
        if (entry.parser === "mineru" && entry.mode === "flash" && outcome.status === "SKIPPED_RESOURCE_CONSTRAINT") {
          console.log("MINERU_STANDARD_NOT_ATTEMPTED: resource constraint at flash tier");
        }
      }
    }
  }
  if (mineruServerUp) await mineruServer("stop");
  const { buildAggregateReport } = await import("./report.js");
  const report = await buildAggregateReport();
  const reportPath = await writeReportFile("summary.md", report.markdown);
  await writeFile(join(REPORTS_ROOT, "run-all-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(`REPORT_WRITTEN: ${reportPath}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const { verifyRuntime } = await import("./process-launcher.js");
  verifyRuntime();

  switch (command) {
    case "preflight": {
      await printHostBaseline();
      break;
    }
    case "setup-dirs": {
      for (const dir of [DATA_ROOT, CACHE_ROOT, FIXTURES_ROOT, REPORTS_ROOT, TEMP_ROOT]) mkdir(dir, { recursive: true }).catch(() => undefined);
      console.log("DATA_DIRS_READY");
      break;
    }
    case "setup-models":
      await setupModels();
      break;
    case "mineru-server": {
      const action = (arg("--action") ?? "status") as "status" | "start" | "stop";
      process.exitCode = await mineruServer(action);
      break;
    }
    case "run": {
      const parser = arg("--parser") as ParserId | undefined;
      if (!parser || !fixtureArg() || !ADAPTERS[parser]) throw new Error("USAGE: run --parser <id> [--mode <m>] --fixture <id> [--cold-only] [--timeout-ms N] [--page-cap N|all]");
      const mode = arg("--mode") ?? ADAPTERS[parser].modes[0]!;
      const fixture = fixtureArg()!;
      const colds = hasFlag("--cold-only") ? [true] : [true, false];
      for (const cold of colds) {
        const outcome = await runParser(parser, mode, fixture, {
          cold,
          timeoutOverrideMs: arg("--timeout-ms") ? Number(arg("--timeout-ms")) : undefined,
          pageCapOverride: arg("--page-cap") ? (arg("--page-cap") === "all" ? null : Number(arg("--page-cap"))) : undefined,
        });
        console.log(JSON.stringify(outcome.result ?? { status: outcome.status, warnings: outcome.warnings }, null, 2));
      }
      break;
    }
    case "run-all":
      await runAll();
      break;
    case "report": {
      const { buildAggregateReport } = await import("./report.js");
      const report = await buildAggregateReport();
      const path = await writeReportFile("summary.md", report.markdown);
      console.log(`REPORT_WRITTEN: ${path}`);
      break;
    }
    default:
      console.log("commands: preflight | setup-dirs | setup-models | mineru-server --action <status|start|stop> | run --parser <id> --fixture <id> [--mode m] | run-all | report");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
