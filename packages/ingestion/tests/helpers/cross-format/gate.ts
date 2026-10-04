/**
 * BOOK-INGESTION-03 cross-format gate — TEST-ONLY evaluation entry point.
 *
 * HARD CONTENT AUTHORITY: full normalized stream exact equality. Anchor/LCS
 * diagnostics classify failures but can never override inequality. Semantic
 * features that the PARAGRAPH-only PDF production parser cannot identify
 * symmetrically (FOOTNOTE, EQUATION, IMAGE, and un-opted-in TABLE) force the
 * affected dimension to NOT_COMPARABLE — never a whole-book PASS, never a
 * silent one-sided discard.
 */

import { classifyDivergence } from "./classifier.js";
import { buildCrossFormatView, verifySegmentReconstruction, type ComparableBlock } from "./normalization.js";
import type {
  ComparisonStatus,
  CrossFormatCode,
  CrossFormatGateResult,
  DimensionResult,
} from "./types.js";

export type EvaluatorBlock = ComparableBlock & { locator?: unknown; provenance?: unknown };

export type ParsedSide = {
  blocks: EvaluatorBlock[];
  /** Original block texts by ordinal, for fragment reconstruction proofs. */
  textsByOrdinal: Map<number, string>;
};

const pass: DimensionResult = { status: "PASS" };
const notComparable = (code: CrossFormatCode, detail?: string): DimensionResult => ({ status: "NOT_COMPARABLE", code, detail });
const failure = (code: CrossFormatCode, detail?: string): DimensionResult => ({ status: "FAIL", code, detail });

