import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseEpubExtractionMetadata } from "@ai-cognitive/domain";
import { parseDocument, type Parsed, type ParsedBlock } from "../src/document-parsers.js";
import { SourceError } from "../src/source-errors.js";

// ---------------------------------------------------------------------------
// Deterministic, repo-local EPUB fixtures (synthetic but structurally real).
// ---------------------------------------------------------------------------

type Entry = { name: string; text: string };

function zip(entries: Entry[]): Uint8Array {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), raw = Buffer.from(entry.text), body = deflateRawSync(raw), method = 8;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, body);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(method, 10); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); central.push(record, name); offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
}

const XHTML_NS = 'xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"';
const container = (path = "OEBPS/content.opf") => `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${path}" media-type="application/oebps-package+xml"/></rootfiles></container>`;

function opfDocument({ version = "3.0", manifest, spine, metadata = "" }: { version?: string; manifest: string; spine: string; metadata?: string }): string {
  return `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:book-02</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language>${metadata}</metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
}

type BookInput = { containerText?: string; mimetype?: string; opf?: string; files?: Entry[] };
function book({ containerText = container(), mimetype = "application/epub+zip", opf, files = [] }: BookInput): Uint8Array {
  return zip([{ name: "mimetype", text: mimetype }, { name: "META-INF/container.xml", text: containerText }, ...(opf ? [{ name: "OEBPS/content.opf", text: opf }] : []), ...files]);
}

// The nav document is a manifest item with properties="nav" but intentionally
// stays out of the spine unless a test puts it there explicitly.
const epub3Opf = (extraManifest = "", extraSpine = "", metadata = "") => opfDocument({
  metadata,
  manifest: `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>${extraManifest}`,
  spine: `<itemref idref="c1"/>${extraSpine}`,
});

const navDocument = (body: string) => `<?xml version="1.0"?><html ${XHTML_NS}><head><title>TOC</title></head><body><nav epub:type="toc"><ol>${body}</ol></nav></body></html>`;
const contentDocument = (body: string) => `<?xml version="1.0"?><html ${XHTML_NS}><body>${body}</body></html>`;
const chapterOne = contentDocument("<h1>Alpha</h1><p>First paragraph.</p><p>Second paragraph.</p>");
const basicFiles: Entry[] = [
  { name: "OEBPS/nav.xhtml", text: navDocument('<li><a href="text/ch1.xhtml">Chapter One</a></li>') },
  { name: "OEBPS/text/ch1.xhtml", text: chapterOne },
];

const blocksOf = (parsed: Parsed) => parsed.pages[0]?.blocks ?? [];
const epubLocatorOf = (block: { locator?: ParsedBlock["locator"] }) => (block.locator?.kind === "epub" ? block.locator : undefined);

// ---------------------------------------------------------------------------
// Navigation evidence
// ---------------------------------------------------------------------------

describe("epub-parser-v2 navigation", () => {
  it("detects a valid EPUB3 nav and flattens nested order and depth deterministically", async () => {
    const parsed = await parseDocument(book({ opf: epub3Opf(), files: [
      { name: "OEBPS/nav.xhtml", text: navDocument('<li><a href="text/ch1.xhtml">Part One</a><ol><li><a href="text/ch1.xhtml#s1">Section 1</a></li><li><a href="text/ch1.xhtml#s2">Section 2</a></li></ol></li><li><a href="text/ch1.xhtml#s3">Part Two</a></li>') },
      { name: "OEBPS/text/ch1.xhtml", text: chapterOne },
    ] }), "application/epub+zip");
    const metadata = parseEpubExtractionMetadata(parsed.formatMetadata);
    expect(metadata.navigationSource).toBe("EPUB3_NAV");
    expect(metadata.navigation).toEqual([
      { ordinal: 0, depth: 0, label: "Part One", href: "OEBPS/text/ch1.xhtml", fragmentId: null },
      { ordinal: 1, depth: 1, label: "Section 1", href: "OEBPS/text/ch1.xhtml", fragmentId: "s1" },
      { ordinal: 2, depth: 1, label: "Section 2", href: "OEBPS/text/ch1.xhtml", fragmentId: "s2" },
      { ordinal: 3, depth: 0, label: "Part Two", href: "OEBPS/text/ch1.xhtml", fragmentId: "s3" },
    ]);
    expect(metadata.packagePath).toBe("OEBPS/content.opf");
    expect(metadata.epubVersion).toBe("3.0");
    expect(metadata.spineItemCount).toBe(1);
  });

  it("detects EPUB2 NCX through the spine toc attribute with nested depth", async () => {
    const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap><navPoint id="n1" playOrder="1"><navLabel><text>Part One</text></navLabel><content src="text/ch1.xhtml"/><navPoint id="n2" playOrder="2"><navLabel><text>Section 1</text></navLabel><content src="text/ch1.xhtml#s1"/></navPoint></navPoint></navMap></ncx>`;
    const opf = opfDocument({ version: "2.0", manifest: '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>', spine: '<itemref idref="c1"/>' }).replace("<spine>", '<spine toc="ncx">');
    const parsed = await parseDocument(book({ opf, files: [
      { name: "OEBPS/toc.ncx", text: ncx },
      { name: "OEBPS/text/ch1.xhtml", text: chapterOne },
    ] }), "application/epub+zip");
    const metadata = parseEpubExtractionMetadata(parsed.formatMetadata);
    expect(metadata.navigationSource).toBe("EPUB2_NCX");
    expect(metadata.epubVersion).toBe("2.0");
    expect(metadata.navigation).toEqual([
      { ordinal: 0, depth: 0, label: "Part One", href: "OEBPS/text/ch1.xhtml", fragmentId: null },
      { ordinal: 1, depth: 1, label: "Section 1", href: "OEBPS/text/ch1.xhtml", fragmentId: "s1" },
    ]);
  });

  it("prefers the EPUB3 nav over a coexisting NCX without duplicating entries", async () => {
    const files: Entry[] = [
      { name: "OEBPS/nav.xhtml", text: navDocument('<li><a href="text/ch1.xhtml">Nav Entry</a></li>') },
      { name: "OEBPS/toc.ncx", text: '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="n1"><navLabel><text>NCX Entry</text></navLabel><content src="text/ch1.xhtml"/></navPoint></navMap></ncx>' },
      { name: "OEBPS/text/ch1.xhtml", text: chapterOne },
    ];
    const parsed = await parseDocument(book({ opf: epub3Opf(' extra', ' <itemref idref="ncx"/>').replace('<item id="c1"', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1"'), files }), "application/epub+zip");
    const metadata = parseEpubExtractionMetadata(parsed.formatMetadata);
    expect(metadata.navigationSource).toBe("EPUB3_NAV");
    expect(metadata.navigation.map((entry) => entry.label)).toEqual(["Nav Entry"]);
  });

  it("still parses the body when no navigation exists, without a fabricated warning", async () => {
    const opf = opfDocument({ manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>', spine: '<itemref idref="c1"/>' });
    const parsed = await parseDocument(book({ opf, files: [{ name: "OEBPS/text/ch1.xhtml", text: chapterOne }] }), "application/epub+zip");
    const metadata = parseEpubExtractionMetadata(parsed.formatMetadata);
    expect(metadata.navigationSource).toBe("NONE");
    expect(metadata.navigation).toEqual([]);
    expect(parsed.qualityWarnings).toEqual([]);
    expect(blocksOf(parsed).map((block) => block.text)).toContain("Alpha");
  });

  it("degrades a malformed optional nav to a typed warning instead of failing the book", async () => {
    const parsed = await parseDocument(book({ opf: epub3Opf(), files: [
      { name: "OEBPS/nav.xhtml", text: "<?xml version=\"1.0\"?><html><nav><ol><li><a href=\"text/ch1.xhtml\">Broken" },
      { name: "OEBPS/text/ch1.xhtml", text: chapterOne },
    ] }), "application/epub+zip");
    expect(parseEpubExtractionMetadata(parsed.formatMetadata).navigationSource).toBe("NONE");
    expect(parsed.qualityWarnings).toEqual(["EPUB_NAVIGATION_DEGRADED"]);
    expect(blocksOf(parsed).map((block) => block.text)).toContain("Alpha");
  });

  it("fails closed on unsafe nav targets: external URL and archive-root escape", async () => {
    await expect(parseDocument(book({ opf: epub3Opf(), files: [
      { name: "OEBPS/nav.xhtml", text: navDocument('<li><a href="https://example.test/x">Remote</a></li>') },
      { name: "OEBPS/text/ch1.xhtml", text: chapterOne },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    await expect(parseDocument(book({ opf: epub3Opf(), files: [
      { name: "OEBPS/nav.xhtml", text: navDocument('<li><a href="../../../escape.xhtml">Escape</a></li>') },
      { name: "OEBPS/text/ch1.xhtml", text: chapterOne },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
  });

  it("normalizes legal parent-relative hrefs and splits fragments from paths", async () => {
    const opf = opfDocument({ manifest: '<item id="c1" href="../OEBPS/text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>', spine: '<itemref idref="c2"/><itemref idref="c1"/>' });
    const files: Entry[] = [
      { name: "OEBPS/text/ch1.xhtml", text: contentDocument('<p id="origin">One</p><p>Two</p>') },
      { name: "OEBPS/text/ch2.xhtml", text: contentDocument("<p>Chapter two</p>") },
      // NCX-free book; nav link exercises fragment-only + parent-relative resolution.
      { name: "OEBPS/text/links.xhtml", text: contentDocument('<p><a href="#origin">jump</a></p>') },
    ];
    const parsed = await parseDocument(book({ opf, files }), "application/epub+zip");
    const metadata = parseEpubExtractionMetadata(parsed.formatMetadata);
    expect(metadata.spineItemCount).toBe(2);
    const ch2 = blocksOf(parsed).find((block) => block.text === "Chapter two");
    expect(ch2?.locator).toMatchObject({ kind: "epub", spineIndex: 0, href: "OEBPS/text/ch2.xhtml", fragmentId: null });
    const one = blocksOf(parsed).find((block) => block.text === "One");
    expect(one?.locator).toMatchObject({ spineIndex: 1, href: "OEBPS/text/ch1.xhtml", fragmentId: "origin", elementPath: "/html[1]/body[1]/p[1]" });
    const two = blocksOf(parsed).find((block) => block.text === "Two");
    expect(two?.locator).toMatchObject({ spineIndex: 1, elementPath: "/html[1]/body[1]/p[2]", fragmentId: null });
  });

  it("keeps spine order authoritative regardless of manifest order", async () => {
    const opf = opfDocument({ manifest: '<item id="b" href="text/b.xhtml" media-type="application/xhtml+xml"/><item id="a" href="text/a.xhtml" media-type="application/xhtml+xml"/>', spine: '<itemref idref="a"/><itemref idref="b"/>' });
    const parsed = await parseDocument(book({ opf, files: [
      { name: "OEBPS/text/a.xhtml", text: contentDocument("<p>From A</p>") },
      { name: "OEBPS/text/b.xhtml", text: contentDocument("<p>From B</p>") },
    ] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["From A", "From B"]);
    expect(blocksOf(parsed).map((block) => epubLocatorOf(block)?.spineIndex)).toEqual([0, 1]);
  });

  it("preserves DOM document order inside a spine document", async () => {
    const parsed = await parseDocument(book({ opf: epub3Opf(), files: [
      ...basicFiles.slice(0, 1),
      { name: "OEBPS/text/ch1.xhtml", text: contentDocument("<p>one</p><h2>middle</h2><blockquote><p>quote</p></blockquote><p>last</p>") },
    ] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => [block.kind, block.text])).toEqual([["PARAGRAPH", "one"], ["HEADING", "middle"], ["QUOTE", "quote"], ["PARAGRAPH", "last"]]);
  });

  it("produces byte-identical blocks, warnings, and metadata on repeated parses", async () => {
    const files: Entry[] = [
      ...basicFiles.slice(0, 1),
      { name: "OEBPS/text/ch1.xhtml", text: contentDocument('<table><tr><td rowspan="2">A</td><td>1</td></tr><tr><td>2</td></tr></table><p>Emoji 🤖 text</p>') },
    ];
    const bytes = book({ opf: epub3Opf(), files });
    const first = await parseDocument(bytes, "application/epub+zip");
    const second = await parseDocument(bytes, "application/epub+zip");
    expect(second).toEqual(first);
    expect(first.qualityWarnings).toEqual(["TABLE_FLATTENED"]);
  });
});

// ---------------------------------------------------------------------------
// DOM locators
// ---------------------------------------------------------------------------

describe("epub-parser-v2 DOM locators", () => {
  it("builds deterministic elementPath with same-tag sibling indices and own ids as fragmentId", async () => {
    const doc = contentDocument('<section id="part-1"><p id="p-1">One</p><p>Two</p></section><section><p>Three</p></section>');
    const parsed = await parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: doc }] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => [epubLocatorOf(block)?.elementPath, epubLocatorOf(block)?.fragmentId])).toEqual([
      ["/html[1]/body[1]/section[1]/p[1]", "p-1"],
      ["/html[1]/body[1]/section[1]/p[2]", "part-1"],
      ["/html[1]/body[1]/section[2]/p[1]", null],
    ]);
  });

  it("falls back to the nearest interpretable ancestor id and stays null without any", async () => {
    const doc = contentDocument('<div id="wrapper"><article><p>Ancestor owned</p></article></div><p>Orphan</p>');
    const parsed = await parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: doc }] }), "application/epub+zip");
    expect(epubLocatorOf(blocksOf(parsed)[0]!)?.fragmentId).toBe("wrapper");
    expect(epubLocatorOf(blocksOf(parsed)[1]!)?.fragmentId).toBeNull();
  });

  it("records headingLevel through the canonical metadata for h1 through h6", async () => {
    const doc = contentDocument("<h1>Top</h1><h6>Bottom</h6>");
    const parsed = await parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: doc }] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => [block.kind, block.metadata?.headingLevel])).toEqual([["HEADING", 1], ["HEADING", 6]]);
  });
});

// ---------------------------------------------------------------------------
// Semantic blocks
// ---------------------------------------------------------------------------

describe("epub-parser-v2 semantic blocks", () => {
  const parse = async (body: string) => parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: contentDocument(body) }] }), "application/epub+zip");

  it("extracts nested lists without duplicating text", async () => {
    const parsed = await parse("<ul><li><p>Outer item</p><ol><li>Inner item</li></ol></li></ul>");
    expect(blocksOf(parsed).map((block) => [block.kind, block.text])).toEqual([["LIST_ITEM", "Outer item"], ["LIST_ITEM", "Inner item"]]);
  });

  it("extracts blockquote and pre/code as single owned blocks", async () => {
    const parsed = await parse("<blockquote>Quoted <em>words</em> here</blockquote><pre><code>const x = 1;\nconst y = 2;</code></pre>");
    expect(blocksOf(parsed).map((block) => [block.kind, block.text])).toEqual([["QUOTE", "Quoted words here"], ["CODE", "const x = 1;\nconst y = 2;"]]);
  });

  it("maps epub:type footnote and endnote bodies to FOOTNOTE and keeps their fragment", async () => {
    const parsed = await parse('<p>Body text.</p><aside id="fn-1" epub:type="footnote"><p>The note body.</p></aside><section epub:type="endnotes"><p id="en-1">Endnote body.</p></section>');
    expect(blocksOf(parsed).map((block) => [block.kind, block.text, epubLocatorOf(block)?.fragmentId])).toEqual([
      ["PARAGRAPH", "Body text.", null],
      ["FOOTNOTE", "The note body.", "fn-1"],
      ["FOOTNOTE", "Endnote body.", "en-1"],
    ]);
  });

  it("keeps noteref anchor text inline and treats internal targets as safe", async () => {
    const parsed = await parse('<p>See note<a epub:type="noteref" href="#fn-1">1</a> for details.</p>');
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["See note1 for details."]);
    expect(parsed.qualityWarnings).toEqual([]);
  });

  it("renders simple tables with TAB/LF text and deterministic row order", async () => {
    const parsed = await parse("<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></tbody></table>");
    expect(blocksOf(parsed)).toHaveLength(1);
    expect(blocksOf(parsed)[0]).toMatchObject({ kind: "TABLE", text: "Name\tValue\nA\t1\nB\t2" });
    expect(parsed.qualityWarnings).toEqual([]);
  });

  it("flags merged-cell geometry as TABLE_FLATTENED while keeping readable text", async () => {
    const parsed = await parse('<table><tr><td rowspan="2">A</td><td>1</td></tr><tr><td>2</td></tr></table><table><tr><td colspan="2">wide</td></tr></table>');
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["A\t1\n2", "wide"]);
    expect(parsed.qualityWarnings).toEqual(["TABLE_FLATTENED"]);
  });

  it("emits figcaption as CAPTION and image alt text as IMAGE evidence", async () => {
    const parsed = await parse('<figure><img src="media/pic.png" alt="A scenic photo"/><figcaption>The caption</figcaption></figure>');
    expect(blocksOf(parsed).map((block) => [block.kind, block.text])).toEqual([["IMAGE", "A scenic photo"], ["CAPTION", "The caption"]]);
  });

  it("never fabricates image descriptions without accessibility evidence", async () => {
    const parsed = await parse('<p>Before</p><img src="media/pic.png"/><img src="media/other.png" title=""/><p>After</p>');
    expect(blocksOf(parsed).map((block) => block.kind)).toEqual(["PARAGRAPH", "PARAGRAPH"]);
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["Before", "After"]);
  });

  it("maps MathML to EQUATION preferring the TeX annotation, then alttext, then text content", async () => {
    const parsed = await parse('<math><annotation encoding="application/x-tex">E=mc^2</annotation><annotation encoding="text/plain">ignored</annotation></math>');
    expect(blocksOf(parsed)[0]).toMatchObject({ kind: "EQUATION", text: "E=mc^2" });
    const alttext = await parse('<math alttext="x + y = 3"><mi>x</mi><mo>+</mo><mi>y</mi></math>');
    expect(alttext.pages[0]?.blocks[0]).toMatchObject({ kind: "EQUATION", text: "x + y = 3" });
    const plain = await parse("<math><mi>a</mi><mo>&#8722;</mo><mi>b</mi></math>");
    expect(plain.pages[0]?.blocks[0]).toMatchObject({ kind: "EQUATION", text: "a−b" });
  });

  it("extracts only SVG title/desc accessibility text", async () => {
    const parsed = await parse('<svg><title>Quarterly chart</title><desc>Bars for four quarters</desc><rect/></svg>');
    expect(blocksOf(parsed)).toHaveLength(1);
    expect(blocksOf(parsed)[0]).toMatchObject({ kind: "IMAGE", text: "Quarterly chart" });
  });

  it("rejects external references in SVG and content documents while CSS stays inert evidence", async () => {
    await expect(parse('<svg><image xlink:href="https://example.test/x.png"/></svg>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    await expect(parse('<p><img src="file:///etc/passwd"/></p>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    const styled = await parse('<p style="background: url(https://example.test/x.png)">styled</p>');
    expect(blocksOf(styled).map((block) => block.text)).toEqual(["styled"]);
  });

  it("decodes HTML named entities that strict XML leaves undefined", async () => {
    const parsed = await parse("<p>Caf&eacute; &mdash; A&nbsp;B &amp; C</p>");
    expect(blocksOf(parsed)[0]?.text).toBe("Café — A B & C");
  });

  it("never leaks head/title, script, or style text into canonical blocks", async () => {
    const doc = '<?xml version="1.0"?><html ' + XHTML_NS + '><head><title>Secret title</title><style>p { color: red }</style></head><body><p>Visible</p><script>var x = 1;</script></body></html>';
    const parsed = await parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: doc }] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["Visible"]);
  });

  it("emits PARTIAL_EXTRACTION when a text spine document yields nothing", async () => {
    const opf = opfDocument({ manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/empty.xhtml" media-type="application/xhtml+xml"/><item id="img" href="media/cover.png" media-type="image/png"/>', spine: '<itemref idref="c1"/><itemref idref="c2"/><itemref idref="img"/>' });
    const parsed = await parseDocument(book({ opf, files: [
      { name: "OEBPS/text/ch1.xhtml", text: chapterOne },
      { name: "OEBPS/text/empty.xhtml", text: contentDocument("<div></div>") },
      { name: "OEBPS/media/cover.png", text: "PNGDATA" },
    ] }), "application/epub+zip");
    expect(parsed.qualityWarnings).toContain("PARTIAL_EXTRACTION");
    expect(blocksOf(parsed).map((block) => block.text)).toContain("Alpha");
  });
});

