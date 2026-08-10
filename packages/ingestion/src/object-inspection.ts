import { createHash } from "node:crypto";

export const SOURCE_SNIFF_PREFIX_BYTES = 64 * 1024;

export type ObjectInspection = {
  sizeBytes: number;
  sha256: string;
  prefix: Uint8Array;
};

export async function inspectObjectStream(stream: AsyncIterable<Uint8Array>): Promise<ObjectInspection> {
  const hash = createHash("sha256");
  const prefixChunks: Uint8Array[] = [];
  let prefixLength = 0;
  let sizeBytes = 0;

  for await (const chunk of stream) {
    hash.update(chunk);
    sizeBytes += chunk.byteLength;
    const remainingPrefixBytes = SOURCE_SNIFF_PREFIX_BYTES - prefixLength;
    if (remainingPrefixBytes > 0) {
      const prefixChunk = chunk.subarray(0, remainingPrefixBytes);
      prefixChunks.push(prefixChunk);
      prefixLength += prefixChunk.byteLength;
    }
  }

  const prefix = new Uint8Array(prefixLength);
  let offset = 0;
  for (const chunk of prefixChunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { sizeBytes, sha256: hash.digest("hex"), prefix };
}
