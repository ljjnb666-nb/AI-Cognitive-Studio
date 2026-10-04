import type { NormalizedOutput } from "../schema.js";
import type { GroundTruth } from "../ground-truth.js";

/**
 * Fixed normalization policy (Phase 2B spec #7): NFKC, then remove ALL Unicode
 * whitespace. Hanzi, digits and punctuation are never removed, so metrics
 * cannot be inflated by deleting content; only space/newline layout
 * differences are ignored. This policy is identical for every parser and run.
 */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\p{White_Space}+/gu, "");
}

/** Bounded edit distance: exact Levenshtein below the window, null above it. */
export const EDIT_DISTANCE_MAX_CHARS = 20_000;

export function boundedLevenshtein(a: string, b: string): number | null {
  if (a.length > EDIT_DISTANCE_MAX_CHARS || b.length > EDIT_DISTANCE_MAX_CHARS) return null;
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/** Character multiset intersection size — O(n) recall/precision denominator. */
function charMultisetOverlap(a: string, b: string): number {
  const counts = new Map<string, number>();
  for (const ch of a) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let overlap = 0;
  for (const ch of b) {
    const remaining = counts.get(ch) ?? 0;
    if (remaining > 0) {
      counts.set(ch, remaining - 1);
      overlap++;
    }
  }
  return overlap;
}

/** Sequence-sensitive trigram containment: |trigrams(actual) ∩ trigrams(expected)| / |trigrams(expected)|. */
export function trigramRecall(expected: string, actual: string): number | null {
  if (expected.length < 3) return null;
  const expectedGrams = trigrams(expected);
  const actualGrams = trigrams(actual);
  let overlap = 0;
  for (const gram of expectedGrams) if (actualGrams.has(gram)) overlap++;
  return overlap / expectedGrams.size;
}

function trigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= text.length; i++) grams.add(text.slice(i, i + 3));
  return grams;
}

export type OutputBlockRef = { text: string; pageIndex: number | null; kind: string; globalIndex: number };

/** Flattens normalized parser output into ordered block refs. */
export function outputBlocks(normalized: NormalizedOutput): OutputBlockRef[] {
  const blocks: OutputBlockRef[] = [];
  for (const page of normalized.pages) {
    for (const block of page.blocks) {
      blocks.push({ text: block.text, pageIndex: block.pageIndex, kind: block.kind, globalIndex: blocks.length });
    }
  }
  return blocks;
}

export type GroundTruthAdapter = Pick<GroundTruth, "text" | "keyMarkers" | "blocks">;

export type TextMetrics = {
  expectedChars: number;
  actualChars: number;
  charRecall: number | null;
  charPrecision: number | null;
  editDistance: number | null;
  editDistanceAvailable: boolean;
  trigramRecall: number | null;
  duplicateRatio: number;
  unexpectedRatio: number | null;
  missingKeyMarkers: string[];
};

/**
 * Deterministic text fidelity metrics (spec #8). "More characters" is never a
 * quality signal here: duplicate and unexpected text are counted explicitly.
 */
export function computeTextMetrics(expected: GroundTruthAdapter, blocks: OutputBlockRef[]): TextMetrics {
  const expectedNorm = normalizeText(expected.text);
  const actualNorm = normalizeText(blocks.map((b) => b.text).join(""));
  const overlap = charMultisetOverlap(expectedNorm, actualNorm);
  const charRecall = expectedNorm.length > 0 ? overlap / expectedNorm.length : null;
  const charPrecision = actualNorm.length > 0 ? overlap / actualNorm.length : null;
  const editDistance = boundedLevenshtein(expectedNorm, actualNorm);
  const trigram = trigramRecall(expectedNorm, actualNorm);

  // Duplicate extraction (spec #8): a block whose normalized text appears more
  // than once in the output contributes every extra copy as duplicate chars.
  const counts = new Map<string, number>();
  for (const block of blocks) {
    const norm = normalizeText(block.text);
    if (norm.length === 0) continue;
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }
  let duplicateChars = 0;
  let actualCharsCounted = 0;
  for (const block of blocks) {
    const norm = normalizeText(block.text);
    if (norm.length === 0) continue;
    actualCharsCounted += norm.length;
    if ((counts.get(norm) ?? 0) > 1) duplicateChars += norm.length;
  }
  const duplicateRatio = actualCharsCounted > 0 ? duplicateChars / actualCharsCounted : 0;

  // Unexpected text (multiset semantics): every extracted character that has no
  // expected counterpart — duplicated and garbled output are both unexpected.
  const unexpectedChars = actualNorm.length - overlap;
  const unexpectedRatio = actualNorm.length > 0 ? unexpectedChars / actualNorm.length : null;

  const missingKeyMarkers = expected.keyMarkers.filter((marker) => !actualNorm.includes(normalizeText(marker)));

  return {
    expectedChars: expectedNorm.length,
    actualChars: actualNorm.length,
    charRecall,
    charPrecision,
    editDistance,
    editDistanceAvailable: editDistance !== null,
    trigramRecall: trigram,
    duplicateRatio,
    unexpectedRatio,
    missingKeyMarkers,
  };
}
