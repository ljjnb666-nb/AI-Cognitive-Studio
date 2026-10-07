import {
  parseEpubExtractionMetadata,
  parseExtractionQualityMetadata,
  type ExtractionQualityWarningCode,
} from "@ai-cognitive/domain";
import type { Parsed } from "./document-parsers.js";
import { SourceError } from "./source-errors.js";

export const EPUB_QUALITY_REASON_CODES = [
  "NO_USABLE_CONTENT",
  "PRIMARY_CONTENT_MISSING",
  "STRUCTURE_LOSS",
  "NAVIGATION_DEGRADED",
  "FIXED_LAYOUT",
] as const;

export type EpubQualityReasonCode = (typeof EPUB_QUALITY_REASON_CODES)[number];
export type EpubExtractionQualityStatus = "ACCEPTED" | "DEGRADED" | "REJECTED";

export type EpubExtractionQualityDecision = {
  status: EpubExtractionQualityStatus;
  reasonCodes: EpubQualityReasonCode[];
  qualityWarnings: ExtractionQualityWarningCode[];
};

const EPUB_ALLOWED_WARNINGS = new Set<ExtractionQualityWarningCode>([
  "TABLE_FLATTENED",
  "STRUCTURE_DEGRADED",
  "PARTIAL_EXTRACTION",
  "EPUB_NAVIGATION_DEGRADED",
  "EPUB_FIXED_LAYOUT",
]);

function uniqueWarnings(parsed: Parsed): ExtractionQualityWarningCode[] {
  const warnings = parseExtractionQualityMetadata({ warnings: parsed.qualityWarnings ?? [] }).warnings;
  if (new Set(warnings).size !== warnings.length) throw new Error(SourceError.QUALITY_GATE_BLOCKED);
  if (warnings.some((warning) => !EPUB_ALLOWED_WARNINGS.has(warning))) throw new Error(SourceError.QUALITY_GATE_BLOCKED);
  return warnings;
}

/**
 * BOOK-INGESTION-04C-3 EPUB publication authority.
 *
 * Parser success is only evidence production. This gate independently converts
 * that evidence into the durable publication decision:
 *   - ACCEPTED: usable canonical evidence with no known quality loss.
 *   - DEGRADED: still publishable, but a deterministic structural/layout loss
 *     is known (flattened table, degraded navigation/structure, fixed layout).
 *   - REJECTED: no usable content or a primary reading-order resource produced
 *     no canonical evidence (PARTIAL_EXTRACTION).
 *
 * Warning vocabularies that cannot be produced by the EPUB parser are contract
 * drift, not degradation, and fail closed through QUALITY_GATE_BLOCKED.
 */
export function evaluateEpubExtractionQuality(parsed: Parsed): EpubExtractionQualityDecision {
  if (parsed.parser.name !== "builtin-epub" || parsed.parser.version !== "epub-parser-v2") {
    throw new Error(SourceError.QUALITY_GATE_BLOCKED);
  }

  const metadata = parseEpubExtractionMetadata(parsed.formatMetadata);
  const warnings = uniqueWarnings(parsed);
  const blockCount = parsed.pages.reduce((count, page) => count + page.blocks.length, 0);

  // Fixed-layout quality evidence has two independent witnesses: package
  // metadata and the parser warning. A disagreement means the quality gate is
  // observing a broken parser contract and must not publish.
  const fixedByMetadata = metadata.renditionLayout === "PRE_PAGINATED";
  const fixedByWarning = warnings.includes("EPUB_FIXED_LAYOUT");
  if (fixedByMetadata !== fixedByWarning) throw new Error(SourceError.QUALITY_GATE_BLOCKED);

  const reasonCodes: EpubQualityReasonCode[] = [];
  if (blockCount < 1) reasonCodes.push("NO_USABLE_CONTENT");
  if (warnings.includes("PARTIAL_EXTRACTION")) reasonCodes.push("PRIMARY_CONTENT_MISSING");
  if (warnings.includes("TABLE_FLATTENED") || warnings.includes("STRUCTURE_DEGRADED")) reasonCodes.push("STRUCTURE_LOSS");
  if (warnings.includes("EPUB_NAVIGATION_DEGRADED")) reasonCodes.push("NAVIGATION_DEGRADED");
  if (fixedByMetadata) reasonCodes.push("FIXED_LAYOUT");

  if (reasonCodes.includes("NO_USABLE_CONTENT") || reasonCodes.includes("PRIMARY_CONTENT_MISSING")) {
    return { status: "REJECTED", reasonCodes, qualityWarnings: warnings };
  }
  if (reasonCodes.length > 0) return { status: "DEGRADED", reasonCodes, qualityWarnings: warnings };
  return { status: "ACCEPTED", reasonCodes: [], qualityWarnings: warnings };
}
