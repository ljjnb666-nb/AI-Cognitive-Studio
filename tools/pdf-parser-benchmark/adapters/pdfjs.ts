import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterRunContext, AdapterRunOutput, ParserAdapter } from "./index.js";
import { pdfjsChildPath, pdfjsLoaderImportUrl } from "./paths.js";

/**
 * Adapter for the current production parser `pdfjs-isolated`.
 * The child executes the real packages/ingestion parseDocument, so the
 * production limits (2000 pages / 30s timeout / 128MB child heap / 24MB IPC)
 * apply unchanged (Phase 1 spec #14: do not raise limits, do not fix defects).
 */

const PDFJS_VERSION = "6.2.108";
const ISOLATION_VERSION = "pdf-isolation-v3";

export const pdfjsAdapter: ParserAdapter = {
  id: "pdfjs",
  // native parser, production-equivalent load: measured peak well under 1 GB
  minRamAvailableGb: 1.0,
  defaultTimeoutMs: 120_000,
  defaultPageCap: null,
  modes: ["default"],
  parserKey: () => "pdfjs",

  async run(context: AdapterRunContext): Promise<AdapterRunOutput> {
    const resultPath = join(context.tempDir, "pdfjs-result.json");
    const outcome = await context.runner.run(
      {
        programId: "node",
        argv: ["--import", pdfjsLoaderImportUrl(), pdfjsChildPath(), context.fixture.path, resultPath],
        cwd: context.tempDir,
        env: { TMP: context.tempDir, TEMP: context.tempDir },
      },
      { timeoutMs: context.timeoutOverrideMs ?? 120_000 },
    );

    let candidate: unknown = null;
    const warnings = [...context.warnings];
    try {
      const raw = await readFile(resultPath, "utf8");
      const parsed = JSON.parse(raw) as { ok: boolean; error?: string; selfRssMb?: number; parser?: { name: string; version: string }; pages?: Array<{ physicalPageIndex: number | null; blocks: Array<{ kind: string; text: string }> }> };
      if (parsed.ok && parsed.pages) {
        if (typeof parsed.selfRssMb === "number") {
          outcome.peakRssMb = Math.max(outcome.peakRssMb ?? 0, parsed.selfRssMb);
        }
        candidate = {
          parser: { name: `${parsed.parser?.name ?? "pdfjs-isolated"}`, version: `${parsed.parser?.version ?? ISOLATION_VERSION} (pdfjs-dist ${PDFJS_VERSION})`, runtime: "node", mode: context.mode },
          fixtureId: context.fixture.entry.id,
          pages: parsed.pages.map((page, pageOrdinal) => ({
            pageIndex: page.physicalPageIndex ?? pageOrdinal,
            printedPageLabel: null,
            blocks: page.blocks.map((block) => ({
              kind: block.kind.toLowerCase(),
              text: block.text,
              pageIndex: page.physicalPageIndex ?? pageOrdinal,
              bbox: null,
              confidence: null,
              sourceMethod: "native-text",
            })),
          })),
          readingOrderAvailable: false,
          // The production pdfjs baseline performs no OCR — recorded as a fact,
          // never wrapped with an external OCR engine (spec #6).
          ocr: {
            ocrModeRequested: false,
            ocrEnabled: false,
            engine: null,
            model: null,
            modelRevision: null,
            language: null,
            pagesOcrProcessed: null,
            pagesRequiringOcr: null,
            pagesOcrSucceeded: null,
          },
        };
      } else {
        warnings.push(`PARSER_ERROR: ${parsed.error ?? "unknown"}`);
      }
    } catch {
      warnings.push("NO_RESULT_FILE: child did not produce a parsable result (see stderr log)");
    }

    return {
      parser: { name: "pdfjs-isolated", version: `${ISOLATION_VERSION} (pdfjs-dist ${PDFJS_VERSION})`, runtime: "node-child", mode: context.mode },
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
