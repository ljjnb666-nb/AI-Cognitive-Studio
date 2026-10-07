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
  // Extraction quality gate: PDF (04B-2) / EPUB (04C-3) rejected the
  // canonical result before publication. Deterministic content-truth REJECTED.
  QUALITY_REJECTED: "SOURCE_QUALITY_REJECTED",
  // Publication hard gate: a quality-authoritative PDF/EPUB reached
  // persistence without ACCEPTED/DEGRADED. Unreachable by construction; a
  // violation is an internal pipeline contract bug.
  QUALITY_GATE_BLOCKED: "SOURCE_QUALITY_GATE_BLOCKED",
  // Routing replay fence (04B-2): a persisted immutable routing plan conflicts
  // with runtime-derived inspection, or is structurally invalid. Internal
  // contract break — fail closed, never patch persisted history.
  ROUTING_PLAN_CONFLICT: "SOURCE_ROUTING_PLAN_CONFLICT",
  ROUTING_PLAN_CONTRACT_INVALID: "SOURCE_ROUTING_PLAN_CONTRACT_INVALID",
  // RF01 P1-04: an executor reported SUCCEEDED but its output canonicalizes to
  // zero usable blocks (empty / whitespace-only / BOM-only). The page attempt
  // records this stable failure and the durable attempt budget governs retry;
  // it is never accepted as usable fallback content. PAGE-level code — the run
  // itself ends through the ordinary REQUIRES_FALLBACK / OCR_REQUIRED path.
  OCR_NO_USABLE_TEXT: "SOURCE_OCR_NO_USABLE_TEXT",
  // ---------------------------------------------------------------------------
  // Real OCR executor failure classes (BOOK-INGESTION-04B-3). Stable, typed,
  // PAGE-level durable codes: they are recorded on OcrPageAttempt.errorCode and
  // never become run-level error codes (the run ends through the ordinary
  // OCR_REQUIRED/REQUIRES_FALLBACK authority of 04B-2).
  // ---------------------------------------------------------------------------
  // The OCR provider was requested but the executor could not be constructed:
  // malformed explicit configuration. Startup fails fast instead; this exists
  // so a constructed executor can never run without its full contract.
  OCR_MINERU_NOT_CONFIGURED: "SOURCE_OCR_MINERU_NOT_CONFIGURED",
  // The configured MinerU executable does not exist / could not be spawned.
  OCR_MINERU_NOT_FOUND: "SOURCE_OCR_MINERU_NOT_FOUND",
  // MINERU_MODEL_SOURCE=local and the local model repo is not ready. MinerU's
  // own deterministic evidence ("Model repo ... is not ready"); zero downloads
  // by contract. Terminal: retrying cannot create the model.
  OCR_MODEL_NOT_FOUND: "SOURCE_OCR_MODEL_NOT_FOUND",
  // A bounded MinerU process (parse / server start / server stop) exceeded its
  // hard timeout and was terminated by recorded identity.
  OCR_TIMEOUT: "SOURCE_OCR_TIMEOUT",
  // MinerU exited nonzero / unpredictably without more specific evidence.
  OCR_PROCESS_FAILED: "SOURCE_OCR_PROCESS_FAILED",
  // MinerU's output violated the output contract (not written, malformed
  // envelope, exceeds the bounded output cap, outside the requested location).
  OCR_OUTPUT_INVALID: "SOURCE_OCR_OUTPUT_INVALID",
  // The executor's application-generated per-claim temp IO failed (input
  // write, output read, cleanup). Infrastructure-class, retryable.
  OCR_TEMP_IO_ERROR: "SOURCE_OCR_TEMP_IO_ERROR",
  // The configured host OCR capacity slot is owned by another live claim.
  // Transient with a bounded nextAttemptAt; never a busy-wait.
  OCR_HOST_CAPACITY: "SOURCE_OCR_HOST_CAPACITY",
  // The executor lost its OcrHostLease ownership mid-execution (renewal
  // failed): infrastructure authority is gone, so execution stops and the
  // result is a stable transient failure. Never releases a newer owner's lease.
  OCR_HOST_LEASE_LOST: "SOURCE_OCR_HOST_LEASE_LOST",
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
    case "QUALITY_REJECTED": return SourceError.QUALITY_REJECTED;
    case "QUALITY_GATE_BLOCKED": return SourceError.QUALITY_GATE_BLOCKED;
    case "ROUTING_PLAN_CONFLICT": return SourceError.ROUTING_PLAN_CONFLICT;
    case "ROUTING_PLAN_CONTRACT_INVALID": return SourceError.ROUTING_PLAN_CONTRACT_INVALID;
    case "OCR_NO_USABLE_TEXT": return SourceError.OCR_NO_USABLE_TEXT;
    default: return SourceError.PARSE;
  }
}
