import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterRunContext, AdapterRunOutput, ParserAdapter } from "./index.js";
import { CACHE_ROOT } from "../src/filesystem-guard.js";

const MINERU_VERSION = "4.0.3";
const DEFAULT_TIMEOUT = 1_200_000;

/**
 * MinerU adapter (upstream CLI `mineru parse`, local tiers via its local
 * server — started/stopped by the harness `mineru-server` command, never left
 * running). flash/basic always attempted after preflight; standard only when
 * flash+basic succeeded and resources remained safe (spec #17); advanced is
 * out of scope this phase.
 */
export const mineruAdapter: ParserAdapter = {
  id: "mineru",
  // tier basic/flash use the small ONNX backend (~820 MB models on disk),
  // not the 16 GB-class torch pipeline; gate set to the observed onnx budget.
  minRamAvailableGb: 2.5,
  defaultTimeoutMs: DEFAULT_TIMEOUT,
  defaultPageCap: 50,
  modes: ["flash", "basic", "standard"],
  parserKey: (mode) => `mineru-${mode}`,

  async run(context: AdapterRunContext): Promise<AdapterRunOutput> {
    const markdownPath = join(context.tempDir, "mineru-result.md");
    const cap = context.pageCapOverride === undefined ? 50 : context.pageCapOverride;
    const totalPages = context.fixture.entry.declaredPages;
    const pagesArg = cap === null || cap === 0 || totalPages <= cap ? "all" : `1-${cap}`;
    if (pagesArg !== "all") context.warnings.push(`PAGE_SUBSET: ${pagesArg} of ${totalPages} pages`);

    const outcome = await context.runner.run(
      {
        programId: "mineru_cli",
        argv: ["parse", context.fixture.path, "--tier", context.mode, "--pages", pagesArg, "--output", markdownPath, "--json", "--force"],
        cwd: context.tempDir,
        env: {
          MINERU_HOME: join(CACHE_ROOT, "mineru", "home"),
          MINERU_MODEL_SOURCE: "auto",
          HF_HOME: join(CACHE_ROOT, "huggingface"),
          TMP: context.tempDir,
          TEMP: context.tempDir,
        },
      },
      { timeoutMs: context.timeoutOverrideMs ?? DEFAULT_TIMEOUT },
    );

    // preserve raw output (stdout JSON envelope + markdown) before temp cleanup
    const { copyFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(context.rawDir, { recursive: true });
    await writeFileSafe(join(context.rawDir, "mineru-stdout.json"), outcome.stdout);
    await copyIfExists(markdownPath, join(context.rawDir, "mineru-result.md"));

    let candidate: unknown = null;
    const warnings = [...context.warnings];

    // The --json envelope on stdout is untrusted; only simple scalar facts are read.
    let envelopePages: number | null = null;
    try {
      const envelopeLine = outcome.stdout.split(/\r?\n/).find((line) => line.trim().startsWith("{"));
      if (envelopeLine) {
        const envelope = JSON.parse(envelopeLine) as Record<string, unknown>;
        const candidatePages = envelope["total_pages"] ?? envelope["pages"] ?? envelope["page_count"];
        if (typeof candidatePages === "number") envelopePages = candidatePages;
      }
    } catch {
      warnings.push("MINERU_ENVELOPE_UNPARSABLE");
    }

    try {
      const markdown = await readFile(markdownPath, "utf8");
      const blocks = markdown
        .split(/\n\s*\n/)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0)
        .map((chunk) => ({
          kind: chunk.startsWith("#") ? "heading" : "paragraph",
          text: chunk.slice(0, 32_000),
          pageIndex: null as number | null,
          bbox: null,
          confidence: null,
          sourceMethod: "model-pipeline",
        }));
      if (blocks.length > 0) {
        candidate = {
          parser: { name: "mineru", version: MINERU_VERSION, runtime: "python 3.12.3 (torch 2.14.0+cpu)", mode: context.mode },
          fixtureId: context.fixture.entry.id,
          // MinerU markdown is a document-level stream; per-block page binding is
          // not asserted. Facts only: pages stay null, envelope count recorded.
          pages: [{ pageIndex: 0, printedPageLabel: null, blocks }],
          readingOrderAvailable: true,
          // MinerU's CLI exposes no OCR toggle or engine fields — its pipeline
          // OCRs image-only pages by design. Unknowns stay null (spec #6).
          ocr: {
            ocrModeRequested: false,
            ocrEnabled: null,
            engine: null,
            model: null,
            modelRevision: null,
            language: null,
            pagesOcrProcessed: null,
            pagesRequiringOcr: null,
            pagesOcrSucceeded: null,
          },
        };
        if (envelopePages !== null) warnings.push(`MINERU_ENVELOPE_TOTAL_PAGES: ${envelopePages}`);
      } else {
        warnings.push("MINERU_EMPTY_MARKDOWN");
      }
    } catch {
      warnings.push("NO_RESULT_FILE: mineru produced no markdown output (see stderr log)");
    }

    return {
      parser: { name: "mineru", version: MINERU_VERSION, runtime: "python 3.12.3 (torch 2.14.0+cpu)", mode: context.mode },
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

async function writeFileSafe(path: string, content: string): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function copyIfExists(from: string, to: string): Promise<void> {
  try {
    const { copyFile } = await import("node:fs/promises");
    await copyFile(from, to);
  } catch {
    // source missing — nothing to preserve
  }
}
