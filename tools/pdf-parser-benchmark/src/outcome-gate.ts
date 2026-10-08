import type { RunOutcome } from "./harness.js";

/** An emitted result.json is evidence, never a successful-run signal by itself. */
export function isSuccessfulRun(outcome: RunOutcome): boolean {
  if (outcome.status !== "OK" || outcome.tempClean !== true || !outcome.result || !outcome.normalized) return false;
  const reliability = outcome.result.reliability;
  return reliability.exitCode === 0 &&
    !reliability.crashed && !reliability.timeout &&
    !reliability.partialOutput && !reliability.oom &&
    !reliability.warnings.some((warning) => warning.startsWith("RESULT_PERSIST_FAILED:"));
}
