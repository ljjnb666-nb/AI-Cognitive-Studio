import { z } from "zod";

/**
 * Common benchmark result contract (Phase 1 spec #23).
 * Unsupported capabilities MUST be null, never a fabricated 0.
 */

export const zNullableFinite = z.number().refine((v) => Number.isFinite(v), "must be finite");

export const ParserDescriptor = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  mode: z.string().optional(),
  runtime: z.string().optional(),
  modelName: z.string().optional(),
  modelRevision: z.string().optional(),
});
export type ParserDescriptor = z.infer<typeof ParserDescriptor>;

export const DocumentDescriptor = z.object({
  fixtureId: z.string().min(1),
  inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  detectedPages: z.number().int().nonnegative().nullable().optional(),
});
export type DocumentDescriptor = z.infer<typeof DocumentDescriptor>;

export const Reliability = z.object({
  exitCode: z.number().int().nullable(),
  timeout: z.boolean(),
  crashed: z.boolean(),
  failureKind: z.enum(["EXPECTED_CAPABILITY_REJECTION", "TIMEOUT", "OUT_OF_MEMORY", "PROCESS_FAILURE", "INVALID_OUTPUT", "HARNESS_ERROR"]).nullable().optional(),
  oom: z.boolean(),
  partialOutput: z.boolean(),
  warnings: z.array(z.string()),
});
export type Reliability = z.infer<typeof Reliability>;

export const Extraction = z.object({
  extractedPages: z.number().int().nonnegative(),
  emptyPages: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  blocks: z.number().int().nonnegative(),
  headings: zNullableFinite.nullable(),
  tables: zNullableFinite.nullable(),
  figures: zNullableFinite.nullable(),
  equations: zNullableFinite.nullable(),
  ocrPages: zNullableFinite.nullable(),
});

export const Evidence = z.object({
  physicalPageIndex: z.boolean(),
  bbox: z.boolean(),
  confidence: z.boolean(),
  readingOrder: z.boolean(),
  printedPageLabel: z.boolean(),
});

/** Normalized per-page block shape — also the Phase 2 ReviewPage seed (#39). */
export const NormalizedBlock = z.object({
  kind: z.string().min(1),
  text: z.string().max(200_000),
  pageIndex: z.number().int().nonnegative().nullable(),
  bbox: z
    .object({
      x0: zNullableFinite,
      y0: zNullableFinite,
      x1: zNullableFinite,
      y1: zNullableFinite,
    })
    .nullable(),
  confidence: zNullableFinite.nullable(),
  sourceMethod: z.string().nullable(),
  /**
   * 01H: upstream traceability id for the block (e.g. MinerU
   * `doc:<sha>/tier:<tier>/page:N/block:M`). Null/absent when the parser does
   * not expose one. Data identifier only — never a filesystem path.
   */
  blockRef: z.string().max(300).nullable().optional(),
});

export const NormalizedPage = z.object({
  pageIndex: z.number().int().nonnegative(),
  printedPageLabel: z.string().nullable(),
  blocks: z.array(NormalizedBlock),
});

/**
 * 01H: page-binding provenance for parsers whose output carries page markers
 * (MinerU markdown). VALID = markers validated (consecutive, unique, ordered,
 * doc refs consistent); MISSING = no markers, page binding stays unknown.
 * Absent on parsers without marker concepts and on legacy persisted results.
 */
export const PageMarkerProvenance = z.object({
  status: z.enum(["VALID", "MISSING"]),
  declaredTotalPages: z.number().int().nonnegative(),
  source: z.string().min(1),
});

/**
 * OCR provenance (Phase 2B spec #6). Facts only: fields upstream does not
 * expose stay null — never guessed. ocrModeRequested is the benchmark's own
 * declared intent for the mode; ocrEnabled is what upstream reports.
 */
export const OcrProvenanceSchema = z.object({
  ocrModeRequested: z.boolean(),
  ocrEnabled: z.boolean().nullable(),
  engine: z.string().nullable(),
  model: z.string().nullable(),
  modelRevision: z.string().nullable(),
  language: z.string().nullable(),
  pagesOcrProcessed: z.number().int().nonnegative().nullable(),
  pagesRequiringOcr: z.number().int().nonnegative().nullable(),
  pagesOcrSucceeded: z.number().int().nonnegative().nullable(),
});

export const NormalizedOutput = z.object({
  parser: ParserDescriptor,
  fixtureId: z.string().min(1),
  pages: z.array(NormalizedPage).max(5_000),
  readingOrderAvailable: z.boolean(),
  ocr: OcrProvenanceSchema.optional(),
  pageMarkers: PageMarkerProvenance.optional(),
});

