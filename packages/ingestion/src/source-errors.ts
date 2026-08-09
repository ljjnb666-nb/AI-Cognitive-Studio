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
    default: return SourceError.PARSE;
  }
}
