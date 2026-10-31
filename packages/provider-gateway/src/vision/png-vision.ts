import { createHash } from "node:crypto";
import { ProviderGatewayError } from "../errors.js";
import type { PdfVisualImage, TextMessage } from "../types.js";

export const PDF_VISION_MAX_IMAGE_BYTES = 8_000_000;
const MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const reject = (): never => { throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "PDF vision image contract rejected"); };

/** Validates real PNG source identity before any remote call or durable claim. */
export function validatePdfVisionImage(image: unknown): { byteLength: number; width: number; height: number } {
  if (!image || typeof image !== "object" || Array.isArray(image)) return reject();
  const data = image as PdfVisualImage;
  const fields = Object.keys(data);
  if (fields.length !== 5 || !["mediaType", "dataBase64", "sha256", "sourceSha256", "physicalPageIndex"].every(k => fields.includes(k)) ||
      data.mediaType !== "image/png" ||
      typeof data.dataBase64 !== "string" ||
      data.dataBase64.length < 60 || data.dataBase64.length > Math.ceil(PDF_VISION_MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[a-zA-Z0-9+/]*={0,2}$/.test(data.dataBase64) ||
      typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256) ||
      typeof data.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sourceSha256) ||
      !Number.isSafeInteger(data.physicalPageIndex) || data.physicalPageIndex < 0 || data.physicalPageIndex > 1999) return reject();
  const bytes = Buffer.from(data.dataBase64, "base64");
  if (bytes.length < 45 || bytes.length > PDF_VISION_MAX_IMAGE_BYTES ||
      bytes.toString("base64") !== data.dataBase64 ||
      !bytes.subarray(0, 8).equals(MAGIC) ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      sha256(bytes) !== data.sha256) return reject();
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width * height > 8_000_000) return reject();
  return { byteLength: bytes.length, width, height };
}

/** Only one image, exactly one user message, no inferred multi-page fanout. */
export function validatePdfVisionTextMessages(messages: readonly TextMessage[]): number {
  if (messages.length !== 1 || messages[0]?.role !== "user" || !messages[0].image ||
      messages[0].content.length > 8_000 || !messages[0].content.trim()) return reject();
  return validatePdfVisionImage(messages[0].image).byteLength;
}
