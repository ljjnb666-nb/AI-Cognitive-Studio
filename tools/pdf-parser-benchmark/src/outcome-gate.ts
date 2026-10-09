import type { BenchmarkResult } from "./schema.js";
import type { RunOutcome } from "./harness.js";

/** One persisted parser result is successful only with clean process/evidence facts. */
export function isSuccessfulReliability(reliability: BenchmarkResult["reliability"]): boolean {
  return reliability.failureKind == null &&
    reliability.exitCode === 0 &&
    !reliability.crashed &&
    !reliability.timeout &&
    !reliability.partialOutput &&
    !reliability.oom &&
    !reliability.warnings.some((warning) =>
      warning.startsWith("RESULT_PERSIST_FAILED:") ||
      warning.startsWith("TEMP_CLEANUP_FAILED:"),
    );
}

/** One authority for the in-memory run status after persistence and cleanup. */
export function deriveRunStatus(input: {
  reliability: BenchmarkResult["reliability"];
  hasNormalizedOutput: boolean;
  resultPersisted: boolean;
  tempClean: boolean;
}): "OK" | "PARSER_FAILED" {
  return input.hasNormalizedOutput && input.resultPersisted && input.tempClean &&
    isSuccessfulReliability(input.reliability)
    ? "OK"
    : "PARSER_FAILED";
}

/** An emitted result.json is evidence, never a successful-run signal by itself. */
export function isSuccessfulRun(outcome: RunOutcome): boolean {
  if (outcome.status !== "OK" || !outcome.result || !outcome.normalized) return false;
  return deriveRunStatus({
    reliability: outcome.result.reliability,
    hasNormalizedOutput: true,
    resultPersisted: true,
    tempClean: outcome.tempClean === true,
  }) === "OK";
}
