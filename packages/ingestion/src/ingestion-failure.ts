import { SourceError } from "./source-errors.js";
import { INGESTION_EXECUTION_OWNERSHIP_LOST, type IngestionTerminalStatus } from "./ingestion-run-claim.js";

/**
 * Central ingestion execution-failure classifier (BOOK-INGESTION-04B-1).
 *
 * Every durable failure path must classify through here — no generic catch may
 * unconditionally downgrade a run. Unknown infrastructure-style errors are
 * retryable by default, bounded by the durable attempt guard (never more than
 * SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS executions).
 */
export type IngestionFailureClass = "OWNERSHIP_LOST_NO_WRITE" | "RETRYABLE_RUN" | "TERMINAL_RUN";

const terminalCodes = new Set<string>([
  // content-truth terminals (existing deterministic mappings preserved)
  SourceError.OCR_REQUIRED,
  SourceError.PASSWORD_REQUIRED,
  SourceError.TYPE_MISMATCH,
  SourceError.UNSUPPORTED_TYPE,
  SourceError.TOO_LARGE,
  SourceError.ARCHIVE_UNSAFE,
  SourceError.CORRUPTED,
  SourceError.EPUB_FIXED_LAYOUT_UNSUPPORTED,
  SourceError.EPUB_NO_USABLE_TEXT,
  // deterministic parse/contract failures (FAILED, not retryable)
  SourceError.PARSE,
  SourceError.PARSE_TIMEOUT,
  SourceError.CANONICAL_BLOCK_CONTRACT_INVALID,
  SourceError.FORMAT_METADATA_CONTRACT_INVALID,
]);

export function classifyIngestionFailure(code: string): IngestionFailureClass {
  if (code === INGESTION_EXECUTION_OWNERSHIP_LOST) return "OWNERSHIP_LOST_NO_WRITE";
  if (terminalCodes.has(code)) return "TERMINAL_RUN";
  return "RETRYABLE_RUN";
}

/** Preserves the pre-04B-1 status mapping for deterministic failures. */
export function ingestionStatusForTerminalFailure(code: string): IngestionTerminalStatus {
  if (code === SourceError.OCR_REQUIRED) return "OCR_REQUIRED";
  if (code === SourceError.PASSWORD_REQUIRED) return "PASSWORD_REQUIRED";
  if ([SourceError.TYPE_MISMATCH, SourceError.UNSUPPORTED_TYPE, SourceError.TOO_LARGE, SourceError.ARCHIVE_UNSAFE, SourceError.CORRUPTED, SourceError.EPUB_FIXED_LAYOUT_UNSUPPORTED, SourceError.EPUB_NO_USABLE_TEXT].includes(code as never)) return "REJECTED";
  return "FAILED";
}
