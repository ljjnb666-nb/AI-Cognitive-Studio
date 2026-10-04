/**
 * BOOK-INGESTION-03 comparison normalization and semantic view — TEST-ONLY.
 *
 * Operates on DERIVED COPIES ONLY. Parser block text is never mutated; the
 * only outputs are evaluator-internal comparison strings and ORIGINAL
 * block-local UTF-16 fragment offsets. Comparison offsets are never
 * published as citation offsets.
 *
 * Normalization v1 (deterministic only; no heuristic pass rules):
 *   N1 Unicode NFC
 *   N2 CRLF / CR → LF
 *   N3 NBSP → space
 *   N4 whitespace runs → exactly one ASCII space
 *   N5 remove U+00AD SOFT HYPHEN
 *   N6 strip leading BOM of the comparison source
 *   N7 trim stream boundaries (and per-block boundaries, so PDF page and
 *      EPUB spine segmentation are representation-neutral)
 *
 * Empirical PDF fidelity probe (production pdfjs-isolated/pdf-isolation-v3
 * path): line breaks are dropped WITHOUT any separator, NBSP arrives as
 * U+0020, U+00AD arrives as U+002D. Therefore the normalized stream joins
 * per-block segments with pure concatenation, and cross-format fixtures
 * place block boundaries at no-whitespace positions of the linear text.
 * Forbidden in v1: case folding, punctuation/quote/dash normalization,
 * spelling or OCR correction, generic NFKC, hyphenation guessing, fuzzy
 * matching — none may exist in this file.
 */

import type {
  ComparisonSegment,
  CrossFormatSemanticView,
  SourceFragment,
  ViewCapabilities,
} from "./types.js";

export const COMPARABLE_LEXICAL_KINDS: ReadonlySet<string> = new Set([
  "HEADING",
  "PARAGRAPH",
  "LIST_ITEM",
  "QUOTE",
  "CODE",
  "CAPTION",
]);

/** Applies N1–N7 plus boundary trimming to one derived comparison slice. */
export function normalizeForComparison(input: string): string {
  let normalized = input;
  if (normalized.startsWith("\uFEFF")) normalized = normalized.slice(1);
  normalized = normalized.replace(/\r\n?/g, "\n");
  normalized = normalized.normalize("NFC");
  normalized = normalized.replace(/\u00AD/g, "");
  normalized = normalized.replace(/\u00A0/g, " ");
  normalized = normalized.replace(/\s+/g, " ");
  return normalized.trim();
}

/**
 * Builds one comparison segment from a single block using grapheme-cluster
 * alignment so every emitted fragment stays on extended-grapheme (and hence
 * surrogate-safe, NFC-safe) boundaries. Dropped clusters (leading BOM,
 * U+00AD) fold into the neighboring fragment range — extending an open
 * whitespace run or the next piece's start — so pieces stay contiguous and
 * reconstruction from original slices is exact.
 */
export function buildComparisonSegment(
  blockOrdinal: number,
  blockText: string,
  blockKind: string,
): ComparisonSegment {
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  const pieces: Array<{ text: string; start: number; end: number }> = [];
  let whitespaceRun: { start: number; end: number } | null = null;
  let pendingGapStart: number | null = null;

  for (const cluster of segmenter.segment(blockText)) {
    const raw = cluster.segment;
    const start = cluster.index;
    const end = start + raw.length;
    if (raw === "\u00AD" || (start === 0 && raw === "\uFEFF")) {
      if (whitespaceRun !== null) whitespaceRun.end = end;
      else pendingGapStart = pendingGapStart ?? start;
      continue;
    }
    if (/\s+/u.test(raw)) {
      if (whitespaceRun === null) {
        whitespaceRun = { start: pendingGapStart ?? start, end };
        pendingGapStart = null;
      } else {
        whitespaceRun.end = end;
      }
      continue;
    }
    if (whitespaceRun !== null) {
      pieces.push({ text: " ", start: whitespaceRun.start, end: whitespaceRun.end });
      whitespaceRun = null;
    }
    const pieceStart = pendingGapStart ?? start;
    pendingGapStart = null;
    pieces.push({ text: raw.normalize("NFC"), start: pieceStart, end });
  }

  // Boundary trimming (N7): drop only leading/trailing whitespace pieces;
  // interior single spaces are lexical content and must survive.
  let first = 0;
  let last = pieces.length;
  while (first < last && pieces[first]?.text === " ") first++;
  while (last > first && pieces[last - 1]?.text === " ") last--;
  const keptPieces = pieces.slice(first, last);
  const normalizedText = keptPieces.map((piece) => piece.text).join("");
  const fragments: SourceFragment[] = [];
  for (const piece of keptPieces) {
    const last = fragments.at(-1);
    if (last && last.endOffset === piece.start) {
      last.endOffset = piece.end;
      continue;
    }
    fragments.push({ blockOrdinal, startOffset: piece.start, endOffset: piece.end });
  }
  return { normalizedText, sourceFragments: fragments, blockKind };
}

