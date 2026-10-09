import { describe, expect, it } from "vitest";
import { classifyParserFailure } from "../src/failure-kind.js";

const baseline = {
  parserId: "pdfjs",
  mode: "default",
  exitCode: 3,
  timedOut: false,
  stderr: "",
  warnings: ["PARSER_ERROR: SOURCE_OCR_REQUIRED"],
  hasNormalizedOutput: false,
};

describe("real-book OCR capability rejection semantics", () => {
  it("classifies production OCR-required refusal without claiming parser success", () => {
    expect(classifyParserFailure(baseline)).toBe("EXPECTED_CAPABILITY_REJECTION");
  });

  it("never whitelists other parsers, wrong mode, wrong exit code or another error", () => {
    expect(classifyParserFailure({ ...baseline, parserId: "docling" })).toBe("PROCESS_FAILURE");
    expect(classifyParserFailure({ ...baseline, mode: "ocr" })).toBe("PROCESS_FAILURE");
    expect(classifyParserFailure({ ...baseline, exitCode: 1 })).toBe("PROCESS_FAILURE");
    expect(classifyParserFailure({ ...baseline, warnings: ["PARSER_ERROR: SOURCE_CORRUPTED"] })).toBe("PROCESS_FAILURE");
    expect(classifyParserFailure({ ...baseline, warnings: ["PARSER_ERROR: SOURCE_OCR_REQUIRED extra"] })).toBe("PROCESS_FAILURE");
  });

  it("prioritizes timeout and OOM over expected capability refusal", () => {
    expect(classifyParserFailure({ ...baseline, timedOut: true })).toBe("TIMEOUT");
    expect(classifyParserFailure({ ...baseline, stderr: "out of memory" })).toBe("OUT_OF_MEMORY");
  });

  it("enforces output resource-limit failure even with normalized output and exit zero", () => {
    expect(classifyParserFailure({ ...baseline, exitCode: 0, hasNormalizedOutput: true, outputLimitExceeded: true })).toBe("PROCESS_FAILURE");
  });

  it("separates invalid output, general process failure and successful execution", () => {
    expect(classifyParserFailure({ ...baseline, exitCode: 0 })).toBe("INVALID_OUTPUT");
    expect(classifyParserFailure({ ...baseline, exitCode: 0, hasNormalizedOutput: true })).toBe(null);
    expect(classifyParserFailure({ ...baseline, exitCode: 3, hasNormalizedOutput: true })).toBe("PROCESS_FAILURE");
  });
});
