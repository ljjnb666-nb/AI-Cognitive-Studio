import { isUtf16Boundary, validateSourceSpan } from "@ai-cognitive/domain";
import { describe, expect, it, vi } from "vitest";
import { parseDocument, type Parsed } from "../src/document-parsers.js";

// Real pdfjs child processes are spawned per PDF parse; the default 5s unit
// budget is too tight under CI load.
vi.setConfig({ testTimeout: 30_000 });
import { buildDiagnosticAnchors, classifyDivergence } from "./helpers/cross-format/classifier.js";
import {
  BOOK_A_SEGMENTS,
  bookAEpubSpine,
  bookAPdfPages,
  buildEpub,
  buildPdf,
  type EpubSpineDoc,
  type FixtureSpec,
} from "./helpers/cross-format/fixtures.js";
import {
  evaluateCrossFormat,
  verifyProvenanceAndReconstruction,
  type ParsedSide,
} from "./helpers/cross-format/gate.js";
import {
  buildComparisonSegment,
  buildCrossFormatView,
  normalizeForComparison,
  verifySegmentReconstruction,
  type ComparableBlock,
} from "./helpers/cross-format/normalization.js";

// ---------------------------------------------------------------------------
// Harness: real production parsers, in-memory results, no database.
// ---------------------------------------------------------------------------

function toSide(parsed: Parsed): ParsedSide {
  const blocks = parsed.pages
    .flatMap((page) => page.blocks)
    .map((block, ordinal) => ({ ordinal, kind: block.kind, text: block.text, locator: block.locator, provenance: block.provenance }));
  return { blocks, textsByOrdinal: new Map(blocks.map((block) => [block.ordinal, block.text])) };
}

async function evaluateFixture(spec: FixtureSpec) {
  const [parsedPdf, parsedEpub] = await Promise.all([
    parseDocument(await buildPdf(spec.pdfPages), "application/pdf"),
    parseDocument(buildEpub(spec.epubSpine, spec.extraArchiveEntries), "application/epub+zip"),
  ]);
  const pdf = toSide(parsedPdf);
  const epub = toSide(parsedEpub);
  return {
    pdf,
    epub,
    streams: {
      pdf: buildCrossFormatView(pdf.blocks).normalizedStream,
      epub: buildCrossFormatView(epub.blocks).normalizedStream,
    },
    result: evaluateCrossFormat(pdf, epub, { includeTables: spec.includeTables, pdfComplete: spec.pdfComplete, epubComplete: spec.epubComplete }),
    provenance: verifyProvenanceAndReconstruction(pdf, epub, { includeTables: spec.includeTables }),
  };
}

function blockTexts(side: ParsedSide): string[] {
  return side.blocks.map((block) => block.text);
}

// ---------------------------------------------------------------------------
// Recorded PDF fidelity probe (BOOK-03B FIRST TASK, empirical evidence).
// ---------------------------------------------------------------------------

describe("PDF fidelity probe (recorded empirical evidence)", () => {
  it("keeps one-text-per-page text exact through the production parser", async () => {
    const parsed = await parseDocument(
      await buildPdf([["Chapter One"], ["First body sentence."], ["Second body sentence."]]),
      "application/pdf",
    );
    expect(blockTexts(toSide(parsed))).toEqual(["Chapter One", "First body sentence.", "Second body sentence."]);
  });

  it("documents that line breaks are dropped without separator (glue)", async () => {
    const multiCall = await parseDocument(await buildPdf([["Chapter One", "First body sentence."]]), "application/pdf");
    expect(blockTexts(toSide(multiCall))).toEqual(["Chapter OneFirst body sentence."]);
    const embeddedLf = await parseDocument(await buildPdf([["Alpha Beta\nGamma Delta"]]), "application/pdf");
    expect(blockTexts(toSide(embeddedLf))).toEqual(["Alpha BetaGamma Delta"]);
  });

  it("documents NBSP→U+0020 and U+00AD→U+002D on the production PDF path", async () => {
    const parsed = await parseDocument(await buildPdf([["Alpha\u00a0Beta", "in\u00adput"]]), "application/pdf");
    const texts = blockTexts(toSide(parsed));
    expect(texts).toEqual(["Alpha Betain-put"]);
    expect(texts[0]).not.toContain("\u00a0");
    expect(texts[0]).toContain("\u002d");
  });
});

