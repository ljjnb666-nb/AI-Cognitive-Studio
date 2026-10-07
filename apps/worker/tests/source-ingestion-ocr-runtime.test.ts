import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Environment } from "@ai-cognitive/shared/server";
import { resolveSourceIngestionOcrExecutor } from "../src/source-ingestion.js";

/**
 * Worker wiring gate for the real OCR runtime (BOOK-INGESTION-04B-3 + RF01
 * P1-08): the production composition resolves the MinerU executor ONLY from
 * explicit configuration, VERIFIES the configured runtime reports the pinned
 * 4.0.3 via argv execution before any OCR work is accepted, fails fast on
 * malformed configuration, and keeps the 04B-2 no-OCR behavior when nothing is
 * configured. The injectable MinerU CLI double provides the pinned/different
 * version responses without weakening production.
 */

const fakeMineruPath = fileURLToPath(new URL("../../../packages/ingestion/tests/helpers/mineru/fake-mineru.mjs", import.meta.url));

function configuredEnvironment(): Environment {
  return {
    REDIS_URL: "redis://localhost:6379",
    OCR_PROVIDER: "mineru",
    MINERU_MODEL_SOURCE: "local",
    MINERU_MODEL_PATH: process.cwd(),
    MINERU_EXECUTABLE: process.execPath,
    MINERU_EXECUTABLE_ARGS: JSON.stringify([fakeMineruPath]),
  } as unknown as Environment;
}

describe("source ingestion OCR runtime resolution", () => {
  it("returns undefined with no configuration (no-OCR behavior preserved)", async () => {
    expect(await resolveSourceIngestionOcrExecutor({ REDIS_URL: "redis://localhost:6379" } as Environment)).toBeUndefined();
  });

  it("resolves a live executor runtime whose provenance is the verified pinned version", async () => {
    const runtime = (await resolveSourceIngestionOcrExecutor(configuredEnvironment()))!;
    expect(runtime.pdfOcrExecutor.descriptor).toMatchObject({ name: "mineru", version: "4.0.3", parserMode: "flash", modelRevision: null });
    expect(runtime.config.version).toBe("4.0.3");
    expect(typeof runtime.close).toBe("function");
    void runtime.close();
  });

  it("fails fast when the configured runtime does not report the pinned MinerU 4.0.3", async () => {
    process.env.MINERU_FAKE_VERSION = "9.9.9";
    try {
      await expect(resolveSourceIngestionOcrExecutor(configuredEnvironment())).rejects.toThrow(/^OCR_VERSION_MISMATCH:9\.9\.9/);
    } finally {
      delete process.env.MINERU_FAKE_VERSION;
    }
  });

  it("fails fast on malformed explicit configuration", async () => {
    await expect(resolveSourceIngestionOcrExecutor({ REDIS_URL: "redis://localhost:6379", MINERU_MODEL_PATH: "D:\\x" } as unknown as Environment)).rejects.toThrow(/^OCR_PROVIDER_REQUIRED/);
    await expect(resolveSourceIngestionOcrExecutor({ ...configuredEnvironment(), MINERU_MODEL_SOURCE: undefined, MINERU_TIER: undefined } as unknown as Environment)).rejects.toThrow(/OCR_MODEL_SOURCE_INVALID/);
  });
});