const PDF_PROVENANCE = { sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" } as const;
const EPUB_PROVENANCE = { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" } as const;

/**
 * Validates that every lexical block retained format-native provenance.
 * Locators are format-native and never compared across formats; provenance
 * identity is checked per side only.
 */
export function validateProvenance(
  side: "pdf" | "epub",
  blocks: EvaluatorBlock[],
): DimensionResult {
  for (const block of blocks) {
    if (side === "pdf" && (block.kind === "IMAGE" || block.kind === "EQUATION" || block.kind === "FOOTNOTE" || block.kind === "UNKNOWN")) {
      return failure("CROSS_FORMAT_PROVENANCE_INVALID", `unexpected kind ${block.kind} from PARAGRAPH-only PDF parser`);
    }
    const provenance = block.provenance as Record<string, unknown> | undefined;
    const expected = side === "pdf" ? PDF_PROVENANCE : EPUB_PROVENANCE;
    if (
      !provenance ||
      provenance.sourceMethod !== expected.sourceMethod ||
      provenance.parserName !== expected.parserName ||
      provenance.parserVersion !== expected.parserVersion
    ) {
      return failure("CROSS_FORMAT_PROVENANCE_INVALID", `block ${block.ordinal} provenance deviates from ${side} parser identity`);
    }
    const locator = block.locator as Record<string, unknown> | undefined;
    if (side === "pdf") {
      if (!locator || locator.kind !== "pdf" || typeof locator.physicalPageIndex !== "number") {
        return failure("CROSS_FORMAT_PROVENANCE_INVALID", `block ${block.ordinal} lacks a physical pdf locator`);
      }
    } else if (!locator || locator.kind !== "epub" || typeof locator.spineIndex !== "number" || typeof locator.href !== "string") {
      return failure("CROSS_FORMAT_PROVENANCE_INVALID", `block ${block.ordinal} lacks a spine epub locator`);
    }
  }
  return { status: "PASS" };
}

export function evaluateCrossFormat(
  pdf: ParsedSide,
  epub: ParsedSide,
  options: { includeTables?: boolean; pdfComplete?: boolean; epubComplete?: boolean } = {},
): CrossFormatGateResult {
  const pdfView = buildCrossFormatView(pdf.blocks, { includeTables: options.includeTables });
  const epubView = buildCrossFormatView(epub.blocks, { includeTables: options.includeTables });

  const content = evaluateContent(pdfView.normalizedStream, epubView.normalizedStream, pdfView, epubView, options);
  const structure = evaluateStructure(pdfView, epubView);
  const features = {
    footnotes: pdfView.capabilities.footnotes || epubView.capabilities.footnotes
      ? notComparable("CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE", "PDF production parser cannot classify footnotes; relocation equivalence is not provable")
      : notComparable("CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE", "no footnote evidence on either side"),
    equations: pdfView.capabilities.equations || epubView.capabilities.equations
      ? notComparable("CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE", "equation representations are format-specific")
      : notComparable("CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE", "no equation evidence on either side"),
    images: pdfView.capabilities.images || epubView.capabilities.images
      ? notComparable("CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE", "accessibility evidence is EPUB-only capability")
      : notComparable("CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE", "no image accessibility evidence on either side"),
    tableGeometry: pdfView.capabilities.tables || epubView.capabilities.tables
      ? notComparable("CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE", "table geometry/2D structure is not comparable; lexical content handled by the content dimension")
      : notComparable("CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE", "no table evidence on either side"),
  };

  return { content, structure, provenance: { status: "PASS" }, features };
}

function evaluateContent(
  pdfStream: string,
  epubStream: string,
  pdfView: ReturnType<typeof buildCrossFormatView>,
  epubView: ReturnType<typeof buildCrossFormatView>,
  options: { includeTables?: boolean; pdfComplete?: boolean; epubComplete?: boolean },
): DimensionResult {
  // Asymmetric special-kind capability makes whole-book lexical equivalence
  // uncertifiable BEFORE anything else: the counterpart blocks on the other
  // side are unidentifiable, so neither a PASS, a discard, nor an
  // empty-stream complaint is honest.
  const uncertifiable: string[] = [];
  if (pdfView.capabilities.footnotes || epubView.capabilities.footnotes) uncertifiable.push("FOOTNOTE");
  if (pdfView.capabilities.equations || epubView.capabilities.equations) uncertifiable.push("EQUATION");
  if (pdfView.capabilities.images || epubView.capabilities.images) uncertifiable.push("IMAGE");
  if (!options.includeTables && (pdfView.capabilities.tables || epubView.capabilities.tables)) uncertifiable.push("TABLE");
  if (uncertifiable.length > 0) {
    return notComparable("CROSS_FORMAT_CONTENT_NOT_COMPARABLE", `asymmetric special-kind evidence: ${uncertifiable.join(", ")}`);
  }
  if (!pdfStream || !epubStream) {
    return failure("CROSS_FORMAT_FIXTURE_INVALID", "one side produced no comparable lexical content");
  }

  if (pdfStream === epubStream) return { status: "PASS" };
  const diagnostics = classifyDivergence(pdfStream, epubStream, {
    pdfComplete: options.pdfComplete ?? true,
    epubComplete: options.epubComplete ?? true,
  });
  return { status: "FAIL", code: diagnostics.code, detail: `pdf=${pdfStream.length} chars, epub=${epubStream.length} chars` };
}

function evaluateStructure(
  pdfView: ReturnType<typeof buildCrossFormatView>,
  epubView: ReturnType<typeof buildCrossFormatView>,
): DimensionResult {
  const pdfHeadings = pdfView.segments.filter((segment) => segment.blockKind === "HEADING").map((segment) => segment.normalizedText);
  const epubHeadings = epubView.segments.filter((segment) => segment.blockKind === "HEADING").map((segment) => segment.normalizedText);
  if (pdfHeadings.length > 0 && epubHeadings.length > 0) {
    const equal = pdfHeadings.length === epubHeadings.length && pdfHeadings.every((heading, index) => heading === epubHeadings[index]);
    return equal ? { status: "PASS" } : failure("CROSS_FORMAT_STRUCTURE_MISMATCH", `pdf=${JSON.stringify(pdfHeadings)} epub=${JSON.stringify(epubHeadings)}`);
  }
  return notComparable(
    "CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE",
    pdfHeadings.length === 0 && epubHeadings.length === 0
      ? "no heading evidence on either side"
      : "heading evidence exists on only one side; PDF typography is never interpreted",
  );
}

/**
 * Full provenance + reconstruction self-check over both parsed sides.
 * Returns the first violation as a failing dimension; PASS otherwise.
 */
export function verifyProvenanceAndReconstruction(
  pdf: ParsedSide,
  epub: ParsedSide,
  options: { includeTables?: boolean } = {},
): DimensionResult {
  const pdfProvenance = validateProvenance("pdf", pdf.blocks);
  if (pdfProvenance.status !== "PASS") return pdfProvenance;
  const epubProvenance = validateProvenance("epub", epub.blocks);
  if (epubProvenance.status !== "PASS") return epubProvenance;

  for (const [label, side] of [["pdf", pdf], ["epub", epub]] as const) {
    const blocksByOrdinal = new Map(side.blocks.map((block) => [block.ordinal, block]));
    const view = buildCrossFormatView(side.blocks, { includeTables: options.includeTables });
    for (const segment of view.segments) {
      const violation = verifySegmentReconstruction(segment, blocksByOrdinal);
      if (violation) return failure("CROSS_FORMAT_PROVENANCE_INVALID", `${label}: ${violation}`);
    }
  }
  return { status: "PASS" };
}

export type { ComparisonStatus };
