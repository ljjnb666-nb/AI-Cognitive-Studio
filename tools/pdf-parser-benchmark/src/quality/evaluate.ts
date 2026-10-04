import { parseGroundTruth, type GroundTruth } from "../ground-truth.js";
import type { NormalizedOutput } from "../schema.js";
import { computeTextMetrics, normalizeText, outputBlocks, type OutputBlockRef, type TextMetrics } from "./metrics.js";
import { evaluateReadingOrder, matchBlocks } from "./reading-order.js";
import type {
  ContaminationQuality,
  FormulaQuality,
  OcrMetadata,
  OcrQuality,
  PageFidelityQuality,
  QualityReport,
  StructureQuality,
  TableQuality,
  TextQuality,
} from "./schema.js";

/**
 * Deterministic quality evaluator (Phase 2B spec #4–#14). Pure function of
 * (ground truth, normalized parser output) — no LLM scoring, no randomness.
 * Unsupported capabilities stay null/declared, never fabricated zeros (#10).
 */

const HEADING_KINDS = new Set(["heading", "title", "section-header"]);
const PARAGRAPH_KINDS = new Set(["paragraph", "text", "para", "body", "footnote", "caption", "quote", "list_item"]);
const LIST_KINDS = new Set(["list_item", "list", "list-item"]);
const TABLE_KINDS = new Set(["table"]);
const FIGURE_KINDS = new Set(["figure", "image", "picture"]);
const EQUATION_KINDS = new Set(["equation", "formula"]);

/** bbox sanity: finite values inside the page rect with a small tolerance. */
const BBOX_TOLERANCE = 2;
const BBOX_WILD_FACTOR = 2;

function fuzzyContains(haystackNorm: string, needleNorm: string): boolean {
  if (needleNorm.length === 0) return false;
  return haystackNorm.includes(needleNorm);
}

export function evaluateStructure(gt: GroundTruth, blocks: OutputBlockRef[]): StructureQuality {
  const fullText = normalizeText(blocks.map((b) => b.text).join(""));

  let headingsDetected = 0;
  let headingsWrongKind = 0;
  let headingsMissed = 0;
  for (const heading of gt.headings) {
    const norm = normalizeText(heading.text);
    const asHeading = blocks.some((b) => HEADING_KINDS.has(b.kind) && fuzzyContains(normalizeText(b.text), norm));
    if (asHeading) {
      headingsDetected++;
      continue;
    }
    const present = fuzzyContains(fullText, norm);
    if (present) headingsWrongKind++;
    else headingsMissed++;
  }

  const paragraphTargets = gt.blocks.filter((b) => b.role === "paragraph" || b.role === "list_item");
  const matchedParagraphBlocks = paragraphTargets.filter((target) => {
    const norm = normalizeText(target.text);
    return norm.length >= 8 && blocks.some((b) => PARAGRAPH_KINDS.has(b.kind) && normalizeText(b.text).includes(norm));
  }).length;

  let listItemsMatched = 0;
  let listItemsExpected = 0;
  for (const list of gt.lists) {
    listItemsExpected += list.items.length;
    for (const item of list.items) {
      const norm = normalizeText(item);
      if (blocks.some((b) => LIST_KINDS.has(b.kind) && normalizeText(b.text).includes(norm))) listItemsMatched++;
    }
  }

  const figuresExpected = gt.blocks.filter((b) => b.role === "figure").length;
  const figuresDetected = figuresExpected === 0 ? 0 : blocks.filter((b) => FIGURE_KINDS.has(b.kind)).length;

  return {
    headings: {
      expected: gt.headings.length,
      detectedAsHeading: headingsDetected,
      textPresentWrongKind: headingsWrongKind,
      missed: headingsMissed,
    },
    paragraphsExpected: paragraphTargets.length,
    paragraphBlocksMatched: matchedParagraphBlocks,
    listItemsExpected,
    listItemsMatchedAsListItem: listItemsMatched,
    figuresExpected,
    figuresDetected,
  };
}

