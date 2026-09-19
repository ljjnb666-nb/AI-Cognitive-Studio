import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterRunContext, AdapterRunOutput, ParserAdapter } from "./index.js";
import { liteparseChildPath } from "./paths.js";

const LITEPARSE_VERSION = "2.14.6";
const LITEPARSE_BINDING = "node-native (@llamaindex/liteparse-win32-x64-msvc)";

export const liteparseAdapter: ParserAdapter = {
  id: "liteparse",
  // native parser: measured peak well under 1 GB
  minRamAvailableGb: 1.0,
  defaultTimeoutMs: 180_000,
  defaultPageCap: null,
  modes: ["default"],
  parserKey: () => "liteparse",

  async run(context: AdapterRunContext): Promise<AdapterRunOutput> {
    const resultPath = join(context.tempDir, "liteparse-result.json");
    const outcome = await context.runner.run(
      {
        programId: "node",
        argv: [liteparseChildPath(), context.fixture.path, resultPath],
        cwd: context.tempDir,
        env: { TMP: context.tempDir, TEMP: context.tempDir },
      },
      { timeoutMs: context.timeoutOverrideMs ?? 180_000 },
    );

    let candidate: unknown = null;
    const warnings = [...context.warnings];
    try {
      const raw = await readFile(resultPath, "utf8");
      const parsed = JSON.parse(raw) as {
        ok: boolean;
        error?: string;
        totalPages?: number;
        needsOcrPageIndexes?: number[];
        selfRssMb?: number;
        pages?: Array<{ pageIndex: number; printedPageLabel: string | null; blocks: Array<Record<string, unknown>> }>;
      };
      if (parsed.ok && parsed.pages) {
        if ((parsed.needsOcrPageIndexes?.length ?? 0) > 0) {
          warnings.push(`OCR_NEEDED_ON_PAGES: ${parsed.needsOcrPageIndexes!.join(",")} (OCR_NOT_TESTED)`);
        }
        if (typeof parsed.selfRssMb === "number") {
          outcome.peakRssMb = Math.max(outcome.peakRssMb ?? 0, parsed.selfRssMb);
        }
        candidate = {
          parser: { name: "liteparse", version: LITEPARSE_VERSION, runtime: LITEPARSE_BINDING, mode: context.mode },
          fixtureId: context.fixture.entry.id,
          pages: parsed.pages,
          readingOrderAvailable: true,
        };
      } else {
        warnings.push(`PARSER_ERROR: ${parsed.error ?? "unknown"}`);
      }
    } catch {
      warnings.push("NO_RESULT_FILE: child did not produce a parsable result (see stderr log)");
    }

    return {
      parser: { name: "liteparse", version: LITEPARSE_VERSION, runtime: LITEPARSE_BINDING, mode: context.mode },
      normalizedCandidate: candidate,
      metrics: {
        wallTimeMs: outcome.wallTimeMs,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        outputLimitExceeded: outcome.outputLimitExceeded,
        peakRssMb: outcome.peakRssMb,
        cpuTimeMs: outcome.cpuTimeMs,
        peakGpuMb: outcome.peakGpuMb,
      },
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      warnings,
    };
  },
};
