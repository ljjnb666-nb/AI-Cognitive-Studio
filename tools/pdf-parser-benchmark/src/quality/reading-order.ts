import type { GtBlock } from "../ground-truth.js";
import { normalizeText, type OutputBlockRef } from "./metrics.js";

/**
 * Deterministic reading-order evaluation (Phase 2B spec #9).
 * Ground truth assigns each block an explicit order id (B1..Bn); parser output
 * blocks are mapped onto expected blocks and scored with ordered-pair accuracy.
 * Interleaving (左1 右1 左2 右2 vs expected 左1 左2 右1 右2) must register as
 * degradation — readingOrderAvailable=true is never treated as correctness.
 */

export type BlockMatch = { gtIndex: number; outputGlobalIndex: number; pageIndex: number | null };

export type ReadingOrderResult = {
  claimedAvailable: boolean;
  blocksExpected: number;
  blocksMatched: number;
  matches: BlockMatch[];
  comparablePairs: number;
  correctPairs: number;
  orderedPairAccuracy: number | null;
  interleavingDetected: boolean | null;
  columnMajorPreserved: boolean | null;
};

const MIN_CONTAINMENT_CHARS = 8;

/** Cheap deterministic prefilter: one probe of the shorter string must occur in the longer. */
function containmentPossible(shorter: string, longer: string): boolean {
  if (shorter.length < MIN_CONTAINMENT_CHARS) return false;
  const mid = Math.floor(shorter.length / 2);
  const probe = shorter.slice(mid, mid + MIN_CONTAINMENT_CHARS);
  return longer.includes(probe);
}

/**
 * Maps GT blocks to output blocks in two deterministic passes:
 * 1. exact pass — first unconsumed exactly-equal output block (consumes it, so
 *    duplicated output text cannot be matched twice by one GT block);
 * 2. containment pass — for unmatched GT blocks, the earliest output block that
 *    contains the GT text. Containment does NOT consume: parsers legitimately
 *    merge several expected lines into one output block (many-to-one).
 */
export function matchBlocks(gtBlocks: GtBlock[], blocks: OutputBlockRef[]): BlockMatch[] {
  const outputNorms = blocks.map((block) => normalizeText(block.text));
  const consumed = new Array<boolean>(blocks.length).fill(false);
  const matchedAt = new Array<number>(gtBlocks.length).fill(-1);

  const gtNorms = gtBlocks.map((block) => normalizeText(block.text));
  // pass 1: exact
  for (let g = 0; g < gtNorms.length; g++) {
    const gtNorm = gtNorms[g]!;
    if (gtNorm.length === 0) continue;
    for (let o = 0; o < outputNorms.length; o++) {
      if (consumed[o] || outputNorms[o]!.length === 0) continue;
      if (outputNorms[o] === gtNorm) {
        consumed[o] = true;
        matchedAt[g] = o;
        break;
      }
    }
  }
  // pass 2: output block contains the whole GT block (merged output)
  for (let g = 0; g < gtNorms.length; g++) {
    if (matchedAt[g]! >= 0) continue;
    const gtNorm = gtNorms[g]!;
    if (gtNorm.length < MIN_CONTAINMENT_CHARS) continue;
    for (let o = 0; o < outputNorms.length; o++) {
      const outNorm = outputNorms[o]!;
      if (outNorm.length === 0 || outNorm.length <= gtNorm.length) continue;
      if (!containmentPossible(gtNorm, outNorm)) continue;
      if (outNorm.includes(gtNorm)) {
        matchedAt[g] = o;
        break;
      }
    }
  }
  // pass 3: output block is a fragment of the GT block (line-wrap fragmentation);
  // first fragment claims the GT position, later fragments of the same block are ignored
  for (let g = 0; g < gtNorms.length; g++) {
    if (matchedAt[g]! >= 0) continue;
    const gtNorm = gtNorms[g]!;
    if (gtNorm.length < MIN_CONTAINMENT_CHARS) continue;
    for (let o = 0; o < outputNorms.length; o++) {
      if (consumed[o]) continue;
      const outNorm = outputNorms[o]!;
      if (outNorm.length < MIN_CONTAINMENT_CHARS || outNorm.length >= gtNorm.length) continue;
      if (!containmentPossible(outNorm, gtNorm)) continue;
      if (gtNorm.includes(outNorm)) {
        consumed[o] = true;
        matchedAt[g] = o;
        break;
      }
    }
  }

  const matches: BlockMatch[] = [];
  for (let g = 0; g < matchedAt.length; g++) {
    if (matchedAt[g]! >= 0) matches.push({ gtIndex: g, outputGlobalIndex: matchedAt[g]!, pageIndex: blocks[matchedAt[g]!]!.pageIndex });
  }
  return matches;
}

