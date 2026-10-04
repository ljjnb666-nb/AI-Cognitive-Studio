import { z } from "zod";
import { canonicalSourceLocatorSchema } from "./source-locator.js";

/**
 * Canonical extraction contract version (canonical-book-v1).
 *
 * Written to DocumentExtraction.canonicalSchemaVersion by every extraction that
 * produces canonical block metadata. Historical rows keep NULL — never backfill.
 */
export const CANONICAL_SCHEMA_VERSION = "canonical-book-v1";

/**
 * How the bytes under a block were actually obtained. One extraction may mix
 * methods across blocks (for example pdfjs native pages next to OCR fallback
 * pages), so provenance is per-block, never per-extraction only.
 */
export const EXTRACTION_SOURCE_METHODS = [
  "NATIVE_TEXT",
  "OCR",
  "STRUCTURED_MARKUP",
  "LAYOUT_MODEL",
  "UNKNOWN",
] as const;

export type ExtractionSourceMethod = (typeof EXTRACTION_SOURCE_METHODS)[number];

/** UNKNOWN is reserved for legacy rows or blocks whose origin cannot be determined. */
export const blockExtractionProvenanceSchema = z.strictObject({
  sourceMethod: z.enum(EXTRACTION_SOURCE_METHODS),
  parserName: z.string().min(1),
  parserVersion: z.string().min(1),
  parserMode: z.string().min(1).nullish(),
  /**
   * Parser confidence in [0, 1] when (and only when) the producer emits one in
   * that semantic. Never rescale foreign confidence ranges; leave it unset
   * instead. Non-finite values are always invalid.
   */
  confidence: z
    .number()
    .refine(Number.isFinite, { message: "NON_FINITE_CONFIDENCE" })
    .refine((value) => value >= 0 && value <= 1, { message: "CONFIDENCE_OUT_OF_RANGE" })
    .nullish(),
});

export type BlockExtractionProvenance = z.infer<typeof blockExtractionProvenanceSchema>;

/**
 * Canonical SourceBlock.metadata layout (canonical-book-v1): the block locator,
 * the block extraction provenance, plus reserved additive fields such as
 * headingLevel that downstream structure inference already reads. Strict on
 * purpose — unknown keys indicate a contract drift, not legacy data (legacy rows
 * are recognized by failing this schema and being read tolerantly instead).
 */
export const canonicalBlockMetadataSchema = z.strictObject({
  // Null for blocks from formats the locator union does not cover (TXT /
  // Markdown); PDF and EPUB blocks always carry a real locator.
  locator: canonicalSourceLocatorSchema.nullish(),
  provenance: blockExtractionProvenanceSchema,
  headingLevel: z.number().int().min(1).max(6).nullish(),
});

export type CanonicalBlockMetadata = z.infer<typeof canonicalBlockMetadataSchema>;

/** Strict parse for newly written blocks. Throws on any v1 contract violation. */
export function parseCanonicalBlockMetadata(value: unknown): CanonicalBlockMetadata {
  return canonicalBlockMetadataSchema.parse(value);
}

/**
 * Tolerant read for historical rows: returns null when the stored metadata does
 * not conform to the canonical v1 contract (legacy pre-contract metadata such as
 * bare `{ spineIndex, href }`, or malformed data). Callers gate on
 * DocumentExtraction.canonicalSchemaVersion to decide whether null is an
 * expected legacy shape or an integrity violation — it must never be silently
 * treated as v1 data.
 */
export function tryParseCanonicalBlockMetadata(value: unknown): CanonicalBlockMetadata | null {
  const result = canonicalBlockMetadataSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Durable quality state for an extraction. Historical rows keep NULL.
 *
 * - NULL: legacy extraction, predating the canonical quality contract.
 * - UNKNOWN: canonical-book-v1 extraction whose contract is valid but which
 *   has not been assessed by a production quality gate yet. Parser success is
 *   NEVER equated with acceptance — current parsers must self-assign UNKNOWN
 *   and nothing stronger.
 * - ACCEPTED / DEGRADED / REQUIRES_FALLBACK / REJECTED: reserved for a future
 *   production quality gate; the parser path must not emit them.
 */
export const EXTRACTION_QUALITY_STATUSES = [
  "UNKNOWN",
  "ACCEPTED",
  "DEGRADED",
  "REQUIRES_FALLBACK",
  "REJECTED",
] as const;

export type ExtractionQualityStatus = (typeof EXTRACTION_QUALITY_STATUSES)[number];

/**
 * Stable warning-code contract. Codes are an enumerated vocabulary, not free
 * text, so downstream consumers can react to them without parsing strings.
 * Current production parsers record no warnings (warnings: []) and must never
 * fabricate one without evidence.
 */
export const EXTRACTION_QUALITY_WARNING_CODES = [
  "TABLE_FLATTENED",
  "STRUCTURE_DEGRADED",
  "OCR_USED",
  "PARTIAL_EXTRACTION",
  "HEADER_FOOTER_CONTAMINATION",
  // EPUB native ingestion (additive): navigation was declared but structurally
  // unusable for non-security reasons, and a pre-paginated (fixed-layout)
  // rendition was detected. Both are evidence-backed parser observations only;
  // they never move qualityStatus off UNKNOWN.
  "EPUB_NAVIGATION_DEGRADED",
  "EPUB_FIXED_LAYOUT",
] as const;

export type ExtractionQualityWarningCode = (typeof EXTRACTION_QUALITY_WARNING_CODES)[number];

export const extractionQualityMetadataSchema = z.strictObject({
  warnings: z.array(z.enum(EXTRACTION_QUALITY_WARNING_CODES)),
});

export type ExtractionQualityMetadata = z.infer<typeof extractionQualityMetadataSchema>;

export function parseExtractionQualityMetadata(value: unknown): ExtractionQualityMetadata {
  return extractionQualityMetadataSchema.parse(value);
}