/** Minimal comparable-source shape (subset of production ParsedBlock). */
export type ComparableBlock = { ordinal: number; kind: string; text: string };

/**
 * Builds the evaluator view for one format. `includeTables` admits TABLE
 * blocks into the lexical set (SIMPLE_TABLE policy only); otherwise TABLE,
 * like FOOTNOTE/EQUATION/IMAGE, stays outside and forces the affected
 * content dimension to NOT_COMPARABLE (no one-sided semantic filtering).
 */
export function buildCrossFormatView(
  blocks: ComparableBlock[],
  options: { includeTables?: boolean } = {},
): CrossFormatSemanticView {
  const comparable: ReadonlySet<string> = options.includeTables
    ? new Set([...COMPARABLE_LEXICAL_KINDS, "TABLE"])
    : COMPARABLE_LEXICAL_KINDS;
  const segments: ComparisonSegment[] = [];
  const capabilities: ViewCapabilities = {
    headings: false,
    footnotes: false,
    tables: false,
    equations: false,
    images: false,
  };
  for (const block of blocks) {
    if (block.kind === "HEADING") capabilities.headings = true;
    if (block.kind === "FOOTNOTE") capabilities.footnotes = true;
    if (block.kind === "TABLE") capabilities.tables = true;
    if (block.kind === "EQUATION") capabilities.equations = true;
    if (block.kind === "IMAGE") capabilities.images = true;
    if (!comparable.has(block.kind)) continue;
    const segment = buildComparisonSegment(block.ordinal, block.text, block.kind);
    if (segment.normalizedText) segments.push(segment);
  }
  return { normalizedStream: segments.map((segment) => segment.normalizedText).join(""), segments, capabilities };
}

/**
 * Reconstruction invariant: the original slices of a segment's fragments,
 * concatenated in declared order and passed through the SAME normalization,
 * must rebuild the segment text exactly. Returns a failure description
 * instead of throwing so the gate can report CROSS_FORMAT_PROVENANCE_INVALID.
 */
export function verifySegmentReconstruction(
  segment: ComparisonSegment,
  blocksByOrdinal: Map<number, ComparableBlock>,
): string | null {
  const slices: string[] = [];
  for (const fragment of segment.sourceFragments) {
    const block = blocksByOrdinal.get(fragment.blockOrdinal);
    if (!block) return `fragment references unknown block ordinal ${fragment.blockOrdinal}`;
    if (
      fragment.startOffset < 0 ||
      fragment.endOffset > block.text.length ||
      fragment.startOffset >= fragment.endOffset
    ) {
      return `fragment range [${fragment.startOffset}, ${fragment.endOffset}) escapes block ${fragment.blockOrdinal}`;
    }
    slices.push(block.text.slice(fragment.startOffset, fragment.endOffset));
  }
  const reconstructed = normalizeForComparison(slices.join(""));
  if (reconstructed !== segment.normalizedText) {
    return `segment "${segment.normalizedText}" does not reconstruct from original slices (got "${reconstructed}")`;
  }
  return null;
}
