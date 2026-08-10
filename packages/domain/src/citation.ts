import { createHash } from "node:crypto";

/** JavaScript UTF-16 code-unit citation protocol, using [startOffset, endOffset). */
export function isUtf16Boundary(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
  if (offset === 0 || offset === text.length) return true;

  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  const followsHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;
  const precedesLowSurrogate = next >= 0xdc00 && next <= 0xdfff;
  return !(followsHighSurrogate && precedesLowSurrogate);
}

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
    isUtf16Boundary(blockText, startOffset) &&
    isUtf16Boundary(blockText, endOffset) &&
    blockText.slice(startOffset, endOffset) === quoteText
  );
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildSourceSpan(blockText: string, startOffset: number, endOffset: number) {
  if (!isUtf16Boundary(blockText, startOffset) || !isUtf16Boundary(blockText, endOffset)) {
    throw new RangeError("INVALID_SOURCE_SPAN");
  }
  const quoteText = blockText.slice(startOffset, endOffset);
  if (!validateSourceSpan(blockText, startOffset, endOffset, quoteText)) {
    throw new RangeError("INVALID_SOURCE_SPAN");
  }

  return { startOffset, endOffset, quoteText, quoteHash: sha256Utf8(quoteText) };
}
