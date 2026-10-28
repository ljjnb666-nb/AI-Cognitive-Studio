import { createHash } from "node:crypto";
import type { StorageProvider } from "@ai-cognitive/storage";

const MAX_PDF_PREVIEW_BYTES = 110_000_000;

/** Fully authenticate + verify original bytes BEFORE sending even one page to a browser. */
export async function loadVerifiedPdfForHumanReview(
  provider: Pick<StorageProvider, "headObject" | "getObjectStream">,
  source: { storageKey: string; sha256: string; sizeBytes: bigint; mediaType: string },
): Promise<Uint8Array> {
  if (source.mediaType !== "application/pdf" ||
      !/^[0-9a-f]{64}$/.test(source.sha256) ||
      !source.storageKey ||
      typeof source.sizeBytes !== "bigint" ||
      source.sizeBytes < 5n ||
      source.sizeBytes > BigInt(MAX_PDF_PREVIEW_BYTES)) {
    throw new Error("PDF_REVIEW_PREVIEW_INVALID_SOURCE");
  }
  const head = await provider.headObject(source.storageKey);
  if (!head || head.size !== Number(source.sizeBytes)) {
    throw new Error("PDF_REVIEW_PREVIEW_SOURCE_SIZE_MISMATCH");
  }
  const chunks: Uint8Array[] = [];
  const digest = createHash("sha256");
  let length = 0;
  for await (const chunk of await provider.getObjectStream(source.storageKey)) {
    if (!(chunk instanceof Uint8Array)) throw new Error("PDF_REVIEW_PREVIEW_INVALID_CHUNK");
    length += chunk.byteLength;
    if (length > head.size || length > MAX_PDF_PREVIEW_BYTES)
      throw new Error("PDF_REVIEW_PREVIEW_SIZE_EXCEEDED");
    digest.update(chunk);
    chunks.push(chunk);
  }
  if (length !== head.size || digest.digest("hex") !== source.sha256)
    throw new Error("PDF_REVIEW_PREVIEW_SOURCE_SHA_MISMATCH");
  const pdf = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { pdf.set(chunk, offset); offset += chunk.byteLength; }
  if (pdf[0] !== 0x25 || pdf[1] !== 0x50 || pdf[2] !== 0x44 ||
      pdf[3] !== 0x46 || pdf[4] !== 0x2d)
    throw new Error("PDF_REVIEW_PREVIEW_INVALID_PDF_MAGIC");
  return pdf;
}
