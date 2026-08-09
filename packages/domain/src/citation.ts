import { createHash } from "node:crypto";

/** JavaScript UTF-16 code-unit citation protocol, using [startOffset, endOffset). */
export function validateSourceSpan(
  blockText: string,
  startOffset: number,
  endOffset: number,
  quoteText: string,
): boolean {
  return (
    Number.isInteger(startOffset) &&
    Number.isInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset > startOffset &&
    endOffset <= blockText.length &&
    blockText.slice(startOffset, endOffset) === quoteText
  );
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildSourceSpan(blockText: string, startOffset: number, endOffset: number) {
  const quoteText = blockText.slice(startOffset, endOffset);
  if (!validateSourceSpan(blockText, startOffset, endOffset, quoteText)) {
    throw new RangeError("INVALID_SOURCE_SPAN");
  }

  return { startOffset, endOffset, quoteText, quoteHash: sha256Utf8(quoteText) };
}
