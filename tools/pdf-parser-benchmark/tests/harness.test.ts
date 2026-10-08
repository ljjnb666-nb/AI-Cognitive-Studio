import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture, runParser } from "../src/harness.js";

/**
 * Harness-level integration tests. These use the REAL production pdfjs parser
 * (via the junction set up by scripts/setup.mjs) and the REAL liteparse child.
 * Fixtures are tiny synthetic PDFs generated into the data-root fixtures dir
 * by a beforeAll step; they are gitignored data, never committed.
 *
 * These tests assert failure isolation, invalid-input handling and temp
 * cleanup — not parser quality.
 */

const scratchRoot = join(tmpdir(), "bench-harness-tests");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  await rm(scratchRoot, { recursive: true, force: true });
});

async function writeTinyPdf(filename: string, pages = 2): Promise<void> {
  const { FIXTURES_ROOT } = await import("../src/filesystem-guard.js");
  await mkdir(FIXTURES_ROOT, { recursive: true });
  const path = join(FIXTURES_ROOT, filename);
  const doc = new PDFDocument({ size: "A4", margin: 64 });
  const stream = createWriteStream(path);
  doc.pipe(stream);
  for (let page = 0; page < pages; page++) {
    doc.fontSize(12).text(`Harness integration test page ${page + 1}. Synthetic content only.`);
    if (page < pages - 1) doc.addPage();
  }
  await new Promise<void>((resolve) => {
    stream.on("finish", () => resolve());
    doc.end();
  });
}

async function registerManifest(entries: Array<{ id: string; filename: string; declaredPages: number; fixtureClass: string }>): Promise<void> {
  const { FIXTURES_ROOT } = await import("../src/filesystem-guard.js");
  await mkdir(FIXTURES_ROOT, { recursive: true });
  const manifest = {
    fixtures: entries.map((entry) => ({
      ...entry,
      generator: "tests (synthetic)",
      notes: "harness integration test fixture",
    })),
  };
  await writeFile(join(FIXTURES_ROOT, "fixtures.manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

describe("harness integration (real parsers, synthetic fixtures)", () => {
  it("runs pdfjs baseline end-to-end and cleans temp", async () => {
    await writeTinyPdf("harness-tiny.pdf", 2);
    await registerManifest([{ id: "harness-tiny", filename: "harness-tiny.pdf", declaredPages: 2, fixtureClass: "native-en" }]);
    const outcome = await runParser("pdfjs", "default", "harness-tiny", { cold: true, skipPreflight: true });
    expect(outcome.status).toBe("OK");
    expect(outcome.tempClean).toBe(true);
    expect(outcome.result?.extraction.extractedPages).toBe(2);
    expect(outcome.result?.extraction.blocks).toBeGreaterThan(0);
    expect(outcome.result?.parser.name).toBe("pdfjs-isolated");
    expect(outcome.normalized?.pages[0]?.blocks.every((block) => block.kind === "paragraph")).toBe(true);
  }, 120_000);

  it("records a structured failure for invalid PDFs without crashing (failure isolation)", async () => {
    const { FIXTURES_ROOT } = await import("../src/filesystem-guard.js");
    await mkdir(FIXTURES_ROOT, { recursive: true });
    await writeFile(join(FIXTURES_ROOT, "harness-invalid.pdf"), "definitely not a pdf".repeat(50), "utf8");
    await registerManifest([{ id: "harness-invalid", filename: "harness-invalid.pdf", declaredPages: 0, fixtureClass: "malformed" }]);

    const invalidPdfjs = await runParser("pdfjs", "default", "harness-invalid", { cold: true, skipPreflight: true });
    expect(["PARSER_FAILED", "OK"]).toContain(invalidPdfjs.status);
    expect(invalidPdfjs.result?.reliability.crashed || invalidPdfjs.result?.reliability.warnings.length).toBeTruthy();
    expect(invalidPdfjs.tempClean).toBe(true);

    const invalidLiteparse = await runParser("liteparse", "default", "harness-invalid", { cold: true, skipPreflight: true });
    expect(["PARSER_FAILED", "OK"]).toContain(invalidLiteparse.status);
    expect(invalidLiteparse.tempClean).toBe(true);
  }, 120_000);

  it("runs liteparse end-to-end on a native pdf", async () => {
    await writeTinyPdf("harness-liteparse.pdf", 1);
    await registerManifest([{ id: "harness-liteparse", filename: "harness-liteparse.pdf", declaredPages: 1, fixtureClass: "native-en" }]);
    const outcome = await runParser("liteparse", "default", "harness-liteparse", { cold: true, skipPreflight: true });
    expect(outcome.status).toBe("OK");
    expect(outcome.tempClean).toBe(true);
    expect(outcome.result?.parser.name).toBe("liteparse");
  }, 120_000);

  it("fails closed on swapped private fixture bytes before parser execution", async () => {
    await writeTinyPdf("harness-private.pdf", 1);
    await registerManifest([{ id: "harness-private", filename: "harness-private.pdf", declaredPages: 1, fixtureClass: "private-real-book" }]);
    const { FIXTURES_ROOT } = await import("../src/filesystem-guard.js");
    const manifestPath = join(FIXTURES_ROOT, "fixtures.manifest.json");
    const manifest = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(manifestPath, "utf8")));
    manifest.fixtures[0].expectedSha256 = "0".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await expect(loadFixture("harness-private")).rejects.toThrow(/FIXTURE_SHA256_MISMATCH/);
    await expect(runParser("pdfjs", "default", "harness-private", { cold: true, skipPreflight: true })).rejects.toThrow(/FIXTURE_SHA256_MISMATCH/);

    manifest.fixtures[0].expectedSha256 = undefined;
    manifest.fixtures[0].declaredBytes = 1;
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await expect(loadFixture("harness-private")).rejects.toThrow(/FIXTURE_DECLARED_BYTES_MISMATCH/);
  });

  it("rejects fixtures outside the manifest allowlist", async () => {
    await expect(runParser("pdfjs", "default", "no-such-fixture", { cold: true, skipPreflight: true })).rejects.toThrow(/FIXTURE_NOT_IN_MANIFEST|FIXTURE_FILE_MISSING/);
  });
});
