import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterRunContext, AdapterRunOutput, ParserAdapter } from "./index.js";
import { parseMineruPageMarkers, splitOversizeText, type MineruContentBlock } from "./mineru-page-markers.js";
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

      // 01H: page-marker provenance. VALID markers produce per-page containers
      // with deterministic 0-based pageIndex (markers are 1-based) and
      // block-level binding + doc blockRefs. MISSING keeps the legacy
      // document-level container with null pageIndex. INVALID fails closed:
      // no normalized candidate is produced, so the run can never be OK.
      const markers = parseMineruPageMarkers(markdown, {
        expectedTotalPages: pagesArg === "all" ? context.fixture.entry.declaredPages : undefined,
        verifyDocIdPrefix: context.fixture.sha256,
      });

      const toDtoBlocks = (blocks: MineruContentBlock[], pageIndex: number) =>
        blocks.flatMap((b) => {
          const ref = b.imageRef
            ? `doc:${b.imageRef.doc}/tier:${b.imageRef.tier}/page:${b.imageRef.page}/block:${b.imageRef.block}`
            : null;
          return splitOversizeText(b.text).map((piece, part, all) => ({
            kind: b.kind,
            text: piece,
            pageIndex,
            bbox: null,
            confidence: null,
            sourceMethod: b.kind === "figure" ? "markdown-image-ref" : "model-pipeline",
            blockRef: ref === null ? null : all.length > 1 ? `${ref}#part${part + 1}` : ref,
          }));
        });

      if (markers.status === "VALID") {
        candidate = {
          parser: { name: "mineru", version: MINERU_VERSION, runtime: "python 3.12.3 (torch 2.14.0+cpu)", mode: context.mode },
          fixtureId: context.fixture.entry.id,
          // Page binding provenance comes ONLY from the validated markers
          // above; subset-local pageIndex never claims original-book physical
          // pages (mapping is product-side manifest lineage, spec 01H #7).
          pages: markers.pages.map((group) => ({
            pageIndex: group.pageLocal1Based - 1,
            printedPageLabel: null,
            blocks: toDtoBlocks(group.blocks, group.pageLocal1Based - 1),
          })),
          pageMarkers: {
            status: "VALID",
            declaredTotalPages: markers.declaredTotalPages,
            source: "mineru-markdown",
          },
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
      } else if (markers.status === "MISSING") {
        warnings.push("PAGE_MARKERS_MISSING");
        const blocks = markdown
          .split(/\n\s*\n/)
          .map((chunk) => chunk.trim())
          .filter((chunk) => chunk.length > 0)
          .flatMap((chunk) =>
            splitOversizeText(chunk).map((piece) => ({
              kind: piece.startsWith("#") ? "heading" : "paragraph",
              text: piece,
              pageIndex: null as number | null,
              bbox: null,
              confidence: null,
              sourceMethod: "model-pipeline",
              blockRef: null,
            })),
          );
        if (blocks.length > 0) {
          candidate = {
            parser: { name: "mineru", version: MINERU_VERSION, runtime: "python 3.12.3 (torch 2.14.0+cpu)", mode: context.mode },
            fixtureId: context.fixture.entry.id,
            // MinerU markdown is a document-level stream without page markers;
            // per-block page binding is not asserted and stays unknown.
            pages: [{ pageIndex: 0, printedPageLabel: null, blocks }],
            pageMarkers: {
              status: "MISSING",
              declaredTotalPages: 0,
              source: "mineru-markdown",
            },
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
      } else {
        // Fail closed: invalid markers can never produce a successful run.
        warnings.push(`PAGE_MARKERS_INVALID: ${markers.failure.code}: ${markers.failure.detail}`);
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
