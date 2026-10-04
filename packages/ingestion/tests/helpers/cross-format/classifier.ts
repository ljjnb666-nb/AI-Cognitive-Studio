/**
 * BOOK-INGESTION-03 divergence classifier — TEST-ONLY, DIAGNOSTIC ONLY.
 *
 * The hard content authority is full normalized stream equality (enforced by
 * the gate). This module only explains WHY unequal streams differ, using
 * stable evaluator codes. Anchors are sentence-boundary splits with NO
 * minimum-length filter: every non-whitespace portion of the stream remains
 * represented inside some anchor, so short content can never silently
 * disappear from diagnosis. Anchors/LCS can never turn unequal streams
 * into PASS.
 */

import type { StreamDiagnostics } from "./types.js";

/** Splits a normalized stream into sentence anchors; nothing is discarded. */
export function buildDiagnosticAnchors(stream: string): string[] {
  return stream
    .split(/(?<=[.!?。！？])/u)
    .map((anchor) => anchor.trim())
    .filter((anchor) => anchor.length > 0);
}

function countAnchors(anchors: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const anchor of anchors) counts.set(anchor, (counts.get(anchor) ?? 0) + 1);
  return counts;
}

/** Multiset difference: anchors in `left` exceeding their count in `right`. */
function multisetMinus(left: string[], right: Map<string, number>): string[] {
  const remaining = new Map(right);
  const excess: string[] = [];
  for (const anchor of left) {
    const count = remaining.get(anchor) ?? 0;
    if (count > 0) remaining.set(anchor, count - 1);
    else excess.push(anchor);
  }
  return excess;
}

function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1]
        ? (previous[j - 1] ?? 0) + 1
        : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Classifies why two unequal normalized streams differ. `pdfComplete` /
 * `epubComplete` say which side the fixture manifest declares complete, so a
 * prefix relationship is attributed to the declared truncated side.
 */
export function classifyDivergence(
  pdfStream: string,
  epubStream: string,
  options: { pdfComplete: boolean; epubComplete: boolean },
): StreamDiagnostics {
  const pdfAnchors = buildDiagnosticAnchors(pdfStream);
  const epubAnchors = buildDiagnosticAnchors(epubStream);
  const pdfCounts = countAnchors(pdfAnchors);
  const epubCounts = countAnchors(epubAnchors);
  const onlyInPdf = multisetMinus(pdfAnchors, epubCounts);
  const onlyInEpub = multisetMinus(epubAnchors, pdfCounts);
  const commonPrefixLength = commonPrefixLengthOf(pdfStream, epubStream);
  const commonSuffixLength = commonSuffixLengthOf(pdfStream, epubStream);
  const lcs = longestCommonSubsequenceLength(pdfAnchors, epubAnchors);
  const anchorSequenceEqual = pdfAnchors.length === epubAnchors.length && lcs === pdfAnchors.length;

  let code: StreamDiagnostics["code"];
  const pdfAnchorSet = new Set(pdfAnchors);
  const epubAnchorSet = new Set(epubAnchors);
  if (onlyInPdf.length === 0 && onlyInEpub.length > 0 && onlyInEpub.every((anchor) => pdfAnchorSet.has(anchor))) {
    // The EPUB-only excess already exists on the PDF side: duplication.
    code = "CROSS_FORMAT_CONTENT_DUPLICATED";
  } else if (onlyInEpub.length === 0 && onlyInPdf.length > 0 && onlyInPdf.every((anchor) => epubAnchorSet.has(anchor))) {
    code = "CROSS_FORMAT_CONTENT_DUPLICATED";
  } else if (pdfStream.startsWith(epubStream) && epubStream.length < pdfStream.length) {
    // The tail lives on the PDF side. If EPUB is the declared-complete
    // source, the tail is extra PDF content; otherwise EPUB lost the tail
    // of the book the manifest says PDF carries completely.
    code = options.epubComplete ? "CROSS_FORMAT_EXTRA_CONTENT" : "CROSS_FORMAT_TAIL_TRUNCATED";
  } else if (epubStream.startsWith(pdfStream) && pdfStream.length < epubStream.length) {
    code = options.pdfComplete ? "CROSS_FORMAT_EXTRA_CONTENT" : "CROSS_FORMAT_TAIL_TRUNCATED";
  } else if (sortedCharacters(pdfStream) === sortedCharacters(epubStream)) {
    // Identical character multiset in a different arrangement: reordering.
    // (Glued-stream anchor boundaries shift under swaps, so the character
    // multiset — invariant under any permutation — is the reorder signal.)
    code = "CROSS_FORMAT_ORDER_MISMATCH";
  } else if (onlyInPdf.length > 0 && onlyInEpub.length === 0) {
    code = "CROSS_FORMAT_CONTENT_MISSING";
  } else if (onlyInEpub.length > 0 && onlyInPdf.length === 0) {
    code = "CROSS_FORMAT_EXTRA_CONTENT";
  } else {
    // Mixed divergence; MISSING is the conservative primary explanation and
    // the diagnostics lists carry the rest.
    code = "CROSS_FORMAT_CONTENT_MISSING";
  }

  return {
    code,
    commonPrefixLength,
    commonSuffixLength,
    firstDivergence: {
      pdfIndex: commonPrefixLength,
      epubIndex: commonPrefixLength,
    },
    anchorsOnlyInPdf: onlyInPdf,
    anchorsOnlyInEpub: onlyInEpub,
    anchorSequenceEqual,
    longestCommonAnchorSubsequence: lcs,
  };
}

function sortedCharacters(stream: string): string {
  return [...stream].sort().join("");
}

function commonPrefixLengthOf(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index++;
  return index;
}

function commonSuffixLengthOf(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let offset = 0;
  while (offset < limit && a.charCodeAt(a.length - 1 - offset) === b.charCodeAt(b.length - 1 - offset)) offset++;
  return offset;
}
