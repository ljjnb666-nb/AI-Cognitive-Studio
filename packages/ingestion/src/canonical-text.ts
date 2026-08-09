export const CANONICAL_NORMALIZATION_VERSION = "canonical-text-v1";
export const CANONICAL_BLOCK_SEPARATOR = "\n\n";

export function normalizeCanonicalText(value: string, options: { stripDocumentBom?: boolean } = {}): string {
  let normalized = value.replace(/\r\n?/g, "\n");
  if (options.stripDocumentBom && normalized.startsWith("\uFEFF")) {
    normalized = normalized.slice(1);
  }

  return normalized
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}
