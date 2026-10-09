import { describe, expect, it } from "vitest";
import { classifyParserFailure } from "../src/failure-kind.js";
import { deriveRunStatus, isSuccessfulReliability } from "../src/outcome-gate.js";
import { parseRunNormalizedArtifact } from "../src/report.js";
import type { BenchmarkResult } from "../src/schema.js";

function reliable(): BenchmarkResult["reliability"] {
  return {
    exitCode: 0,
    timeout: false,
    crashed: false,
    failureKind: null,
    oom: false,
    partialOutput: false,
    warnings: [],
  };
}

function status(overrides: Partial<Parameters<typeof deriveRunStatus>[0]> = {}) {
  return deriveRunStatus({
    reliability: reliable(),
    hasNormalizedOutput: true,
    resultPersisted: true,
    tempClean: true,
    ...overrides,
  });
}

describe("PDF benchmark authoritative run status", () => {
  it("accepts only a fully persisted, cleaned, normalized successful execution", () => {
    expect(status()).toBe("OK");
    expect(isSuccessfulReliability(reliable())).toBe(true);
  });

  it.each(["PROCESS_FAILURE", "TIMEOUT", "OUT_OF_MEMORY", "INVALID_OUTPUT", "HARNESS_ERROR", "EXPECTED_CAPABILITY_REJECTION"] as const)(
    "cannot report OK for failureKind=%s even with exit zero and normalized output",
    (failureKind) => expect(status({ reliability: { ...reliable(), failureKind } })).toBe("PARSER_FAILED"),
  );

  it("rejects exit failures, timeouts, OOM, incomplete output and crashes", () => {
    const bad: Array<Partial<BenchmarkResult["reliability"]>> = [
      { exitCode: 1 }, { exitCode: null }, { timeout: true }, { oom: true },
      { partialOutput: true }, { crashed: true },
    ];
    for (const reliability of bad) {
      expect(status({ reliability: { ...reliable(), ...reliability } })).toBe("PARSER_FAILED");
    }
  });

  it("does not accept missing normalized evidence, incomplete persistence or uncleared temp files", () => {
    expect(status({ hasNormalizedOutput: false })).toBe("PARSER_FAILED");
    expect(status({ resultPersisted: false })).toBe("PARSER_FAILED");
    expect(status({ tempClean: false })).toBe("PARSER_FAILED");
  });

  it("persists failure authority for unsuccessful cleanup and result writes", () => {
    for (const prefix of ["TEMP_CLEANUP_FAILED:", "RESULT_PERSIST_FAILED:"]) {
      const reliability = { ...reliable(), warnings: [prefix + " synthetic"] };
      expect(status({ reliability })).toBe("PARSER_FAILED");
    }
  });

  it("separates a bad process exit from a valid-looking normalized candidate", () => {
    const failureKind = classifyParserFailure({
      parserId: "mineru", mode: "flash", exitCode: 9, timedOut: false,
      stderr: "", warnings: [], hasNormalizedOutput: true,
    });
    expect(failureKind).toBe("PROCESS_FAILURE");
    expect(status({ reliability: { ...reliable(), exitCode: 9, failureKind, partialOutput: true } })).toBe("PARSER_FAILED");
  });

  it("never trusts resource limit termination even when an adapter reports exit zero", () => {
    const failureKind = classifyParserFailure({
      parserId: "mineru", mode: "flash", exitCode: 0, timedOut: false,
      stderr: "", warnings: [], hasNormalizedOutput: true, outputLimitExceeded: true,
    });
    expect(failureKind).toBe("PROCESS_FAILURE");
    expect(status({ reliability: { ...reliable(), failureKind, partialOutput: true } })).toBe("PARSER_FAILED");
  });

  it("retains expected OCR capability refusals as failures, not successful extraction", () => {
    const failureKind = classifyParserFailure({
      parserId: "pdfjs", mode: "default", exitCode: 3, timedOut: false,
      stderr: "", warnings: ["PARSER_ERROR: SOURCE_OCR_REQUIRED"], hasNormalizedOutput: false,
    });
    expect(failureKind).toBe("EXPECTED_CAPABILITY_REJECTION");
    expect(status({ reliability: { ...reliable(), exitCode: 3, failureKind }, hasNormalizedOutput: false })).toBe("PARSER_FAILED");
  });

  it("rejects invalid or cross-fixture normalized artifacts in the aggregate report", () => {
    const valid = {
      parser: { name: "synthetic", version: "1.0" },
      fixtureId: "same-fixture",
      pages: [],
      readingOrderAvailable: false,
    };
    expect(parseRunNormalizedArtifact(valid, "same-fixture")).not.toBeNull();
    expect(parseRunNormalizedArtifact(valid, "other-fixture")).toBeNull();
    expect(parseRunNormalizedArtifact({}, "same-fixture")).toBeNull();
    expect(parseRunNormalizedArtifact({ ...valid, pages: "not-an-array" }, "same-fixture")).toBeNull();
    expect(parseRunNormalizedArtifact({ ...valid, pages: [{ pageIndex: -1, blocks: [] }] }, "same-fixture")).toBeNull();
  });

  it("allows quality-sidecar warnings to remain additive, not parser failures", () => {
    const r = { ...reliable(), warnings: ["QUALITY_EVALUATION_FAILED: synthetic"] };
    expect(isSuccessfulReliability(r)).toBe(true);
  });
});
