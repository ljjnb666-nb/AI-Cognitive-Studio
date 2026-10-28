import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SourceError } from "./source-errors.js";

export type VerifiedPdfSource = {
  sizeBytes: number;
  sha256: string;
  maxBytes: number;
};

/**
 * Own a private temporary file only for the duration of a PDF extraction.
 * Source bytes are streamed and checked against the immutable SourceDocument
 * identity before the parser or OCR is allowed to read the file.
 *
 * This avoids an unconditional full-PDF Buffer in the parent ingestion worker.
 * The isolated PDF.js child and opt-in legacy OCR executors have independent
 * memory limits, which this helper intentionally does not claim to solve.
 */
export async function withVerifiedPdfSourceFile<T>(
  source: AsyncIterable<Uint8Array>,
  expected: VerifiedPdfSource,
  action: (filePath: string) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 5 ||
      !Number.isSafeInteger(expected.maxBytes) || expected.maxBytes < 5 ||
      expected.sizeBytes > expected.maxBytes) throw new Error(SourceError.TOO_LARGE);
  if (!/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error(SourceError.CORRUPTED);

  const dir = await mkdtemp(join(tmpdir(), "ai-cognitive-pdf-stage-"));
  const filePath = join(dir, "source.pdf");
  const digest = createHash("sha256");
  const prefix = Buffer.alloc(5);
  let prefixLength = 0;
  let streamedSize = 0;

  try {
    const verifiedStream = Readable.from((async function* () {
      for await (const chunk of source) {
        streamedSize += chunk.byteLength;
        if (streamedSize > expected.sizeBytes || streamedSize > expected.maxBytes)
          throw new Error(SourceError.TOO_LARGE);
        digest.update(chunk);
        if (prefixLength < prefix.length) {
          const take = Math.min(prefix.length - prefixLength, chunk.byteLength);
          prefix.set(chunk.subarray(0, take), prefixLength);
          prefixLength += take;
        }
        yield chunk;
      }
    })());
    await pipeline(verifiedStream, createWriteStream(filePath, { flags: "wx", mode: 0o600 }));
    if (streamedSize !== expected.sizeBytes ||
        digest.digest("hex") !== expected.sha256 ||
        prefixLength !== 5 || prefix.toString("ascii") !== "%PDF-")
      throw new Error(SourceError.CORRUPTED);

    return await action(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
