export { AppError } from "./errors/app-error.js";
export { buildSourceSpan, isUtf16Boundary, sha256Utf8, validateSourceSpan } from "./citation.js";
export {
  canonicalSourceLocatorSchema,
  epubSourceLocatorSchema,
  isSafeEpubResourcePath,
  parseSourceBlockBbox,
  parseSourceLocator,
  pdfSourceLocatorSchema,
  sourceBlockBboxSchema,
  tryParseSourceBlockBbox,
  tryParseSourceLocator,
  type CanonicalSourceLocator,
  type EpubSourceLocator,
  type PdfSourceLocator,
  type SourceBlockBbox,
} from "./source-locator.js";
export {
  blockExtractionProvenanceSchema,
  canonicalBlockMetadataSchema,
  CANONICAL_SCHEMA_VERSION,
  EXTRACTION_QUALITY_STATUSES,
  EXTRACTION_QUALITY_WARNING_CODES,
  EXTRACTION_SOURCE_METHODS,
  extractionQualityMetadataSchema,
  parseCanonicalBlockMetadata,
  parseExtractionQualityMetadata,
  tryParseCanonicalBlockMetadata,
  type BlockExtractionProvenance,
  type CanonicalBlockMetadata,
  type ExtractionQualityMetadata,
  type ExtractionQualityStatus,
  type ExtractionQualityWarningCode,
  type ExtractionSourceMethod,
} from "./block-provenance.js";
export {
  healthCheckPayloadSchema,
  healthCheckResultSchema,
  type HealthCheckPayload,
  type HealthCheckResult,
} from "./schemas/health-check.js";