export function evaluatePageFidelity(gt: GroundTruth, normalized: NormalizedOutput, blocks: OutputBlockRef[]): PageFidelityQuality {
  const pagesWithPageIndex = normalized.pages.filter((p) => Number.isInteger(p.pageIndex)).length;
  const withPage = blocks.filter((b) => b.pageIndex !== null && Number.isInteger(b.pageIndex));

  // Block → page ownership via reading-order matching (spec #11): matches map
  // output blocks to GT blocks with known pages. Order-based consumption keeps
  // cross-page duplicate text attributed to the right page, unlike naive
  // containment lookup, which mis-attributes every repeated line to page 0.
  let correct = 0;
  let mismatched = 0;
  if (gt.blocks.length > 0 && withPage.length > 0) {
    const matches = matchBlocks(gt.blocks, blocks);
    for (const match of matches) {
      const block = blocks[match.outputGlobalIndex]!;
      if (block.pageIndex === null || !Number.isInteger(block.pageIndex)) continue;
      const expectedPage = gt.blocks[match.gtIndex]!.page;
      if (block.pageIndex === expectedPage) correct++;
      else mismatched++;
    }
  }

  let totalBbox = 0;
  let bboxWithin = 0;
  let bboxWild = 0;
  for (const page of normalized.pages) {
    for (const block of page.blocks) {
      if (!block.bbox) continue;
      totalBbox++;
      const { x0, y0, x1, y1 } = block.bbox;
      const finite = [x0, y0, x1, y1].every((v) => Number.isFinite(v));
      if (!finite) {
        bboxWild++;
        continue;
      }
      const within =
        x0 >= -BBOX_TOLERANCE &&
        y0 >= -BBOX_TOLERANCE &&
        x1 <= gt.pageSize.width + BBOX_TOLERANCE &&
        y1 <= gt.pageSize.height + BBOX_TOLERANCE &&
        x1 > x0 &&
        y1 > y0;
      const wild =
        x0 < -BBOX_WILD_FACTOR * gt.pageSize.width ||
        y0 < -BBOX_WILD_FACTOR * gt.pageSize.height ||
        x1 > BBOX_WILD_FACTOR * gt.pageSize.width ||
        y1 > BBOX_WILD_FACTOR * gt.pageSize.height ||
        x1 <= x0 ||
        y1 <= y0;
      if (wild) bboxWild++;
      else if (within) bboxWithin++;
    }
  }
  const bboxSupported = totalBbox > 0;

  return {
    pagesExpected: gt.pages,
    outputPages: normalized.pages.length,
    blocksWithPageIndex: withPage.length > 0 || pagesWithPageIndex > 0 ? withPage.length : null,
    pageIndexCorrect: withPage.length > 0 ? correct : null,
    pageIndexMismatched: withPage.length > 0 ? mismatched : null,
    pageIndexAccuracy: correct + mismatched > 0 ? correct / (correct + mismatched) : null,
    bboxSupported,
    bboxBlocks: bboxSupported ? totalBbox : null,
    bboxWithinPageBounds: bboxSupported ? bboxWithin : null,
    bboxWildlyInvalid: bboxSupported ? bboxWild : null,
  };
}

