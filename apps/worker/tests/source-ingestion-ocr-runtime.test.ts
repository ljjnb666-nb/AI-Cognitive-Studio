import { describe, expect, it } from "vitest";
import type { Environment } from "@ai-cognitive/shared/server";
import { resolveSourceIngestionOcrExecutor } from "../src/source-ingestion.js";

/**
 * Worker wiring gate for the real OCR runtime (BOOK-INGESTION-04B-3): the
 * production composition resolves the MinerU executor ONLY from explicit
 * configuration, fails fast on malformed configuration, and keeps the 04B-2
 * no-OCR behavior when nothing is configured.
 */

const configured = {
  REDIS_URL: "redis://localhost:6379",
  OCR_PROVIDER: "mineru",
  MINERU_MODEL_SOURCE: "local",
  MINERU_MODEL_PATH: process.cwd(),
  MINERU_EXECUTABLE: process.execPath,
} as unknown as Environment;

describe("source ingestion OCR runtime resolution", () => {
  it("returns undefined with no configuration (no-OCR behavior preserved)", () => {
    expect(resolveSourceIngestionOcrExecutor({ REDIS_URL: "redis://localhost:6379" } as Environment)).toBeUndefined();
  });

  it("resolves a live executor runtime when MinerU is configured", () => {
    const runtime = resolveSourceIngestionOcrExecutor(configured)!;
    expect(runtime.pdfOcrExecutor.descriptor).toMatchObject({ name: "mineru", version: "4.0.3", parserMode: "flash", modelRevision: null });
    expect(typeof runtime.close).toBe("function");
    void runtime.close();
  });

  it("fails fast on malformed explicit configuration", () => {
    expect(() => resolveSourceIngestionOcrExecutor({ REDIS_URL: "redis://localhost:6379", MINERU_MODEL_PATH: "D:\\x" } as unknown as Environment)).toThrow(/^OCR_PROVIDER_REQUIRED/);
    expect(() => resolveSourceIngestionOcrExecutor({ ...configured, MINERU_MODEL_SOURCE: undefined, MINERU_TIER: undefined } as unknown as Environment)).toThrow(/OCR_MODEL_SOURCE_INVALID/);
  });
});
