export const SourceError = {
  TOO_LARGE: "SOURCE_TOO_LARGE",
  UNSUPPORTED_TYPE: "SOURCE_UNSUPPORTED_TYPE",
  TYPE_MISMATCH: "SOURCE_TYPE_MISMATCH",
  CORRUPTED: "SOURCE_CORRUPTED",
  PASSWORD_REQUIRED: "SOURCE_PASSWORD_REQUIRED",
  OCR_REQUIRED: "SOURCE_OCR_REQUIRED",
  ARCHIVE_UNSAFE: "SOURCE_ARCHIVE_UNSAFE",
  UPLOAD_EXPIRED: "SOURCE_UPLOAD_EXPIRED",
  OBJECT_MISSING: "SOURCE_OBJECT_MISSING",
  PARSE_TIMEOUT: "SOURCE_PARSE_TIMEOUT",
  STORAGE: "SOURCE_STORAGE_ERROR",
  PARSE: "SOURCE_PARSE_ERROR",
  CANONICAL_BLOCK_CONTRACT_INVALID: "SOURCE_CANONICAL_BLOCK_CONTRACT_INVALID",
  // A pre-paginated (fixed-layout) EPUB with no usable textual evidence: an
  // explicit, stable failure instead of SUCCEEDED + empty extraction.
  EPUB_FIXED_LAYOUT_UNSUPPORTED: "SOURCE_EPUB_FIXED_LAYOUT_UNSUPPORTED",
  // A reflowable EPUB whose spine yields no usable textual evidence at all
  // (e.g. image-only pages): a deterministic unsupported-content state, not an
  // OCR fallback case.
  EPUB_NO_USABLE_TEXT: "SOURCE_EPUB_NO_USABLE_TEXT",
  // Internal parser contract violation: the parser produced (or failed to
  // produce) format metadata in violation of the persistence contract. Never
  // surfaced as Zod details; classified FAILED, not REJECTED.
  FORMAT_METADATA_CONTRACT_INVALID: "SOURCE_FORMAT_METADATA_CONTRACT_INVALID",
} as const;

export type SourceErrorCode = (typeof SourceError)[keyof typeof SourceError];

/** Turns parser-specific failures into the small, stable ingestion error surface. */
export function sourceErrorForParserResult(result: string): SourceErrorCode {
  switch (result) {
    case "TOO_LARGE": return SourceError.TOO_LARGE;
    case "PASSWORD_REQUIRED": return SourceError.PASSWORD_REQUIRED;
    case "OCR_REQUIRED": return SourceError.OCR_REQUIRED;
    case "CORRUPTED": return SourceError.CORRUPTED;
    case "PARSE_TIMEOUT": return SourceError.PARSE_TIMEOUT;
    case "ARCHIVE_UNSAFE": return SourceError.ARCHIVE_UNSAFE;
    case "EPUB_FIXED_LAYOUT_UNSUPPORTED": return SourceError.EPUB_FIXED_LAYOUT_UNSUPPORTED;
    case "EPUB_NO_USABLE_TEXT": return SourceError.EPUB_NO_USABLE_TEXT;
    case "FORMAT_METADATA_CONTRACT_INVALID": return SourceError.FORMAT_METADATA_CONTRACT_INVALID;
    default: return SourceError.PARSE;
  }
}
