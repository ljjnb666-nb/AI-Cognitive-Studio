import { describe, expect, it } from "vitest";
import { SourceError } from "../src/source-errors.js";
import { classifyIngestionFailure, ingestionStatusForTerminalFailure } from "../src/ingestion-failure.js";
import { INGESTION_EXECUTION_OWNERSHIP_LOST } from "../src/ingestion-run-claim.js";
import { environmentSchema } from "@ai-cognitive/shared/server";

describe("ingestion execution failure classifier", () => {
  it("classifies ownership loss as OWNERSHIP_LOST_NO_WRITE", () => {
    expect(classifyIngestionFailure(INGESTION_EXECUTION_OWNERSHIP_LOST)).toBe("OWNERSHIP_LOST_NO_WRITE");
  });

  it("keeps existing deterministic content/parser failures TERMINAL_RUN", () => {
    expect(classifyIngestionFailure(SourceError.OCR_REQUIRED)).toBe("TERMINAL_RUN");
    expect(classifyIngestionFailure(SourceError.PASSWORD_REQUIRED)).toBe("TERMINAL_RUN");
    expect(classifyIngestionFailure(SourceError.CORRUPTED)).toBe("TERMINAL_RUN");
    expect(classifyIngestionFailure(SourceError.TOO_LARGE)).toBe("TERMINAL_RUN");
    expect(classifyIngestionFailure(SourceError.EPUB_NO_USABLE_TEXT)).toBe("TERMINAL_RUN");
    expect(classifyIngestionFailure(SourceError.PARSE_TIMEOUT)).toBe("TERMINAL_RUN");
    expect(classifyIngestionFailure(SourceError.CANONICAL_BLOCK_CONTRACT_INVALID)).toBe("TERMINAL_RUN");
  });

  it("defaults unknown infrastructure errors to bounded RETRYABLE_RUN", () => {
    expect(classifyIngestionFailure("ECONNRESET")).toBe("RETRYABLE_RUN");
    expect(classifyIngestionFailure("OBJECT_NOT_FOUND:whatever")).toBe("RETRYABLE_RUN");
    expect(classifyIngestionFailure("UNEXPECTED_ERROR")).toBe("RETRYABLE_RUN");
  });

  it("preserves the pre-existing terminal status mapping", () => {
    expect(ingestionStatusForTerminalFailure(SourceError.OCR_REQUIRED)).toBe("OCR_REQUIRED");
    expect(ingestionStatusForTerminalFailure(SourceError.PASSWORD_REQUIRED)).toBe("PASSWORD_REQUIRED");
    expect(ingestionStatusForTerminalFailure(SourceError.CORRUPTED)).toBe("REJECTED");
    expect(ingestionStatusForTerminalFailure(SourceError.UNSUPPORTED_TYPE)).toBe("REJECTED");
    expect(ingestionStatusForTerminalFailure(SourceError.PARSE)).toBe("FAILED");
    expect(ingestionStatusForTerminalFailure("ECONNRESET")).toBe("FAILED");
  });
});

describe("SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS env SSOT", () => {
  it("defaults to 3 within the 1..10 range and is distinct from the outbox attempts authority", () => {
    const base = { DATABASE_URL: "postgresql://test:test@localhost:5432/test", REDIS_URL: "redis://localhost:6379" };
    const parsed = environmentSchema.parse(base);
    expect(parsed.SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS).toBe(3);
    expect(parsed.SOURCE_OUTBOX_MAX_ATTEMPTS).toBe(5);
    expect(() => environmentSchema.parse({ ...base, SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS: "0" })).toThrow();
    expect(() => environmentSchema.parse({ ...base, SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS: "11" })).toThrow();
    expect(environmentSchema.parse({ ...base, SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS: "7" }).SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS).toBe(7);
  });
});
