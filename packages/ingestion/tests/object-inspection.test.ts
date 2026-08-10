import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectObjectStream, SOURCE_SNIFF_PREFIX_BYTES } from "../src/object-inspection.js";

async function* chunks(bytes: Uint8Array, sizes: number[]): AsyncIterable<Uint8Array> {
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.byteLength) return;
    yield bytes.subarray(offset, offset + size);
    offset += size;
  }
  if (offset < bytes.byteLength) yield bytes.subarray(offset);
}

describe("inspectObjectStream", () => {
  it("hashes the complete stream while retaining only a bounded prefix", async () => {
    const bytes = Buffer.alloc(SOURCE_SNIFF_PREFIX_BYTES * 2 + 17, "a");
    const result = await inspectObjectStream(chunks(bytes, [1, 7, 1024, SOURCE_SNIFF_PREFIX_BYTES]));

    expect(result.sizeBytes).toBe(bytes.byteLength);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.prefix.byteLength).toBe(SOURCE_SNIFF_PREFIX_BYTES);
    expect(Buffer.from(result.prefix)).toEqual(bytes.subarray(0, SOURCE_SNIFF_PREFIX_BYTES));
  });

  it("is independent of chunk boundaries", async () => {
    const bytes = Buffer.from("chunk-boundary-independent hashing");
    const oneByte = await inspectObjectStream(chunks(bytes, Array.from({ length: bytes.byteLength }, () => 1)));
    const whole = await inspectObjectStream(chunks(bytes, [bytes.byteLength]));

    expect(oneByte).toEqual(whole);
  });
});