/**
 * Ordered-pair accuracy over matched pairs. Pairs whose two GT blocks landed in
 * the SAME output block are unresolvable (merged output) and excluded from the
 * comparable denominator instead of being silently counted wrong.
 */
export function orderedPairAccuracy(matches: BlockMatch[]): {
  comparablePairs: number;
  correctPairs: number;
  accuracy: number | null;
} {
  const byGt = new Map<number, number>();
  for (const match of matches) byGt.set(match.gtIndex, match.outputGlobalIndex);
  const ordered = [...byGt.entries()].sort((a, b) => a[0] - b[0]).map(([, pos]) => pos);
  let comparable = 0;
  let correct = 0;
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[i] === ordered[j]) continue; // merged into one output block — unresolvable
      comparable++;
      if (ordered[i]! < ordered[j]!) correct++;
    }
  }
  return { comparablePairs: comparable, correctPairs: correct, accuracy: comparable > 0 ? correct / comparable : null };
}

/**
 * Two-column interleaving detection for fixtures whose GT is column-major
 * (all column-0 blocks of a page precede column-1 blocks). A page whose matched
 * blocks contain both columns is degraded when any column-1 match appears
 * before a column-0 match in output order (interleaved or right-first).
 */
export function interleavingAnalysis(
  gtBlocks: GtBlock[],
  matches: BlockMatch[],
): { interleavingDetected: boolean | null; columnMajorPreserved: boolean | null } {
  const hasColumns = gtBlocks.some((block) => block.column !== null);
  if (!hasColumns) return { interleavingDetected: null, columnMajorPreserved: null };

  const ordered = [...matches].sort((a, b) => a.outputGlobalIndex - b.outputGlobalIndex);
  const byPage = new Map<number, Array<number | null>>();
  for (const match of ordered) {
    if (match.pageIndex === null) continue;
    const list = byPage.get(match.pageIndex) ?? [];
    list.push(gtBlocks[match.gtIndex]!.column);
    byPage.set(match.pageIndex, list);
  }

  let anyPageBothColumns = false;
  let allPagesColumnMajor = true;
  for (const columns of byPage.values()) {
    if (!columns.includes(0) || !columns.includes(1)) continue;
    anyPageBothColumns = true;
    if (columns.indexOf(1) < columns.lastIndexOf(0)) allPagesColumnMajor = false;
  }
  if (!anyPageBothColumns) return { interleavingDetected: null, columnMajorPreserved: null };
  return { interleavingDetected: !allPagesColumnMajor, columnMajorPreserved: allPagesColumnMajor };
}

export function evaluateReadingOrder(
  gtBlocks: GtBlock[],
  blocks: OutputBlockRef[],
  claimedAvailable: boolean,
): ReadingOrderResult {
  const matches = matchBlocks(gtBlocks, blocks);
  const pairs = orderedPairAccuracy(matches);
  const interleave = interleavingAnalysis(gtBlocks, matches);
  return {
    claimedAvailable,
    blocksExpected: gtBlocks.length,
    blocksMatched: matches.length,
    matches,
    comparablePairs: pairs.comparablePairs,
    correctPairs: pairs.correctPairs,
    orderedPairAccuracy: pairs.accuracy,
    interleavingDetected: interleave.interleavingDetected,
    columnMajorPreserved: interleave.columnMajorPreserved,
  };
}
