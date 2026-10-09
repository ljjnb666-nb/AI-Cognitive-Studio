import { describe, expect, it } from "vitest";
import { isSuccessfulRun } from "../src/outcome-gate.js";
import type { RunOutcome } from "../src/harness.js";

function acceptedRun(): RunOutcome {
  return {
    status: "OK",
    tempClean: true,
    preflight: null,
    outputDir: "private-run-dir",
    warnings: [],
    normalized: { pages: [] } as unknown as RunOutcome["normalized"],
    result: {
      reliability: {
        exitCode: 0,
        failureKind: null,
        crashed: false,
        timeout: false,
        oom: false,
        partialOutput: false,
        warnings: [],
      },
    } as unknown as RunOutcome["result"],
  };
}

describe("real-book benchmark CLI exit contract", () => {
  it("accepts an actual successful parser run with cleaned temp files", () => {
    expect(isSuccessfulRun(acceptedRun())).toBe(true);
  });

  it.each(["PARSER_FAILED", "SKIPPED_RESOURCE_CONSTRAINT", "STOPPED_C_DRIVE_PRESSURE"] as const)(
    "rejects %s even if a result.json exists", (status) => {
      const o = acceptedRun();
      o.status = status;
      expect(isSuccessfulRun(o)).toBe(false);
    },
  );

  it("rejects a successful parser if temp files were not cleaned", () => {
    const o = acceptedRun();
    o.tempClean = false;
    expect(isSuccessfulRun(o)).toBe(false);
  });

  it("rejects a non-null failureKind even with valid exit and normalized data", () => {
    const o = acceptedRun();
    o.result!.reliability.failureKind = "PROCESS_FAILURE";
    expect(isSuccessfulRun(o)).toBe(false);
  });

  it("rejects nonzero process exit even if normalized data exists", () => {
    const o = acceptedRun();
    o.result!.reliability.exitCode = 3;
    expect(isSuccessfulRun(o)).toBe(false);
  });

  it("rejects crash, timeout, partial output, out-of-memory, or missing persisted evidence", () => {
    for (const bad of ["crashed", "timeout", "partialOutput", "oom"] as const) {
      const o = acceptedRun();
      o.result!.reliability[bad] = true;
      expect(isSuccessfulRun(o)).toBe(false);
    }
    const o = acceptedRun();
    o.result!.reliability.warnings = ["RESULT_PERSIST_FAILED: disk write"];
    expect(isSuccessfulRun(o)).toBe(false);
  });

  it("rejects missing normalized output or result evidence", () => {
    const o = acceptedRun();
    o.normalized = null;
    expect(isSuccessfulRun(o)).toBe(false);
    o.normalized = { pages: [] } as unknown as RunOutcome["normalized"];
    o.result = null;
    expect(isSuccessfulRun(o)).toBe(false);
  });
});