export function evaluateTables(gt: GroundTruth, blocks: OutputBlockRef[], fullTextNorm: string): TableQuality {
  if (gt.tables.length === 0) {
    return {
      tablesExpected: 0,
      structuralTablesDetected: 0,
      cellTextsExpected: 0,
      cellTextsRecoveredStructural: 0,
      cellTextsRecoveredInPlainText: 0,
      cellTextsMissing: 0,
      flattenedToText: null,
      rowOrderPreserved: null,
    };
  }

  const tableBlocks = blocks.filter((b) => TABLE_KINDS.has(b.kind));
  const tableBlockNorms = tableBlocks.map((b) => normalizeText(b.text));
  let cellsExpected = 0;
  let cellsStructural = 0;
  let cellsPlainText = 0;
  let cellsMissing = 0;
  let rowOrderAllPreserved = true;
  let rowOrderChecked = false;

  for (const table of gt.tables) {
    // match the most-plausible structural table block (max cell hits)
    let bestStructural = "";
    if (tableBlocks.length > 0) {
      let bestHits = -1;
      for (const norm of tableBlockNorms) {
        const hits = table.cells.flat().filter((cell) => cell.length > 0 && norm.includes(normalizeText(cell))).length;
        if (hits > bestHits) {
          bestHits = hits;
          bestStructural = norm;
        }
      }
    }
    let previousFirstCellPos = -1;
    for (const row of table.cells) {
      for (const cell of row) {
        const norm = normalizeText(cell);
        if (cell.length === 0) {
          // empty cells are only verifiable structurally
          if (bestStructural.length > 0) cellsStructural++;
          cellsExpected++;
          continue;
        }
        cellsExpected++;
        if (bestStructural.length > 0 && bestStructural.includes(norm)) {
          cellsStructural++;
          continue;
        }
        const at = fullTextNorm.indexOf(norm);
        if (at >= 0) {
          cellsPlainText++;
          // row-order check on the first column, plain-text positions
          if (norm === normalizeText(row[0] ?? "")) {
            rowOrderChecked = true;
            if (at < previousFirstCellPos) rowOrderAllPreserved = false;
            else previousFirstCellPos = at;
          }
        } else {
          cellsMissing++;
        }
      }
    }
  }

  const structuralDetected = tableBlocks.length > 0
    ? gt.tables.filter((table) => {
        const nonEmpty = table.cells.flat().filter((cell) => cell.length > 0).length;
        return tableBlockNorms.some((candidate) => {
          const hits = table.cells.flat().filter((cell) => cell.length > 0 && candidate.includes(normalizeText(cell))).length;
          return hits >= Math.max(2, Math.ceil(nonEmpty / 2));
        });
      }).length
    : 0;
  const anyStructural = structuralDetected > 0;
  const allCellsAccounted = cellsStructural + cellsPlainText + cellsMissing === cellsExpected;
  const flattened = !anyStructural && cellsPlainText > 0 && allCellsAccounted;

  return {
    tablesExpected: gt.tables.length,
    structuralTablesDetected: structuralDetected,
    cellTextsExpected: cellsExpected,
    cellTextsRecoveredStructural: cellsStructural,
    cellTextsRecoveredInPlainText: cellsPlainText,
    cellTextsMissing: cellsMissing,
    flattenedToText: flattened,
    rowOrderPreserved: rowOrderChecked ? rowOrderAllPreserved : null,
  };
}

export function evaluateFormulas(gt: GroundTruth, blocks: OutputBlockRef[], fullTextNorm: string): FormulaQuality {
  const equationKindSeen = blocks.some((b) => EQUATION_KINDS.has(b.kind));
  let structural = 0;
  let asText = 0;
  let dropped = 0;
  let corrupted = 0;
  for (const formula of gt.formulas) {
    const norm = normalizeText(formula.text);
    const asEquation = blocks.some((b) => EQUATION_KINDS.has(b.kind) && normalizeText(b.text).includes(norm));
    if (asEquation) {
      structural++;
      continue;
    }
    if (fuzzyContains(fullTextNorm, norm)) asText++;
    else {
      // partially present = corrupted rather than dropped
      const probe = norm.slice(Math.floor(norm.length / 3), Math.floor(norm.length / 3) + 8);
      if (probe.length >= 4 && fullTextNorm.includes(probe)) corrupted++;
      else dropped++;
    }
  }
  return {
    formulasExpected: gt.formulas.length,
    detectedStructural: structural,
    preservedAsText: asText,
    dropped,
    corrupted,
    structuralEquationKindSeenInRun: equationKindSeen,
  };
}

export function evaluateContamination(gt: GroundTruth, blocks: OutputBlockRef[]): ContaminationQuality {
  const fullTextNorm = normalizeText(blocks.map((b) => b.text).join(""));
  let occurrences = 0;
  let noiseChars = 0;
  for (const noise of gt.noise) {
    const norm = normalizeText(noise.text);
    if (!norm) continue;
    let from = 0;
    for (;;) {
      const at = fullTextNorm.indexOf(norm, from);
      if (at < 0) break;
      occurrences++;
      noiseChars += norm.length;
      from = at + norm.length;
    }
  }
  const noiseRoleBlocks = blocks.filter((b) => {
    const norm = normalizeText(b.text);
    return gt.noise.some((n) => norm === normalizeText(n.text) || (norm.length > 0 && normalizeText(n.text).length > 0 && norm.includes(normalizeText(n.text))));
  }).length;
  const actualChars = normalizeText(blocks.map((b) => b.text).join("")).length;
  return {
    noiseSources: gt.noise.length,
    noiseOccurrences: occurrences,
    noiseCharRatio: actualChars > 0 ? noiseChars / actualChars : 0,
    repeatedNoiseBlocks: noiseRoleBlocks,
  };
}