export const BenchmarkResult = z.object({
  run: z.object({
    id: z.string().min(1),
    startedAt: z.string(),
    finishedAt: z.string(),
    coldStart: z.boolean(),
  }),
  parser: ParserDescriptor,
  document: DocumentDescriptor,
  performance: z.object({
    wallTimeMs: z.number().nonnegative(),
    cpuTimeMs: zNullableFinite.nullable(),
    peakRssMb: zNullableFinite.nullable(),
    peakGpuMb: zNullableFinite.nullable(),
  }),
  reliability: Reliability,
  extraction: Extraction,
  evidence: Evidence,
});
export type BenchmarkResult = z.infer<typeof BenchmarkResult>;
export type NormalizedOutput = z.infer<typeof NormalizedOutput>;
export type OcrProvenance = z.infer<typeof OcrProvenanceSchema>;

/** Structural capability inventory (#37) — facts only, no scoring. */
export type CapabilityMatrixRow = {
  parser: string;
  page: boolean;
  bbox: boolean;
  heading: boolean;
  paragraph: boolean;
  table: boolean;
  figure: boolean;
  equation: boolean;
  readingOrder: boolean;
  confidence: boolean;
  ocrMarker: boolean;
  printedPageLabel: boolean;
};

export class SchemaValidationError extends Error {
  constructor(public readonly issues: string) {
    super(`SCHEMA_VALIDATION_FAILED: ${issues}`);
  }
}

export function parseBenchmarkResult(raw: unknown): BenchmarkResult {
  const parsed = BenchmarkResult.safeParse(raw);
  if (!parsed.success) throw new SchemaValidationError(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

export function parseNormalizedOutput(raw: unknown): NormalizedOutput {
  const parsed = NormalizedOutput.safeParse(raw);
  if (!parsed.success) throw new SchemaValidationError(JSON.stringify(parsed.error.issues));
  const flat = (v: unknown): string => JSON.stringify(v);
  // Semantic validation (#29): no NaN/Infinity anywhere in the tree.
  const seen = JSON.stringify(parsed.data, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? flat(v) : v));
  if (seen.includes('"NaN"') || seen.includes('"Infinity"')) throw new SchemaValidationError("non-finite number in output");
  return parsed.data;
}

/**
 * Page-binding capability evidence (01H). `physicalPageIndex` is true ONLY
 * when every content block carries an integer pageIndex that matches its own
 * page container and page indexes are unique — an ordinary array index on a
 * document-level container (blocks all null) does NOT prove page binding.
 *
 * Semantics: the index is physical for the PROCESSED document. It is NOT the
 * original-book physical page; mapping a processed-document page to the book
 * requires pinned manifest lineage in the product layer (see README:
 * subset-local pageIndex can never be published as a book page number).
 */
export function buildEvidence(
  pages: NormalizedOutput["pages"],
  blocks: NormalizedOutput["pages"][number]["blocks"],
  readingOrderAvailable: boolean,
): z.infer<typeof Evidence> {
  const pagesBound = pages.length > 0 && pages.every((p) => Number.isInteger(p.pageIndex));
  const pageIndexesUnique = new Set(pages.map((p) => p.pageIndex)).size === pages.length;
  const blocksBound = blocks.length > 0 && blocks.every((b) => Number.isInteger(b.pageIndex));
  const blockInOwnPage =
    blocksBound &&
    pages.every((p) => p.blocks.every((b) => b.pageIndex === p.pageIndex));
  return {
    physicalPageIndex: pagesBound && pageIndexesUnique && blocksBound && blockInOwnPage,
    bbox: blocks.some((b) => b.bbox !== null) || false,
    confidence: blocks.some((b) => b.confidence !== null) || false,
    readingOrder: readingOrderAvailable,
    printedPageLabel: pages.some((p) => p.printedPageLabel !== null) || false,
  };
}

/** Derives the public BenchmarkResult from a validated normalized output + run metadata. */
export function buildBenchmarkResult(input: {
  run: BenchmarkResult["run"];
  parser: ParserDescriptor;
  document: DocumentDescriptor;
  performance: BenchmarkResult["performance"];
  reliability: Reliability;
  normalized: NormalizedOutput | null;
}): BenchmarkResult {
  const { normalized } = input;
  const pages = normalized?.pages ?? [];
  const blocks = pages.flatMap((p) => p.blocks);
  const nonEmptyPages = pages.filter((p) => p.blocks.some((b) => b.text.trim().length > 0)).length;
  const count = (kinds: string[]) => {
    const n = blocks.filter((b) => kinds.includes(b.kind)).length;
    return n > 0 ? n : null; // unknown-vs-zero is only preserved when parser declares support; see capability matrix
  };
  return {
    run: input.run,
    parser: input.parser,
    document: input.document,
    performance: input.performance,
    reliability: input.reliability,
    extraction: {
      extractedPages: normalized ? pages.length : 0,
      emptyPages: normalized ? pages.length - nonEmptyPages : 0,
      characters: blocks.reduce((sum, b) => sum + b.text.length, 0),
      blocks: blocks.length,
      headings: normalized ? count(["heading", "title", "section-header"]) : null,
      tables: normalized ? count(["table"]) : null,
      figures: normalized ? count(["figure", "image", "picture"]) : null,
      equations: normalized ? count(["equation", "formula"]) : null,
      ocrPages: null,
    },
    evidence: buildEvidence(pages, blocks, normalized?.readingOrderAvailable ?? false),
  };
}
