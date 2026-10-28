import { createHash } from "node:crypto";
import type { StorageProvider } from "@ai-cognitive/storage";

/** Source is checked once per ETag; only the digest attestation is cached, never PDF bytes. */
export const MAX_PDF_REVIEW_SOURCE_BYTES = 512_000_000;
export const MAX_PDF_REVIEW_RANGE_BYTES = 8 * 1024 * 1024;
const ATTESTATION_TTL_MS = 5 * 60_000;
const MAX_ATTESTATIONS = 32;

type PreviewSource = { storageKey: string; sha256: string; sizeBytes: bigint; mediaType: string };
type PreviewStorage = Pick<StorageProvider, "headObject" | "getObjectStream" | "getObjectRangeStream">;
type Attestation = { expiresAt: number; promise: Promise<void> };
const attestations = new Map<string, Attestation>();
const ETAG_PATTERN = /^"[a-zA-Z0-9-]{8,128}"$/;

function validateSource(source: PreviewSource) {
  if (source.mediaType !== "application/pdf" ||
      !/^[0-9a-f]{64}$/.test(source.sha256) ||
      !source.storageKey || typeof source.sizeBytes !== "bigint" ||
      source.sizeBytes < 5n ||
      source.sizeBytes > BigInt(MAX_PDF_REVIEW_SOURCE_BYTES))
    throw new Error("PDF_REVIEW_RANGE_INVALID_SOURCE");
}

async function attestSource(
  storage: PreviewStorage, source: PreviewSource, etag: string, total: number,
) {
  const key = JSON.stringify([source.storageKey, source.sha256, total, etag]);
  const now = Date.now();
  const prior = attestations.get(key);
  if (prior && prior.expiresAt > now) return prior.promise;
  // Strict conditional full-content digest. This reads at most one chunk at a
  // time and never allocates one Uint8Array for the entire original PDF.
  const promise = (async () => {
    const digest = createHash("sha256");
    let bytes = 0;
    const prefix: number[] = [];
    for await (const chunk of await storage.getObjectStream(source.storageKey, { ifMatch: etag })) {
      if (!(chunk instanceof Uint8Array) || !chunk.byteLength)
        throw new Error("PDF_REVIEW_RANGE_INVALID_CHUNK");
      bytes += chunk.byteLength;
      if (bytes > total) throw new Error("PDF_REVIEW_RANGE_SIZE_INVALID");
      digest.update(chunk);
      for (let j = 0; j < chunk.length && prefix.length < 5; j++) prefix.push(chunk[j]!);
    }
    if (bytes !== total || digest.digest("hex") !== source.sha256)
      throw new Error("PDF_REVIEW_RANGE_SHA_INVALID");
    if (prefix.join(",") !== "37,80,68,70,45")
      throw new Error("PDF_REVIEW_RANGE_MAGIC_INVALID");
  })();
  if (attestations.size >= MAX_ATTESTATIONS) {
    const oldest = attestations.keys().next().value;
    if (oldest) attestations.delete(oldest);
  }
  attestations.set(key, { expiresAt: now + ATTESTATION_TTL_MS, promise });
  try { await promise; } catch (error) {
    if (attestations.get(key)?.promise === promise) attestations.delete(key);
    throw error;
  }
}

export function parsePdfPreviewByteRange(value: string, total: number): { start: number; end: number } {
  if (!Number.isSafeInteger(total) || total < 5 || !value.startsWith("bytes=") ||
      value.includes(",")) throw new Error("PDF_REVIEW_RANGE_UNSATISFIABLE");
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error("PDF_REVIEW_RANGE_UNSATISFIABLE");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw new Error("PDF_REVIEW_RANGE_UNSATISFIABLE");
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start >= total || end < start || (match[2] && end >= total))
    throw new Error("PDF_REVIEW_RANGE_UNSATISFIABLE");
  // A client can request the next portion with another Range header. Even
  // "bytes=0-" cannot force a multi-hundred-MB response into one request.
  return { start, end: Math.min(end, start + MAX_PDF_REVIEW_RANGE_BYTES - 1) };
}

/** Streaming response body: one chunk in flight, verifies length, closes upstream on cancel. */
export function boundedPdfResponseBody(stream: AsyncIterable<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_PDF_REVIEW_SOURCE_BYTES)
    throw new Error("PDF_REVIEW_RANGE_SIZE_INVALID");
  const iterator = stream[Symbol.asyncIterator]();
  let seen = 0;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          done = true;
          if (seen !== length) throw new Error("PDF_REVIEW_RANGE_STREAM_INCOMPLETE");
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array)) throw new Error("PDF_REVIEW_RANGE_INVALID_CHUNK");
        seen += next.value.byteLength;
        if (seen > length) throw new Error("PDF_REVIEW_RANGE_STREAM_OVERFLOW");
        controller.enqueue(new Uint8Array(next.value));
      } catch (err) {
        done = true;
        controller.error(err);
        await iterator.return?.();
      }
    },
    async cancel() {
      if (!done) {
        done = true;
        await iterator.return?.();
      }
    },
  });
}

export async function prepareVerifiedPdfReviewResponse(
  storage: PreviewStorage, source: PreviewSource, rangeHeader: string | null,
): Promise<{ stream: AsyncIterable<Uint8Array>; total: number; length: number; status: 200 | 206; range?: { start: number; end: number } }> {
  validateSource(source);
  const head = await storage.headObject(source.storageKey);
  if (!head || head.size !== Number(source.sizeBytes) ||
      typeof head.etag !== "string" || !ETAG_PATTERN.test(head.etag))
    throw new Error("PDF_REVIEW_RANGE_SOURCE_CHANGED");
  await attestSource(storage, source, head.etag, head.size);
  if (rangeHeader !== null) {
    const range = parsePdfPreviewByteRange(rangeHeader, head.size);
    if (!storage.getObjectRangeStream)
      throw new Error("PDF_REVIEW_RANGE_STORAGE_UNSUPPORTED");
    const result = await storage.getObjectRangeStream(source.storageKey, {
      start: range.start, end: range.end, totalSize: head.size, ifMatch: head.etag,
    });
    if (result.length !== range.end - range.start + 1)
      throw new Error("PDF_REVIEW_RANGE_STORAGE_MISMATCH");
    return { stream: result.stream, total: head.size, length: result.length, status: 206, range };
  }
  // Native PDF viewers may request an ordinary GET first. Stream that source
  // without buffering it in Web heap; return 200 for browser compatibility.
  const stream = await storage.getObjectStream(source.storageKey, { ifMatch: head.etag });
  return { stream, total: head.size, length: head.size, status: 200 };
}