// ---------------------------------------------------------------------------
// Normalization rules N1–N7 (deterministic only; forbidden rules absent).
// ---------------------------------------------------------------------------

describe("comparison normalization v1", () => {
  it("applies N1 NFC composition", () => {
    expect(normalizeForComparison("cafe\u0301")).toBe("caf\u00e9");
  });

  it("applies N2 CRLF/CR to LF", () => {
    expect(normalizeForComparison("a\r\nb\rc")).toBe("a b c");
  });

  it("applies N3 NBSP to space", () => {
    expect(normalizeForComparison("a\u00a0b")).toBe("a b");
  });

  it("applies N4 whitespace runs to one space", () => {
    expect(normalizeForComparison("a \t\n\u000bb")).toBe("a b");
  });

  it("applies N5 soft hyphen removal", () => {
    expect(normalizeForComparison("in\u00adput")).toBe("input");
  });

  it("applies N6 leading BOM strip", () => {
    expect(normalizeForComparison("\uFEFFabc")).toBe("abc");
  });

  it("applies N7 boundary trimming", () => {
    expect(normalizeForComparison("  abc\t")).toBe("abc");
  });

  it("never applies forbidden normalization", () => {
    expect(normalizeForComparison("ABC")).toBe("ABC");
    expect(normalizeForComparison("don’t — stop")).toBe("don’t — stop");
    expect(normalizeForComparison("a-b")).toBe("a-b");
    expect(normalizeForComparison("a—b")).not.toBe(normalizeForComparison("a-b"));
  });
});

// ---------------------------------------------------------------------------
// Segment/fragment invariants: original UTF-16 offsets, surrogate safety,
// reconstruction from source truth.
// ---------------------------------------------------------------------------