export function evaluateOcr(
  gt: GroundTruth,
  blocks: OutputBlockRef[],
  textMetrics: TextMetrics,
  metadata: OcrMetadata | null,
): OcrQuality {
  if (!gt.ocrRequired) {
    return {
      required: false,
      charRecall: null,
      charPrecision: null,
      editDistance: null,
      trigramRecall: null,
      keyPhrasesExpected: 0,
      keyPhrasesRecovered: 0,
      pageCoverage: null,
      metadata,
    };
  }
  const fullTextNorm = normalizeText(blocks.map((b) => b.text).join(""));
  const recovered = gt.ocrKeyPhrases.filter((entry) => fullTextNorm.includes(normalizeText(entry.phrase))).length;
  const pagesWithText = new Set(blocks.filter((b) => normalizeText(b.text).length >= 4 && b.pageIndex !== null).map((b) => b.pageIndex));
  const scannedPages = gt.ocrRequiredPages.length > 0 ? gt.ocrRequiredPages : [];
  let covered = 0;
  for (const page of scannedPages) if (pagesWithText.has(page)) covered++;
  return {
    required: true,
    charRecall: textMetrics.charRecall,
    charPrecision: textMetrics.charPrecision,
    editDistance: textMetrics.editDistance,
    trigramRecall: textMetrics.trigramRecall,
    keyPhrasesExpected: gt.ocrKeyPhrases.length,
    keyPhrasesRecovered: recovered,
    pageCoverage: scannedPages.length > 0 ? covered / scannedPages.length : null,
    metadata,
  };
}

export type EvaluateInput = {
  runId: string;
  fixtureId: string;
  parserKey: string;
  parserMode: string;
  groundTruth: GroundTruth;
  normalized: NormalizedOutput;
  ocrMetadata: OcrMetadata | null;
};

/** Pure evaluation — throws on any malformed input; the harness converts throws to QUALITY_EVALUATION_FAILED. */
export function evaluateQuality(input: EvaluateInput): QualityReport {
  // defense in depth (spec #19): a malformed ground truth must never yield
  // fabricated metrics — schema validation happens again at the evaluator gate.
  const gt = parseGroundTruth(input.groundTruth);
  const normalized = input.normalized;
  const blocks = outputBlocks(normalized);
  const fullTextNorm = normalizeText(blocks.map((b) => b.text).join(""));

  const text = computeTextMetrics(gt, blocks);
  const readingOrder = evaluateReadingOrder(gt.blocks, blocks, normalized.readingOrderAvailable);
  const structure = evaluateStructure(gt, blocks);
  const pages = evaluatePageFidelity(gt, normalized, blocks);
  const table = evaluateTables(gt, blocks, fullTextNorm);
  const formula = evaluateFormulas(gt, blocks, fullTextNorm);
  const ocr = evaluateOcr(gt, blocks, text, input.ocrMetadata);
  const contamination = evaluateContamination(gt, blocks);

  const textQuality: TextQuality = {
    expectedChars: text.expectedChars,
    actualChars: text.actualChars,
    charRecall: text.charRecall,
    charPrecision: text.charPrecision,
    editDistance: text.editDistance,
    editDistanceAvailable: text.editDistanceAvailable,
    trigramRecall: text.trigramRecall,
    duplicateRatio: text.duplicateRatio,
    unexpectedRatio: text.unexpectedRatio,
    missingKeyMarkers: text.missingKeyMarkers,
  };

  return {
    evaluatorVersion: "pdf-quality-eval-v2",
    runId: input.runId,
    fixtureId: input.fixtureId,
    parserKey: input.parserKey,
    parserMode: input.parserMode,
    status: "EVALUATED",
    error: null,
    evaluatedAt: new Date().toISOString(),
    text: textQuality,
    readingOrder: {
      claimedAvailable: readingOrder.claimedAvailable,
      blocksExpected: readingOrder.blocksExpected,
      blocksMatched: readingOrder.blocksMatched,
      comparablePairs: readingOrder.comparablePairs,
      correctPairs: readingOrder.correctPairs,
      orderedPairAccuracy: readingOrder.orderedPairAccuracy,
      interleavingDetected: readingOrder.interleavingDetected,
      columnMajorPreserved: readingOrder.columnMajorPreserved,
    },
    structure,
    pages,
    table,
    formula,
    ocr,
    contamination,
  };
}