// ---------------------------------------------------------------------------
// Fixed layout
// ---------------------------------------------------------------------------

describe("epub-parser-v2 fixed layout", () => {
  const fixedOpf = (manifest: string, spine: string) => opfDocument({ manifest, spine, metadata: '<meta property="rendition:layout">pre-paginated</meta>' });

  it("detects pre-paginated renditions, keeps UNKNOWN quality, and records the warning", async () => {
    const parsed = await parseDocument(book({ opf: fixedOpf('<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>', '<itemref idref="c1"/>'), files: [{ name: "OEBPS/text/ch1.xhtml", text: chapterOne }] }), "application/epub+zip");
    const metadata = parseEpubExtractionMetadata(parsed.formatMetadata);
    expect(metadata.renditionLayout).toBe("PRE_PAGINATED");
    expect(parsed.qualityWarnings).toEqual(["EPUB_FIXED_LAYOUT"]);
    expect(blocksOf(parsed).map((block) => block.text)).toContain("Alpha");
    for (const block of blocksOf(parsed)) expect(block.locator?.kind).toBe("epub");
  });

  it("fails explicitly when a fixed-layout book has no usable textual evidence", async () => {
    await expect(parseDocument(book({ opf: fixedOpf('<item id="img" href="media/page1.png" media-type="image/png"/>', '<itemref idref="img"/>'), files: [{ name: "OEBPS/media/page1.png", text: "PNG" }] }), "application/epub+zip")).rejects.toThrow(SourceError.EPUB_FIXED_LAYOUT_UNSUPPORTED);
  });

  it("marks reflowable renditions without a rendition signal as UNKNOWN", async () => {
    const parsed = await parseDocument(book({ opf: epub3Opf(), files: basicFiles }), "application/epub+zip");
    expect(parseEpubExtractionMetadata(parsed.formatMetadata).renditionLayout).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// Contract invariants and limits
// ---------------------------------------------------------------------------

describe("epub-parser-v2 invariants and limits", () => {
  it("keeps SourcePage count at zero and provenance v2 on every block", async () => {
    const parsed = await parseDocument(book({ opf: epub3Opf(), files: basicFiles }), "application/epub+zip");
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0]?.physicalPageIndex).toBeNull();
    expect(blocksOf(parsed).length).toBeGreaterThan(0);
    for (const block of blocksOf(parsed)) {
      expect(block.locator?.kind).toBe("epub");
      expect(block.provenance).toEqual({ sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" });
    }
  });

  it("fails on missing referenced spine items and empty spines", async () => {
    await expect(parseDocument(book({ opf: opfDocument({ manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>', spine: '<itemref idref="missing"/>' }), files: [{ name: "OEBPS/text/ch1.xhtml", text: chapterOne }] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
    await expect(parseDocument(book({ opf: opfDocument({ manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>', spine: "" }), files: [{ name: "OEBPS/text/ch1.xhtml", text: chapterOne }] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
  });

  it("fails on corrupted package structures", async () => {
    await expect(parseDocument(book({ containerText: '<?xml version="1.0"?><container><rootfiles/></container>' }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
    await expect(parseDocument(book({ mimetype: "application/zip" }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
    await expect(parseDocument(book({ opf: opfDocument({ manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>', spine: '<itemref idref="c1"/>' }), files: [] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
    await expect(parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: "<p>unclosed" }] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
  });

  it("rejects undefined entities and DOCTYPE/ENTITY/SYSTEM constructs in content documents", async () => {
    await expect(parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: contentDocument("<p>&mysteryentity;</p>") }] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
    await expect(parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: '<!DOCTYPE html PUBLIC "x">' + chapterOne }] }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    await expect(parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: '<!DOCTYPE html [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + chapterOne }] }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
  });

  it("keeps archive entry names strict while normalizing content hrefs", async () => {
    await expect(parseDocument(book({ opf: epub3Opf(), files: [{ name: "../escape.xhtml", text: "x" }, ...basicFiles] }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    await expect(parseDocument(book({ opf: epub3Opf('<item id="evil" href="https://example.test/x.xhtml" media-type="application/xhtml+xml"/>', '<itemref idref="evil"/>'), files: basicFiles }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
  });

  it("enforces the XML size and navigation entry limits against attacker-controlled books", async () => {
    await expect(parseDocument(book({ opf: epub3Opf(), files: basicFiles }), "application/epub+zip", { maxEpubXmlChars: 100 })).rejects.toThrow(SourceError.TOO_LARGE);
    const manyEntries = Array.from({ length: 6 }, (_, index) => `<li><a href="text/ch1.xhtml">Entry ${index}</a></li>`).join("");
    await expect(parseDocument(book({ opf: epub3Opf(), files: [{ name: "OEBPS/nav.xhtml", text: navDocument(manyEntries) }, basicFiles[1]!] }), "application/epub+zip", { maxEpubNavigationEntries: 5 })).rejects.toThrow(SourceError.TOO_LARGE);
    await expect(parseDocument(book({ opf: epub3Opf(), files: basicFiles }), "application/epub+zip", { maxArchiveEntries: 1 })).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
  });

  it("degrades an over-deep navigation tree to a typed warning", async () => {
    let nest = "<li><a href=\"text/ch1.xhtml\">Deep</a></li>";
    for (let index = 0; index < 70; index++) nest = `<li><a href="text/ch1.xhtml">L${index}</a><ol>${nest}</ol></li>`;
    const parsed = await parseDocument(book({ opf: epub3Opf(), files: [{ name: "OEBPS/nav.xhtml", text: navDocument(nest) }, basicFiles[1]!] }), "application/epub+zip");
    expect(parsed.qualityWarnings).toEqual(["EPUB_NAVIGATION_DEGRADED"]);
    expect(parseEpubExtractionMetadata(parsed.formatMetadata).navigationSource).toBe("NONE");
  });

  it("never inflates non-required archive resources (images/fonts/media stay untouched)", async () => {
    // Pseudo-random bytes: poor compression (passes the archive ratio limit)
    // and invalid UTF-8, so if the parser ever read this entry it would fail.
    const bomb = String.fromCharCode(...Array.from({ length: 8192 }, (_, index) => ((index * 31 + 17) % 251) + 1));
    const opf = opfDocument({ manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="big" href="media/big.bin" media-type="application/octet-stream"/>', spine: '<itemref idref="c1"/><itemref idref="big"/>' });
    const parsed = await parseDocument(book({ opf, files: [{ name: "OEBPS/text/ch1.xhtml", text: chapterOne }, { name: "OEBPS/media/big.bin", text: bomb }] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => block.text)).toContain("Alpha");
  });
});
