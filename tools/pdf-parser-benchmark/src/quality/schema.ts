import { z } from "zod";
import { OcrProvenanceSchema } from "../schema.js";

/**
 * Quality result contract (Phase 2B spec #15). Additive sidecar — the existing
 * BenchmarkResult is untouched. Every metric is deterministic, finite or null;
 * NaN/Infinity are rejected at validation time.
 */

export const zMetric = z.number().refine((v) => Number.isFinite(v), "metric must be finite");
const zMetricNullable = zMetric.nullable();

export type OcrMetadata = z.infer<typeof OcrProvenanceSchema>;

export const TextQuality = z.object({
  expectedChars: z.number().int().nonnegative(),
  actualChars: z.number().int().nonnegative(),
  charRecall: zMetricNullable,
  charPrecision: zMetricNullable,
  editDistance: zMetricNullable,
  /** false when the inputs exceed the bounded edit-distance window (documented, not silently omitted). */
  editDistanceAvailable: z.boolean(),
  trigramRecall: zMetricNullable,
  duplicateRatio: zMetric,
  unexpectedRatio: zMetricNullable,
  missingKeyMarkers: z.array(z.string()),
});
export type TextQuality = z.infer<typeof TextQuality>;

export const ReadingOrderQuality = z.object({
  /** readingOrderAvailable flag claimed by the parser normalization — NOT correctness. */
  claimedAvailable: z.boolean(),
  blocksExpected: z.number().int().nonnegative(),
  blocksMatched: z.number().int().nonnegative(),
  comparablePairs: z.number().int().nonnegative(),
  correctPairs: z.number().int().nonnegative(),
  orderedPairAccuracy: zMetricNullable,
  interleavingDetected: z.boolean().nullable(),
  columnMajorPreserved: z.boolean().nullable(),
});
export type ReadingOrderQuality = z.infer<typeof ReadingOrderQuality>;

export const StructureQuality = z.object({
  headings: z.object({
    expected: z.number().int().nonnegative(),
    detectedAsHeading: z.number().int().nonnegative(),
    textPresentWrongKind: z.number().int().nonnegative(),
    missed: z.number().int().nonnegative(),
  }),
  paragraphsExpected: z.number().int().nonnegative(),
  paragraphBlocksMatched: z.number().int().nonnegative(),
  listItemsExpected: z.number().int().nonnegative(),
  listItemsMatchedAsListItem: z.number().int().nonnegative(),
  figuresExpected: z.number().int().nonnegative(),
  figuresDetected: z.number().int().nonnegative(),
});
export type StructureQuality = z.infer<typeof StructureQuality>;

export const PageFidelityQuality = z.object({
  pagesExpected: z.number().int().nonnegative(),
  outputPages: z.number().int().nonnegative(),
  /** null when the parser emits no per-block page binding (unsupported, not zero). */
  blocksWithPageIndex: z.number().int().nonnegative().nullable(),
  pageIndexCorrect: z.number().int().nonnegative().nullable(),
  pageIndexMismatched: z.number().int().nonnegative().nullable(),
  pageIndexAccuracy: zMetricNullable,
  /** false = parser emits no bbox at all (unsupported); null fields stay null. */
  bboxSupported: z.boolean(),
  bboxBlocks: z.number().int().nonnegative().nullable(),
  bboxWithinPageBounds: z.number().int().nonnegative().nullable(),
  bboxWildlyInvalid: z.number().int().nonnegative().nullable(),
});
export type PageFidelityQuality = z.infer<typeof PageFidelityQuality>;

export const TableQuality = z.object({
  tablesExpected: z.number().int().nonnegative(),
  structuralTablesDetected: z.number().int().nonnegative(),
  cellTextsExpected: z.number().int().nonnegative(),
  cellTextsRecoveredStructural: z.number().int().nonnegative(),
  cellTextsRecoveredInPlainText: z.number().int().nonnegative(),
  cellTextsMissing: z.number().int().nonnegative(),
  /** TABLE_FLATTENED_TO_TEXT semantics: cells present only as flat text. */
  flattenedToText: z.boolean().nullable(),
  rowOrderPreserved: z.boolean().nullable(),
});
export type TableQuality = z.infer<typeof TableQuality>;

export const FormulaQuality = z.object({
  formulasExpected: z.number().int().nonnegative(),
  detectedStructural: z.number().int().nonnegative(),
  preservedAsText: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  corrupted: z.number().int().nonnegative(),
  /** Whether the parser emitted ANY structural equation block in this run — unsupported-vs-missed signal. */
  structuralEquationKindSeenInRun: z.boolean(),
});
export type FormulaQuality = z.infer<typeof FormulaQuality>;

export const OcrQuality = z.object({
  required: z.boolean(),
  charRecall: zMetricNullable,
  charPrecision: zMetricNullable,
  editDistance: zMetricNullable,
  trigramRecall: zMetricNullable,
  keyPhrasesExpected: z.number().int().nonnegative(),
  keyPhrasesRecovered: z.number().int().nonnegative(),
  pageCoverage: zMetricNullable,
  metadata: OcrProvenanceSchema.nullable(),
});
export type OcrQuality = z.infer<typeof OcrQuality>;

export const ContaminationQuality = z.object({
  noiseSources: z.number().int().nonnegative(),
  noiseOccurrences: z.number().int().nonnegative(),
  /** Fraction of extracted characters attributable to repeated noise text. */
  noiseCharRatio: zMetric,
  repeatedNoiseBlocks: z.number().int().nonnegative(),
});
export type ContaminationQuality = z.infer<typeof ContaminationQuality>;

export const QualityReport = z.object({
  // v1 = initial containment-based page attribution; v2 = reading-order-based
  // attribution (fixes mis-attribution of cross-page duplicate text). Both are
  // valid immutable evidence; new runs always write v2.
  evaluatorVersion: z.enum(["pdf-quality-eval-v1", "pdf-quality-eval-v2"]),
  runId: z.string().min(1),
  fixtureId: z.string().min(1),
  parserKey: z.string().min(1),
  parserMode: z.string(),
  status: z.enum(["EVALUATED", "SKIPPED_GROUND_TRUTH_MISSING", "SKIPPED_GROUND_TRUTH_INVALID", "SKIPPED_NO_NORMALIZED_OUTPUT", "QUALITY_EVALUATION_FAILED"]),
  error: z.string().nullable(),
  evaluatedAt: z.string(),
  text: TextQuality.nullable(),
  readingOrder: ReadingOrderQuality.nullable(),
  structure: StructureQuality.nullable(),
  pages: PageFidelityQuality.nullable(),
  table: TableQuality.nullable(),
  formula: FormulaQuality.nullable(),
  ocr: OcrQuality.nullable(),
  contamination: ContaminationQuality.nullable(),
});
export type QualityReport = z.infer<typeof QualityReport>;

export class QualitySchemaValidationError extends Error {
  constructor(public readonly issues: string) {
    super(`QUALITY_SCHEMA_INVALID: ${issues}`);
  }
}

export function parseQualityReport(raw: unknown): QualityReport {
  const parsed = QualityReport.safeParse(raw);
  if (!parsed.success) throw new QualitySchemaValidationError(JSON.stringify(parsed.error.issues));
  return parsed.data;
}
