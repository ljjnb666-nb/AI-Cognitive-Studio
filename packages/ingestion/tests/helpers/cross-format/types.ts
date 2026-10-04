/**
 * BOOK-INGESTION-03 cross-format consistency evaluator — TEST-ONLY types.
 *
 * This module is evaluation infrastructure for synthetic release fixtures.
 * It is never imported by production code, never persisted, and never
 * becomes part of canonical-book-v1. Evaluator codes are NOT SourceError
 * values and must never be added to production error contracts.
 */

export type ComparisonStatus = "PASS" | "FAIL" | "NOT_COMPARABLE";

/** Original block-local UTF-16 [start, end) offsets into one SourceBlock text. */
export type SourceFragment = {
  blockOrdinal: number;
  startOffset: number;
  endOffset: number;
};

export type ComparisonSegment = {
  /** Comparison-normalized text of one comparable source block. */
  normalizedText: string;
  /** Original block-local fragments that produced normalizedText, in order. */
  sourceFragments: SourceFragment[];
  /** SourceBlock kind the segment was built from. */
  blockKind: string;
};

export type ViewCapabilities = {
  headings: boolean;
  footnotes: boolean;
  tables: boolean;
  equations: boolean;
  images: boolean;
};

export type CrossFormatSemanticView = {
  normalizedStream: string;
  segments: ComparisonSegment[];
  capabilities: ViewCapabilities;
};

/**
 * Stable evaluator result codes. Diagnostic-only classification; the hard
 * content authority is always full normalized stream equality.
 */
export const CROSS_FORMAT_CODES = [
  "CROSS_FORMAT_CONTENT_MISSING",
  "CROSS_FORMAT_TAIL_TRUNCATED",
  "CROSS_FORMAT_CONTENT_DUPLICATED",
  "CROSS_FORMAT_ORDER_MISMATCH",
  "CROSS_FORMAT_EXTRA_CONTENT",
  "CROSS_FORMAT_PROVENANCE_INVALID",
  "CROSS_FORMAT_STRUCTURE_MISMATCH",
  "CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE",
  "CROSS_FORMAT_CONTENT_NOT_COMPARABLE",
  "CROSS_FORMAT_FIXTURE_INVALID",
] as const;

export type CrossFormatCode = (typeof CROSS_FORMAT_CODES)[number];

export type DimensionResult = {
  status: ComparisonStatus;
  code?: CrossFormatCode;
  detail?: string;
};

export type StreamDiagnostics = {
  code: CrossFormatCode;
  commonPrefixLength: number;
  commonSuffixLength: number;
  firstDivergence?: { pdfIndex: number; epubIndex: number };
  anchorsOnlyInPdf: string[];
  anchorsOnlyInEpub: string[];
  anchorSequenceEqual: boolean;
  longestCommonAnchorSubsequence: number;
};

export type CrossFormatGateResult = {
  content: DimensionResult;
  structure: DimensionResult;
  provenance: DimensionResult;
  features: {
    footnotes: DimensionResult;
    equations: DimensionResult;
    images: DimensionResult;
    tableGeometry: DimensionResult;
  };
  diagnostics?: StreamDiagnostics;
};

/** Fixture manifest entry: explicit pairing, no production identity inference. */
export type CrossFormatFixture = {
  id: string;
  pdfBytes: Uint8Array;
  epubBytes: Uint8Array;
  /** SIMPLE_TABLE only: TABLE blocks join the comparable lexical set. */
  includeTables?: boolean;
};
