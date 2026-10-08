/** Distinguish an expected OCR handoff from an unplanned parser/process failure.
 * An expected refusal is NEVER a successful extraction or a green parser run.
 */
export type ParserFailureKind =
  | "EXPECTED_CAPABILITY_REJECTION"
  | "TIMEOUT"
  | "OUT_OF_MEMORY"
  | "PROCESS_FAILURE"
  | "INVALID_OUTPUT"
  | "HARNESS_ERROR"
  | null;

export function classifyParserFailure(input: {
  parserId: string;
  mode: string;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  warnings: readonly string[];
  hasNormalizedOutput: boolean;
}): ParserFailureKind {
  if (input.timedOut) return "TIMEOUT";
  if (/\b(?:out of memory|oom|heap|killed)\b/i.test(input.stderr)) return "OUT_OF_MEMORY";
  if (
    input.parserId === "pdfjs" &&
    input.mode === "default" &&
    input.exitCode === 3 &&
    !input.hasNormalizedOutput &&
    input.warnings.some((warning) => warning.trim() === "PARSER_ERROR: SOURCE_OCR_REQUIRED")
  ) return "EXPECTED_CAPABILITY_REJECTION";
  if (input.exitCode !== 0) return "PROCESS_FAILURE";
  if (!input.hasNormalizedOutput) return "INVALID_OUTPUT";
  return null;
}
