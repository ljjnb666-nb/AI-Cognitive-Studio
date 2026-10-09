import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterRunContext, AdapterRunOutput, ParserAdapter } from "./index.js";
import { doclingRunnerPath } from "./paths.js";
import { CACHE_ROOT, MODELS_ROOT } from "../src/filesystem-guard.js";

export const DOCLING_PYTHON = "3.12.3";
const DEFAULT_TIMEOUT = 1_200_000;

/**
 * Docling adapter. Model downloads are excluded from timed inference via the
 * harness `setup-models` preload (#27); each run is a fresh process, so
 * "cold" = first inference (cold OS file cache) and "warm" = second run.
 */
export const doclingAdapter: ParserAdapter = {
  id: "docling",
  // CPU pipeline with local artifacts; observed torch-CPU footprint fits in
  // ~2 GB for small docs. Vendor minimums target GPU/VLM setups, not this.
  minRamAvailableGb: 2.5,
  defaultTimeoutMs: DEFAULT_TIMEOUT,
  defaultPageCap: 50,
  modes: ["local", "ocr"],
  parserKey: (mode) => (mode === "ocr" ? "docling-ocr" : "docling"),

  async run(context: AdapterRunContext): Promise<AdapterRunOutput> {
    const resultPath = join(context.tempDir, "docling-result.json");
    const markdownPath = join(context.tempDir, "docling-result.md");
    const cap = context.pageCapOverride === undefined ? 50 : context.pageCapOverride;
    const pageCapArg = cap === null || cap === 0 ? "all" : String(cap);
    if (pageCapArg !== "all") context.warnings.push(`PAGE_SUBSET: first ${pageCapArg} pages only`);
    const ocrPolicy = context.mode === "ocr" ? "ocr" : "native";

    const outcome = await context.runner.run(
      {
        programId: "docling_python",
        argv: [doclingRunnerPath(), context.fixture.path, resultPath, markdownPath, pageCapArg, ocrPolicy],
        cwd: context.tempDir,
        env: {
          HF_HOME: join(CACHE_ROOT, "huggingface"),
          TMP: context.tempDir,
          TEMP: context.tempDir,
          HF_HUB_DISABLE_TELEMETRY: "1",
          DOCLING_ARTIFACTS_PATH: join(MODELS_ROOT, "docling"),
        },
      },
      { timeoutMs: context.timeoutOverrideMs ?? DEFAULT_TIMEOUT },
    );

    // preserve raw parser output before temp cleanup
    await copyIfExists(resultPath, join(context.rawDir, "docling-result.json"));
    await copyIfExists(markdownPath, join(context.rawDir, "docling-result.md"));

    let candidate: unknown = null;
    const warnings = [...context.warnings];
    try {
      const parsed = JSON.parse(await readFile(resultPath, "utf8")) as {
        ok: boolean;
        error?: string;
        doclingVersion?: string;
        ocrRequested?: boolean;
        doOcr?: boolean | null;
        ocrBackend?: string | null;
        ocrLanguage?: string | null;
        pages?: Array<Record<string, unknown>>;
      };
      if (parsed.ok && parsed.pages) {
        context.warnings.push(
          `DOCLING_META: version=${parsed.doclingVersion} ocr_requested=${parsed.ocrRequested} do_ocr=${parsed.doOcr} ocr_backend=${parsed.ocrBackend ?? "UNKNOWN"} lang=${parsed.ocrLanguage ?? "UNKNOWN"}`,
        );
        candidate = {
          parser: {
            name: "docling",
            version: parsed.doclingVersion ?? "unknown",
            runtime: `python ${DOCLING_PYTHON}`,
            mode: context.mode,
            modelName: "layout+tableformer defaults",
            modelRevision: "UNKNOWN",
          },
          fixtureId: context.fixture.entry.id,
          pages: parsed.pages,
          readingOrderAvailable: true,
          ocr: {
            ocrModeRequested: parsed.ocrRequested ?? context.mode === "ocr",
            ocrEnabled: parsed.doOcr ?? null,
            engine: parsed.ocrBackend ?? null,
            model: null,
            modelRevision: null,
            language: parsed.ocrLanguage ?? null,
            pagesOcrProcessed: null,
            pagesRequiringOcr: null,
            pagesOcrSucceeded: null,
          },
        };
      } else {
        warnings.push(`PARSER_ERROR: ${parsed.error ?? "unknown"}`);
      }
    } catch {
      warnings.push("NO_RESULT_FILE: runner did not produce a parsable result (see stderr log)");
    }

    return {
      parser: { name: "docling", version: "unknown", runtime: `python ${DOCLING_PYTHON}`, mode: context.mode },
      normalizedCandidate: candidate,
      metrics: {
        wallTimeMs: outcome.wallTimeMs,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        // stdout, stderr and output directory limits are all terminal failures.
        outputLimitExceeded: outcome.outputLimitExceeded || outcome.stdoutTruncated || outcome.stderrTruncated,
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

async function copyIfExists(from: string, to: string): Promise<void> {
  try {
    const info = await stat(from);
    if (info.isFile()) {
      const { copyFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  } catch {
    // source missing — nothing to preserve
  }
}
