import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_PDF_REVIEW_RANGE_BYTES,
  MAX_PDF_REVIEW_SOURCE_BYTES,
  boundedPdfResponseBody,
  parsePdfPreviewByteRange,
  prepareVerifiedPdfReviewResponse,
} from "../lib/pdf-human-range-source";

const ETAG = '"7c49badadd045e5fa1712dd8"';
const CHUNK_SIZE = 1024 * 1024;
const prefix = new Uint8Array(CHUNK_SIZE);
prefix.set(new TextEncoder().encode("%PDF-1.7\n"));
const rest = new Uint8Array(CHUNK_SIZE);

function fixture(size: number, mutated = false) {
  const sha = createHash("sha256");
  for (let offset = 0; offset < size; offset += CHUNK_SIZE)
    sha.update((offset === 0 ? prefix : rest).subarray(0, Math.min(CHUNK_SIZE, size - offset)));
  const source = {
    storageKey: "private/test-" + size + (mutated ? "-modified" : ""),
    sha256: sha.digest("hex"),
    sizeBytes: BigInt(size), mediaType: "application/pdf",
  };
  let attestationStreams = 0;
  let rangeCalls = 0;
  const provider = {
    headObject: async () => ({ key: source.storageKey, size, etag: ETAG }),
    getObjectStream: async (_key: string, options?: { ifMatch?: string }) => {
      if (options?.ifMatch !== ETAG) throw new Error("IF_MATCH_REQUIRED");
      attestationStreams++;
      return (async function* () {
        for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
          const part = (offset === 0 ? prefix : rest).subarray(0, Math.min(CHUNK_SIZE, size - offset));
          if (mutated && offset === 0) {
            const changed = new Uint8Array(part);
            changed[8] = 0x42;
            yield changed;
          } else yield part;
        }
      })();
    },
    getObjectRangeStream: async (_key: string, input: {
      start: number; end: number; totalSize: number; ifMatch: string;
    }) => {
      expect(input.ifMatch).toBe(ETAG);
      expect(input.totalSize).toBe(size);
      rangeCalls++;
      const out = new Uint8Array(input.end - input.start + 1);
      for (let i = 0; i < out.length; i++) {
        const index = input.start + i;
        out[i] = index < CHUNK_SIZE ? prefix[index]! : rest[index % CHUNK_SIZE]!;
      }
      return { length: out.byteLength, stream: (async function* () { yield out; })() };
    },
  };
  return { source, provider, counts: () => ({ attestationStreams, rangeCalls }) };
}

describe("large private PDF SHA attestation + bounded no-buffer byte ranges", () => {
  it("streams an original larger than the old 110 MB cap, caches only digest attestation and enforces 8MiB", async () => {
    const f = fixture(151_495_200);
    expect(f.source.sizeBytes).toBeGreaterThan(110_000_000n);
    expect(f.source.sizeBytes).toBeLessThan(BigInt(MAX_PDF_REVIEW_SOURCE_BYTES));
    const first = await prepareVerifiedPdfReviewResponse(f.provider, f.source, "bytes=0-");
    expect(first.status).toBe(206);
    expect(first.range).toEqual({ start: 0, end: MAX_PDF_REVIEW_RANGE_BYTES - 1 });
    expect(first.length).toBe(MAX_PDF_REVIEW_RANGE_BYTES);
    const data = await new Response(boundedPdfResponseBody(first.stream, first.length)).arrayBuffer();
    expect(data.byteLength).toBe(MAX_PDF_REVIEW_RANGE_BYTES);
    expect(new TextDecoder().decode(new Uint8Array(data).subarray(0, 5))).toBe("%PDF-");
    const second = await prepareVerifiedPdfReviewResponse(
      f.provider, f.source, "bytes=151495100-151495199",
    );
    expect(second.range).toEqual({ start: 151495100, end: 151495199 });
    expect((await new Response(boundedPdfResponseBody(second.stream, second.length)).arrayBuffer()).byteLength)
      .toBe(100);
    expect(f.counts()).toEqual({ attestationStreams: 1, rangeCalls: 2 });
  }, 20_000);

  it("supports suffix requests and rejects multipart/invalid/over-end ranges", () => {
    expect(parsePdfPreviewByteRange("bytes=-20", 300)).toEqual({ start: 280, end: 299 });
    expect(parsePdfPreviewByteRange("bytes=0-99", 300)).toEqual({ start: 0, end: 99 });
    for (const invalid of ["bytes=300-", "bytes=10-1", "bytes=0-300",
      "bytes=0-5,10-15", "bytes=-0", "items=0-5", "bytes=abc-10"])
      expect(() => parsePdfPreviewByteRange(invalid, 300)).toThrow("PDF_REVIEW_RANGE_UNSATISFIABLE");
  });
  it("rejects a replaced object before releasing any partial page", async () => {
    const f = fixture(7_000_000, true);
    await expect(prepareVerifiedPdfReviewResponse(f.provider, f.source, "bytes=0-4095"))
      .rejects.toThrow("PDF_REVIEW_RANGE_SHA_INVALID");
    expect(f.counts().rangeCalls).toBe(0);
  });
  it("refuses missing ETag and size mismatch, never trusting a client-supplied URL", async () => {
    const f = fixture(1_000);
    await expect(prepareVerifiedPdfReviewResponse({
      ...f.provider, headObject: async () => ({ key: "x", size: 999, etag: ETAG }),
    }, f.source, "bytes=0-20")).rejects.toThrow("PDF_REVIEW_RANGE_SOURCE_CHANGED");
    await expect(prepareVerifiedPdfReviewResponse({
      ...f.provider, headObject: async () => ({ key: "x", size: 1_000 }),
    }, f.source, "bytes=0-20")).rejects.toThrow("PDF_REVIEW_RANGE_SOURCE_CHANGED");
    expect(f.counts().rangeCalls).toBe(0);
  });
  it("retains ordinary browser GET compatibility without returning a giant buffered payload", async () => {
    const f = fixture(1_000);
    const response = await prepareVerifiedPdfReviewResponse(f.provider, f.source, null);
    expect(response.status).toBe(200);
    expect(response.range).toBeUndefined();
    expect(response.length).toBe(1_000);
    expect((await new Response(boundedPdfResponseBody(response.stream,response.length)).arrayBuffer()).byteLength)
      .toBe(1_000);
  });
});
