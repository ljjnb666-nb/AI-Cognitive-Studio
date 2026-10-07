import type { ExtractionQualityWarningCode } from "@ai-cognitive/domain";

export const EPUB_QUALITY_REASON_CODES = ["NO_USABLE_CONTENT", "QUALITY_WARNING_PRESENT"] as const;
export type EpubQualityReasonCode = (typeof EPUB_QUALITY_REASON_CODES)[number];
export type EpubExtractionQualityStatus = "ACCEPTED" | "DEGRADED" | "REJECTED";

export type EpubExtractionQualityDecision = {
  status: EpubExtractionQualityStatus;
  reasonCodes: EpubQualityReasonCode[];
  qualityWarnings: ExtractionQualityWarningCode[];
};

/**
 * Deterministic EPUB publication-quality authority (BOOK-INGESTION-04C-3).
 * EPUB has no OCR/external fallback pipeline here, so it never invents a
 * REQUIRES_FALLBACK state.
 */
export function evaluateEpubExtractionQuality(
  usableBlockCount: number,
  warnings: readonly ExtractionQualityWarningCode[],
): EpubExtractionQualityDecision {
  if (!Number.isSafeInteger(usableBlockCount) || usableBlockCount < 0) throw new RangeError("EPUB_USABLE_BLOCK_COUNT_INVALID");
  const qualityWarnings = [...warnings];
  if (usableBlockCount === 0) return { status: "REJECTED", reasonCodes: ["NO_USABLE_CONTENT"], qualityWarnings };
  if (qualityWarnings.length > 0) return { status: "DEGRADED", reasonCodes: ["QUALITY_WARNING_PRESENT"], qualityWarnings };
  return { status: "ACCEPTED", reasonCodes: [], qualityWarnings };
}