describe("segment reconstruction and UTF-16 invariants", () => {
  const invariants = (blocks: ComparableBlock[]) => {
    const byOrdinal = new Map(blocks.map((block) => [block.ordinal, block]));
    const view = buildCrossFormatView(blocks);
    for (const segment of view.segments) {
      expect(verifySegmentReconstruction(segment, byOrdinal)).toBeNull();
      for (const fragment of segment.sourceFragments) {
        const block = byOrdinal.get(fragment.blockOrdinal)!;
        expect(isUtf16Boundary(block.text, fragment.startOffset)).toBe(true);
        expect(isUtf16Boundary(block.text, fragment.endOffset)).toBe(true);
        expect(validateSourceSpan(block.text, fragment.startOffset, fragment.endOffset, block.text.slice(fragment.startOffset, fragment.endOffset))).toBe(true);
      }
    }
    return view;
  };

  it("keeps emoji/surrogate blocks fragment-safe and reconstructable", () => {
    const blocks: ComparableBlock[] = [
      { ordinal: 0, kind: "PARAGRAPH", text: "A😀B 中文标题 C🚀D" },
      { ordinal: 1, kind: "HEADING", text: "第二节 🧠" },
    ];
    const view = invariants(blocks);
    expect(view.segments).toHaveLength(2);
    expect(view.normalizedStream).toBe("A😀B 中文标题 C🚀D第二节 🧠");
  });

  it("removes soft hyphens while keeping reconstruction exact", () => {
    const blocks: ComparableBlock[] = [{ ordinal: 0, kind: "PARAGRAPH", text: "as\u00ADsign­ment grade" }];
    const view = invariants(blocks);
    expect(view.normalizedStream).toBe("assignment grade");
  });

  it("handles BOM, CRLF, NBSP combinations deterministically", () => {
    const segment = buildComparisonSegment(0, "\uFEFFAlpha\r\nBeta\u00a0Gamma", "PARAGRAPH");
    expect(segment.normalizedText).toBe("Alpha Beta Gamma");
    expect(verifySegmentReconstruction(segment, new Map([[0, { ordinal: 0, kind: "PARAGRAPH", text: "\uFEFFAlpha\r\nBeta\u00a0Gamma" }]]))).toBeNull();
  });

  it("makes different segmentations of one book produce identical streams", () => {
    const one = invariants([{ ordinal: 0, kind: "PARAGRAPH", text: "One.Two.Three." }]);
    const many = invariants([
      { ordinal: 0, kind: "PARAGRAPH", text: "One." },
      { ordinal: 1, kind: "PARAGRAPH", text: "Two." },
      { ordinal: 2, kind: "PARAGRAPH", text: "Three." },
    ]);
    expect(one.normalizedStream).toBe(many.normalizedStream);
    expect(one.segments).toHaveLength(1);
    expect(many.segments).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Diagnostic classifier (anchors are diagnostic-only, nothing may disappear).
// ---------------------------------------------------------------------------

describe("diagnostic classifier", () => {
  it("emits TAIL_TRUNCATED for a prefix when the tail belongs to the expected source", () => {
    const diagnosis = classifyDivergence("Alpha.Beta.Gamma.", "Alpha.Beta.", { pdfComplete: true, epubComplete: false });
    expect(diagnosis.code).toBe("CROSS_FORMAT_TAIL_TRUNCATED");
  });

  it("emits CONTENT_MISSING when a middle segment vanishes", () => {
    const diagnosis = classifyDivergence("Alpha.Beta.Gamma.", "Alpha.Gamma.", { pdfComplete: true, epubComplete: true });
    expect(diagnosis.code).toBe("CROSS_FORMAT_CONTENT_MISSING");
    expect(diagnosis.anchorsOnlyInPdf).toEqual(["Beta."]);
  });

  it("emits CONTENT_DUPLICATED for a repeated segment", () => {
    const diagnosis = classifyDivergence("Alpha.Beta.", "Alpha.Beta.Beta.", { pdfComplete: true, epubComplete: true });
    expect(diagnosis.code).toBe("CROSS_FORMAT_CONTENT_DUPLICATED");
  });

  it("emits ORDER_MISMATCH for an equal-multiset permutation", () => {
    const diagnosis = classifyDivergence("Alpha.Beta.Gamma.", "Alpha.Gamma.Beta.", { pdfComplete: true, epubComplete: true });
    expect(diagnosis.code).toBe("CROSS_FORMAT_ORDER_MISMATCH");
  });

  it("emits EXTRA_CONTENT for unexpected inserted content", () => {
    const diagnosis = classifyDivergence("Alpha.", "Alpha.Xyzzy.", { pdfComplete: true, epubComplete: true });
    expect(diagnosis.code).toBe("CROSS_FORMAT_EXTRA_CONTENT");
  });

  it("keeps short content represented: anchors never filter by length", () => {
    const stream = "Preface.Chapter OneThe body.";
    const anchors = buildDiagnosticAnchors(stream);
    const nonWhitespace = (value: string) => [...value.replace(/\s+/g, "")].sort().join("");
    expect(nonWhitespace(anchors.join(""))).toBe(nonWhitespace(stream));
    expect(anchors).toContain("Preface.");
  });
});

// ---------------------------------------------------------------------------
// Positive fixtures (real production parsers both sides).
// ---------------------------------------------------------------------------

describe("positive cross-format fixtures", () => {
  it("BASIC_REFLOWABLE: content PASS with page/spine boundaries cutting differently", async () => {
    const { result, provenance } = await evaluateFixture({
      id: "basic-reflowable",
      pdfPages: bookAPdfPages(),
      epubSpine: bookAEpubSpine(),
    });
    expect(result.content).toEqual({ status: "PASS" });
    expect(result.structure).toMatchObject({ status: "NOT_COMPARABLE", code: "CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE" });
    expect(provenance).toEqual({ status: "PASS" });
  });

  it("UNICODE: NBSP, accents, dashes and curly quotes compare PASS; provenance stays format-native", async () => {
    const { result, provenance, pdf, epub } = await evaluateFixture({
      id: "unicode",
      pdfPages: [["R\u00e9sum\u00e9 of facts.", "Alpha\u00a0Beta spaced."], ["a\u2014b \u201cquoted\u201d — dash."]],
      epubSpine: [
        { href: "u1.xhtml", body: "<p>R\u00e9sum\u00e9 of facts.</p><p>Alpha&nbsp;Beta spaced.</p>" },
        { href: "u2.xhtml", body: "<p>a\u2014b \u201cquoted\u201d — dash.</p>" },
      ],
    });
    expect(result.content).toEqual({ status: "PASS" });
    expect(provenance).toEqual({ status: "PASS" });
    const pdfBlock = pdf.blocks[0]!;
    expect(pdfBlock.locator).toMatchObject({ kind: "pdf", physicalPageIndex: 0, printedPageLabel: null });
    expect(pdfBlock.provenance).toEqual({ sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" });
    const epubBlock = epub.blocks[0]!;
    expect(epubBlock.locator).toMatchObject({ kind: "epub", spineIndex: 0, href: "OPS/u1.xhtml" });
    expect((epubBlock.locator as { elementPath?: string }).elementPath).toBeTruthy();
    expect(epubBlock.provenance).toEqual({ sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" });
  });

  it("DIFFERENT_SEGMENTATION: content PASS with 1 PDF block vs 3 EPUB blocks", async () => {
    const linear = "First body sentence.Second body sentence.Third body sentence.";
    const { result, pdf, epub } = await evaluateFixture({
      id: "different-segmentation",
      pdfPages: [[linear]],
      epubSpine: [{ href: "seg.xhtml", body: "<p>First body sentence.</p><p>Second body sentence.</p><p>Third body sentence.</p>" }],
    });
    expect(result.content).toEqual({ status: "PASS" });
    expect(pdf.blocks).toHaveLength(1);
    expect(epub.blocks).toHaveLength(3);
  });

  it("STRUCTURE_ASYMMETRY: content PASS, structure NOT_COMPARABLE (headings EPUB-only)", async () => {
    const s = BOOK_A_SEGMENTS;
    const { result } = await evaluateFixture({
      id: "structure-asymmetry",
      pdfPages: bookAPdfPages(),
      epubSpine: [
        { href: "c1.xhtml", body: `<h1>${s.preface}</h1><h1>${s.chapterOne}</h1><p>${s.chapterOneBody[0]!}</p><p>${s.chapterOneBody[1]!}</p>` },
        { href: "c2.xhtml", body: `<h1>${s.chapterTwo}</h1><p>${s.middlePassage}</p>`, epubNamespaces: true },
        { href: "c3.xhtml", body: `<h1>${s.chapterThree}</h1><p>${s.finalPassage}</p>` },
      ],
    });
    expect(result.content).toEqual({ status: "PASS" });
    expect(result.structure).toMatchObject({ status: "NOT_COMPARABLE", code: "CROSS_FORMAT_STRUCTURE_NOT_COMPARABLE" });
  });

  it("SIMPLE_TABLE: lexical content PASS with opt-in, table geometry NOT_COMPARABLE", async () => {
    const { result } = await evaluateFixture({
      id: "simple-table",
      pdfPages: [["Table follows.", "R1C1 R1C2 R2C1 R2C2"]],
      epubSpine: [{ href: "t.xhtml", body: "<p>Table follows.</p><table><tr><td>R1C1</td><td>R1C2</td></tr><tr><td>R2C1</td><td>R2C2</td></tr></table>" }],
      includeTables: true,
    });
    expect(result.content).toEqual({ status: "PASS" });
    expect(result.features.tableGeometry).toMatchObject({ status: "NOT_COMPARABLE" });
  });

  it("structure helper: equal heading sequences PASS, divergent sequences FAIL", () => {
    const headings = (texts: string[]): ParsedSide["blocks"] => texts.map((text, ordinal) => ({ ordinal, kind: "HEADING", text }));
    const both = evaluateCrossFormat(
      { blocks: headings(["One.", "Two."]), textsByOrdinal: new Map() },
      { blocks: headings(["One.", "Two."]), textsByOrdinal: new Map() },
    );
    expect(both.structure).toEqual({ status: "PASS" });
    const divergent = evaluateCrossFormat(
      { blocks: headings(["One.", "Two."]), textsByOrdinal: new Map() },
      { blocks: headings(["Two.", "One."]), textsByOrdinal: new Map() },
    );
    expect(divergent.structure).toMatchObject({ status: "FAIL", code: "CROSS_FORMAT_STRUCTURE_MISMATCH" });
  });
});

// ---------------------------------------------------------------------------
// Not-comparable fixtures: asymmetric special-kind evidence must never PASS.
// ---------------------------------------------------------------------------

describe("not-comparable cross-format fixtures", () => {
  it("FOOTNOTE_ASYMMETRY: relocation equivalence is NOT claimed", async () => {
    const { result } = await evaluateFixture({
      id: "footnote-asymmetry",
      pdfPages: [["Body text with a note."]],
      epubSpine: [{ href: "f.xhtml", body: '<p>Body text with a note.</p><p epub:type="footnote">The note explains the body.</p>', epubNamespaces: true }],
    });
    expect(result.content).toMatchObject({ status: "NOT_COMPARABLE", code: "CROSS_FORMAT_CONTENT_NOT_COMPARABLE" });
    expect(result.features.footnotes.status).toBe("NOT_COMPARABLE");
    expect(result.content.status).not.toBe("PASS");
  });

  it("EQUATION_ASYMMETRY: equation evidence is NOT_COMPARABLE", async () => {
    const { result } = await evaluateFixture({
      id: "equation-asymmetry",
      pdfPages: [["Energy equation follows."]],
      epubSpine: [{ href: "e.xhtml", body: '<p>Energy equation follows.</p><math alttext="E equals m c squared"><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math>' }],
    });
    expect(result.content).toMatchObject({ status: "NOT_COMPARABLE", code: "CROSS_FORMAT_CONTENT_NOT_COMPARABLE" });
    expect(result.features.equations.status).toBe("NOT_COMPARABLE");
  });

  it("IMAGE_ACCESSIBILITY_ASYMMETRY: alt-text evidence is NOT_COMPARABLE", async () => {
    const { result } = await evaluateFixture({
      id: "image-asymmetry",
      pdfPages: [["Figure present."]],
      epubSpine: [{ href: "i.xhtml", body: '<p>Figure present.</p><img src="pix.png" alt="A red square"/>' }],
      extraArchiveEntries: [{ name: "OPS/pix.png", text: "\u0089PNG-fixture-bytes" }],
    });
    expect(result.content).toMatchObject({ status: "NOT_COMPARABLE", code: "CROSS_FORMAT_CONTENT_NOT_COMPARABLE" });
    expect(result.features.images.status).toBe("NOT_COMPARABLE");
  });

  it("TABLE without opt-in is uncertifiable rather than silently discarded", async () => {
    const { result } = await evaluateFixture({
      id: "table-no-optin",
      pdfPages: [["R1C1 R1C2 R2C1 R2C2"]],
      epubSpine: [{ href: "t.xhtml", body: "<table><tr><td>R1C1</td><td>R1C2</td></tr><tr><td>R2C1</td><td>R2C2</td></tr></table>" }],
    });
    expect(result.content).toMatchObject({ status: "NOT_COMPARABLE", code: "CROSS_FORMAT_CONTENT_NOT_COMPARABLE" });
  });
});

// ---------------------------------------------------------------------------
// Negative fixtures: the hard full-stream gate must fail each corruption.
// ---------------------------------------------------------------------------

describe("negative cross-format fixtures", () => {
  it("MISSING_CONTENT fails with CROSS_FORMAT_CONTENT_MISSING", async () => {
    const spine = bookAEpubSpine();
    spine[2] = { href: "part3.xhtml", body: `<p>${BOOK_A_SEGMENTS.chapterThree}</p><p>${BOOK_A_SEGMENTS.finalPassage}</p>` };
    const { streams, result } = await evaluateFixture({ id: "missing-content", pdfPages: bookAPdfPages(), epubSpine: spine });
    expect(streams.pdf).not.toBe(streams.epub);
    expect(result.content.status).toBe("FAIL");
    expect(result.content.code).toBe("CROSS_FORMAT_CONTENT_MISSING");
  });

  it("DUPLICATED_CONTENT fails with CROSS_FORMAT_CONTENT_DUPLICATED", async () => {
    const s = BOOK_A_SEGMENTS;
    const spine = bookAEpubSpine();
    spine[0] = { href: "part1.xhtml", body: `<p>${s.preface}</p><p>${s.preface}</p><p>${s.chapterOne}</p><p>${s.chapterOneBody[0]!}</p>` };
    const { streams, result } = await evaluateFixture({ id: "duplicated-content", pdfPages: bookAPdfPages(), epubSpine: spine });
    expect(streams.pdf).not.toBe(streams.epub);
    expect(result.content.status).toBe("FAIL");
    expect(result.content.code).toBe("CROSS_FORMAT_CONTENT_DUPLICATED");
  });

  it("REORDERED_CONTENT fails with CROSS_FORMAT_ORDER_MISMATCH", async () => {
    const s = BOOK_A_SEGMENTS;
    const spine: EpubSpineDoc[] = [
      { href: "part1.xhtml", body: `<p>${s.preface}</p><p>${s.chapterOne}</p><p>${s.chapterOneBody[0]!}</p>` },
      { href: "part2.xhtml", body: `<p>${s.chapterOneBody[1]!}</p><p>${s.chapterThree}</p><p>${s.finalPassage}</p>` },
      { href: "part3.xhtml", body: `<p>${s.chapterTwo}</p><p>${s.middlePassage}</p>` },
    ];
    const { streams, result } = await evaluateFixture({ id: "reordered-content", pdfPages: bookAPdfPages(), epubSpine: spine });
    expect(streams.pdf).not.toBe(streams.epub);
    expect(result.content.status).toBe("FAIL");
    expect(result.content.code).toBe("CROSS_FORMAT_ORDER_MISMATCH");
  });

  it("TAIL_TRUNCATED fails with CROSS_FORMAT_TAIL_TRUNCATED", async () => {
    const s = BOOK_A_SEGMENTS;
    const spine: EpubSpineDoc[] = [
      { href: "part1.xhtml", body: `<p>${s.preface}</p><p>${s.chapterOne}</p><p>${s.chapterOneBody[0]!}</p>` },
      { href: "part2.xhtml", body: `<p>${s.chapterOneBody[1]!}</p><p>${s.chapterTwo}</p>` },
    ];
    const { streams, result } = await evaluateFixture({ id: "tail-truncated", pdfPages: bookAPdfPages(), epubSpine: spine, pdfComplete: true, epubComplete: false });
    expect(streams.epub.length).toBeLessThan(streams.pdf.length);
    expect(streams.pdf.startsWith(streams.epub)).toBe(true);
    expect(result.content.status).toBe("FAIL");
    expect(result.content.code).toBe("CROSS_FORMAT_TAIL_TRUNCATED");
  });

  it("SHORT_CONTENT regression: removing a short segment cannot disappear from the gate", async () => {
    const s = BOOK_A_SEGMENTS;
    const spine: EpubSpineDoc[] = [
      { href: "part1.xhtml", body: `<p>${s.chapterOne}</p><p>${s.chapterOneBody[0]!}</p>` },
      { href: "part2.xhtml", body: `<p>${s.chapterOneBody[1]!}</p><p>${s.chapterTwo}</p>` },
      { href: "part3.xhtml", body: `<p>${s.middlePassage}</p><p>${s.chapterThree}</p><p>${s.finalPassage}</p>` },
    ];
    const { streams, result } = await evaluateFixture({ id: "short-content-missing", pdfPages: bookAPdfPages(), epubSpine: spine });
    expect(streams.pdf).not.toBe(streams.epub);
    expect(result.content.status).toBe("FAIL");
    expect(result.content.code).toBe("CROSS_FORMAT_CONTENT_MISSING");
  });
});

// ---------------------------------------------------------------------------
// Provenance: format-native locators and parser identity on every fixture.
// ---------------------------------------------------------------------------

describe("format-native provenance preservation", () => {
  it("keeps every participating PDF block on a physical pdf locator", async () => {
    const { pdf } = await evaluateFixture({ id: "provenance-pdf", pdfPages: bookAPdfPages(), epubSpine: bookAEpubSpine() });
    for (const block of pdf.blocks) {
      expect(block.locator).toMatchObject({ kind: "pdf" });
      expect(typeof (block.locator as { physicalPageIndex: number }).physicalPageIndex).toBe("number");
      expect(block.provenance).toEqual({ sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" });
    }
  });

  it("keeps every participating EPUB block on a spine epub locator", async () => {
    const { epub } = await evaluateFixture({ id: "provenance-epub", pdfPages: bookAPdfPages(), epubSpine: bookAEpubSpine() });
    for (const block of epub.blocks) {
      const locator = block.locator as { kind: string; spineIndex: number; href: string; elementPath: string };
      expect(locator.kind).toBe("epub");
      expect(typeof locator.spineIndex).toBe("number");
      expect(locator.href).toMatch(/^OPS\//);
      expect(locator.elementPath).toBeTruthy();
      expect(block.provenance).toEqual({ sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" });
    }
  });
});
