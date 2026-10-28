import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { withVerifiedPdfSourceFile } from "../src/pdf-source-stage.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const source = async function* (bytes: Uint8Array) {
  for (let i = 0; i < bytes.byteLength; i += 3) yield bytes.subarray(i, i + 3);
};

describe("verified PDF source file", () => {
  it("streams exact SHA-bound bytes to a private file and removes them after use", async () => {
    const bytes = Buffer.from("%PDF-1.7\nverified staged source");
    let filename = "";
    const observed = await withVerifiedPdfSourceFile(source(bytes), {
      sizeBytes: bytes.byteLength, sha256: sha(bytes), maxBytes: 200 * 1024 * 1024,
    }, async (path) => {
      filename = path;
      expect((await stat(path)).size).toBe(bytes.byteLength);
      expect(await readFile(path)).toEqual(bytes);
      return "SOURCE_VERIFIED";
    });
    expect(observed).toBe("SOURCE_VERIFIED");
    await expect(stat(filename)).rejects.toThrow();
  });

  it("does not invoke a parser after equal-length source substitution", async () => {
    const original = Buffer.from("%PDF-1.7\noriginal document");
    const changed = Buffer.from("%PDF-1.7\nmodified document");
    expect(changed.length).toBe(original.length);
    let called = false;
    await expect(withVerifiedPdfSourceFile(source(changed), {
      sizeBytes: original.length, sha256: sha(original), maxBytes: 100,
    }, async () => { called = true; }))
      .rejects.toThrow("SOURCE_CORRUPTED");
    expect(called).toBe(false);
  });

  it("rejects truncated or oversized streams before parser access", async () => {
    const bytes = Buffer.from("%PDF-1.7\ncorrect source");
    for (const actual of [bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from("X")])]) {
      let called = false;
      await expect(withVerifiedPdfSourceFile(source(actual), {
        sizeBytes: bytes.length, sha256: sha(bytes), maxBytes: 100,
      }, async () => { called = true; }))
        .rejects.toThrow(actual.length < bytes.length ? "SOURCE_CORRUPTED" : "SOURCE_TOO_LARGE");
      expect(called).toBe(false);
    }
  });

  it("rejects invalid signatures and removes the file on action failure", async () => {
    const invalid = Buffer.from("NOT_A_PDF");
    let called = false;
    await expect(withVerifiedPdfSourceFile(source(invalid), {
      sizeBytes: invalid.length, sha256: sha(invalid), maxBytes: 100,
    }, async () => { called = true; })).rejects.toThrow("SOURCE_CORRUPTED");
    expect(called).toBe(false);

    const valid = Buffer.from("%PDF-1.7\nerror path");
    let filename = "";
    await expect(withVerifiedPdfSourceFile(source(valid), {
      sizeBytes: valid.length, sha256: sha(valid), maxBytes: 100,
    }, async (path) => { filename = path; throw new Error("PARSER_FAILED"); }))
      .rejects.toThrow("PARSER_FAILED");
    await expect(stat(filename)).rejects.toThrow();
  });
});
