export const CANONICAL_NORMALIZATION_VERSION = "canonical-text-v1";
export const CANONICAL_BLOCK_SEPARATOR = "\n\n";
export const CANONICAL_BLOCK_MAX_CODE_UNITS = 32_000;

export function normalizeCanonicalText(value: string, options: { stripDocumentBom?: boolean } = {}): string {
  let normalized = value.replace(/\r\n?/g, "\n");
  if (options.stripDocumentBom && normalized.startsWith("\uFEFF")) {
    normalized = normalized.slice(1);
  }

  return normalized
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}

export function splitCanonicalBlock(value: string, maxCodeUnits = CANONICAL_BLOCK_MAX_CODE_UNITS): string[] {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 2) throw new Error("INVALID_CANONICAL_BLOCK_LIMIT");
  const chunks: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + maxCodeUnits, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(value.charAt(end))) end--;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}
