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
    const name = Buffer.from(entry.name), raw = Buffer.from(entry.text), stored = entry.name === "mimetype", body = stored ? raw : deflateRawSync(raw), method = stored ? 0 : 8;
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
    const parsed = await parseDocument(book({
      opf: epub3Opf('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'),
      files,
    }), "application/epub+zip");
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

  it("uses URL-standard percent and fragment semantics for internal references", async () => {
    const opf = opfDocument({
      manifest: '<item id="c1" href="text/ch%201.xhtml" media-type="application/xhtml+xml"/>',
      spine: '<itemref idref="c1"/>',
    });
    const parsed = await parseDocument(book({ opf, files: [
      { name: "OEBPS/text/ch 1.xhtml", text: contentDocument('<p id="sec 1">Encoded path</p>') },
    ] }), "application/epub+zip");
    expect(blocksOf(parsed)[0]?.text).toBe("Encoded path");
    expect(epubLocatorOf(blocksOf(parsed)[0]!)?.href).toBe("OEBPS/text/ch 1.xhtml");

    const navOpf = opfDocument({
      manifest: '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/ch%201.xhtml" media-type="application/xhtml+xml"/>',
      spine: '<itemref idref="c1"/>',
    });
    const withNav = await parseDocument(book({ opf: navOpf, files: [
      { name: "OEBPS/nav.xhtml", text: navDocument('<li><a href="text/ch%201.xhtml#sec%201">Encoded</a></li>') },
      { name: "OEBPS/text/ch 1.xhtml", text: contentDocument('<p id="sec 1">Encoded path</p>') },
    ] }), "application/epub+zip");
    expect(parseEpubExtractionMetadata(withNav.formatMetadata).navigation[0]).toMatchObject({
      href: "OEBPS/text/ch 1.xhtml",
      fragmentId: "sec 1",
    });
  });

  it("rejects OCF test-root collision escapes that a single sentinel would accept", async () => {
    const collision = opfDocument({
      manifest: '<item id="c1" href="../../A/evil.xhtml" media-type="application/xhtml+xml"/>',
      spine: '<itemref idref="c1"/>',
    });
    await expect(parseDocument(book({ opf: collision, files: [
      { name: "A/evil.xhtml", text: contentDocument("<p>escaped</p>") },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
  });

  it("normalizes legal percent-encoded dot segments but rejects root escape and encoded slash aliases", async () => {
    const legal = opfDocument({
      manifest: '<item id="c1" href="sub/%2e%2e/text/ch1.xhtml" media-type="application/xhtml+xml"/>',
      spine: '<itemref idref="c1"/>',
    });
    const parsed = await parseDocument(book({ opf: legal, files: [
      { name: "OEBPS/text/ch1.xhtml", text: contentDocument("<p>Legal dot</p>") },
    ] }), "application/epub+zip");
    expect(blocksOf(parsed)[0]?.text).toBe("Legal dot");

    const escape = opfDocument({
      manifest: '<item id="c1" href="%2e%2e/%2e%2e/%2e%2e/escape.xhtml" media-type="application/xhtml+xml"/>',
      spine: '<itemref idref="c1"/>',
    });
    await expect(parseDocument(book({ opf: escape, files: basicFiles }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);

    const encodedSlash = opfDocument({
      manifest: '<item id="c1" href="text%2Fch1.xhtml" media-type="application/xhtml+xml"/>',
      spine: '<itemref idref="c1"/>',
    });
    await expect(parseDocument(book({ opf: encodedSlash, files: basicFiles }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
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
// OCF encryption / font-obfuscation authority (BOOK-INGESTION-04C-2)
// ---------------------------------------------------------------------------

describe("epub-parser-v2 OCF encryption authority", () => {
  const encryptionXml = (algorithm: string, uri: string) =>
    `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`;

  it("accepts standard IDPF font obfuscation metadata without reading the font bytes", async () => {
    const opf = epub3Opf('<item id="font" href="fonts/book.woff2" media-type="font/woff2"/>');
    const parsed = await parseDocument(book({ opf, files: [
      ...basicFiles,
      { name: "OEBPS/fonts/book.woff2", text: "obfuscated-font-bytes" },
      { name: "META-INF/encryption.xml", text: encryptionXml("http://www.idpf.org/2008/embedding", "OEBPS/fonts/book.woff2") },
    ] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => block.text)).toContain("Alpha");
  });

  it("rejects true XML Encryption algorithms because ingestion cannot decrypt publication content", async () => {
    const xml = encryptionXml("http://www.w3.org/2001/04/xmlenc#aes256-cbc", "OEBPS/text/ch1.xhtml");
    await expect(parseDocument(book({ opf: epub3Opf(), files: [
      ...basicFiles,
      { name: "META-INF/encryption.xml", text: xml },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
  });

  it("rejects malformed or non-font uses of the IDPF obfuscation algorithm", async () => {
    await expect(parseDocument(book({ opf: epub3Opf(), files: [
      ...basicFiles,
      { name: "META-INF/encryption.xml", text: '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>' },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);

    await expect(parseDocument(book({ opf: epub3Opf(), files: [
      ...basicFiles,
      { name: "META-INF/encryption.xml", text: encryptionXml("http://www.idpf.org/2008/embedding", "OEBPS/text/ch1.xhtml") },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
  });
});

// ---------------------------------------------------------------------------
// Package / spine reading-order authority (BOOK-INGESTION-04C-2)
// ---------------------------------------------------------------------------

describe("epub-parser-v2 package and spine authority", () => {
  it("keeps linear=no auxiliary content out of the canonical primary stream", async () => {
    const opf = opfDocument({
      manifest: '<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="aux" href="text/answers.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>',
      spine: '<itemref idref="c1"/><itemref idref="aux" linear="no"/><itemref idref="c2"/>',
    });
    const parsed = await parseDocument(book({ opf, files: [
      { name: "OEBPS/text/c1.xhtml", text: contentDocument("<p>Primary one</p>") },
      { name: "OEBPS/text/answers.xhtml", text: contentDocument("<p>Auxiliary answer</p>") },
      { name: "OEBPS/text/c2.xhtml", text: contentDocument("<p>Primary two</p>") },
    ] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["Primary one", "Primary two"]);
    expect(blocksOf(parsed).map((block) => epubLocatorOf(block)?.spineIndex)).toEqual([0, 2]);
    expect(parseEpubExtractionMetadata(parsed.formatMetadata).spineItemCount).toBe(3);
  });

  it("rejects a spine with no primary item and invalid linear values", async () => {
    const manifest = '<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>';
    const files = [{ name: "OEBPS/text/c1.xhtml", text: contentDocument("<p>Aux</p>") }];
    await expect(parseDocument(book({ opf: opfDocument({ manifest, spine: '<itemref idref="c1" linear="no"/>' }), files }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
    await expect(parseDocument(book({ opf: opfDocument({ manifest, spine: '<itemref idref="c1" linear="maybe"/>' }), files }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
    await expect(parseDocument(book({ opf: opfDocument({ manifest, spine: '<itemref idref="c1" linear=""/>' }), files }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
  });

  it("rejects duplicate manifest ids and duplicate spine itemrefs deterministically", async () => {
    const duplicateManifest = opfDocument({
      manifest: '<item id="dup" href="text/a.xhtml" media-type="application/xhtml+xml"/><item id="dup" href="text/b.xhtml" media-type="application/xhtml+xml"/>',
      spine: '<itemref idref="dup"/>',
    });
    await expect(parseDocument(book({ opf: duplicateManifest, files: [
      { name: "OEBPS/text/a.xhtml", text: contentDocument("<p>A</p>") },
      { name: "OEBPS/text/b.xhtml", text: contentDocument("<p>B</p>") },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);

    const duplicateSpine = opfDocument({
      manifest: '<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>',
      spine: '<itemref idref="c1"/><itemref idref="c1"/>',
    });
    await expect(parseDocument(book({ opf: duplicateSpine, files: [
      { name: "OEBPS/text/c1.xhtml", text: contentDocument("<p>One</p>") },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
  });

  it("validates every declared manifest fallback edge even when the item is not in the spine", async () => {
    const missing = opfDocument({
      manifest: '<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="unused" href="data/unused.bin" media-type="application/x-example" fallback="missing"/>',
      spine: '<itemref idref="c1"/>',
    });
    await expect(parseDocument(book({ opf: missing, files: [
      { name: "OEBPS/text/c1.xhtml", text: contentDocument("<p>Primary</p>") },
      { name: "OEBPS/data/unused.bin", text: "unused" },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);

    const cycle = opfDocument({
      manifest: '<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="a" href="data/a.bin" media-type="application/x-a" fallback="b"/><item id="b" href="data/b.bin" media-type="application/x-b" fallback="a"/>',
      spine: '<itemref idref="c1"/>',
    });
    await expect(parseDocument(book({ opf: cycle, files: [
      { name: "OEBPS/text/c1.xhtml", text: contentDocument("<p>Primary</p>") },
      { name: "OEBPS/data/a.bin", text: "a" },
      { name: "OEBPS/data/b.bin", text: "b" },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);

    const self = opfDocument({
      manifest: '<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="unused" href="data/unused.bin" media-type="application/x-example" fallback="unused"/>',
      spine: '<itemref idref="c1"/>',
    });
    await expect(parseDocument(book({ opf: self, files: [
      { name: "OEBPS/text/c1.xhtml", text: contentDocument("<p>Primary</p>") },
      { name: "OEBPS/data/unused.bin", text: "unused" },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
  });

  it("uses the manifest fallback chain for a foreign top-level spine resource", async () => {
    const opf = opfDocument({
      manifest: '<item id="foreign" href="data/ch1.bin" media-type="application/x-example" fallback="fallback"/><item id="fallback" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>',
      spine: '<itemref idref="foreign"/>',
    });
    const parsed = await parseDocument(book({ opf, files: [
      { name: "OEBPS/data/ch1.bin", text: "foreign bytes are never parsed" },
      { name: "OEBPS/text/ch1.xhtml", text: contentDocument("<p>Fallback body</p>") },
    ] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["Fallback body"]);
    expect(epubLocatorOf(blocksOf(parsed)[0]!)?.href).toBe("OEBPS/text/ch1.xhtml");
  });

  it("rejects missing and cyclic manifest fallback chains", async () => {
    const missing = opfDocument({
      manifest: '<item id="foreign" href="data/ch1.bin" media-type="application/x-example"/>',
      spine: '<itemref idref="foreign"/>',
    });
    await expect(parseDocument(book({ opf: missing, files: [{ name: "OEBPS/data/ch1.bin", text: "x" }] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);

    const cycle = opfDocument({
      manifest: '<item id="a" href="data/a.bin" media-type="application/x-a" fallback="b"/><item id="b" href="data/b.bin" media-type="application/x-b" fallback="a"/>',
      spine: '<itemref idref="a"/>',
    });
    await expect(parseDocument(book({ opf: cycle, files: [
      { name: "OEBPS/data/a.bin", text: "a" },
      { name: "OEBPS/data/b.bin", text: "b" },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
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
    // The xlink prefix is declared so the decoded-DOM resource gate (not an
    // undeclared-prefix parse failure) is what rejects the external URL.
    const doc = '<?xml version="1.0"?><html ' + XHTML_NS + ' xmlns:xlink="http://www.w3.org/1999/xlink"><body><svg><image xlink:href="https://example.test/x.png"/></svg></body></html>';
    await expect(parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: doc }] }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
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

  it("emits PARTIAL_EXTRACTION when a primary text spine document yields nothing", async () => {
    const opf = opfDocument({
      manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/empty.xhtml" media-type="application/xhtml+xml"/><item id="img" href="media/cover.png" media-type="image/png" fallback="c1"/>',
      spine: '<itemref idref="c1"/><itemref idref="c2"/><itemref idref="img" linear="no"/>',
    });
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

  it("fails explicitly when a fixed-layout EPUB content document has no usable textual evidence", async () => {
    const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    await expect(parseDocument(book({
      opf: fixedOpf('<item id="page" href="pages/page1.svg" media-type="image/svg+xml"/>', '<itemref idref="page"/>'),
      files: [{ name: "OEBPS/pages/page1.svg", text: svg }],
    }), "application/epub+zip")).rejects.toThrow(SourceError.EPUB_FIXED_LAYOUT_UNSUPPORTED);
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

  it("never inflates manifest-only non-required archive resources", async () => {
    // Pseudo-random bytes: poor compression and invalid UTF-8. If the parser
    // inflates/decodes this unreferenced resource, the parse would fail.
    const bomb = String.fromCharCode(...Array.from({ length: 8192 }, (_, index) => ((index * 31 + 17) % 251) + 1));
    const opf = opfDocument({
      manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="big" href="media/big.bin" media-type="application/octet-stream"/>',
      spine: '<itemref idref="c1"/>',
    });
    const parsed = await parseDocument(book({ opf, files: [
      { name: "OEBPS/text/ch1.xhtml", text: chapterOne },
      { name: "OEBPS/media/big.bin", text: bomb },
    ] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => block.text)).toContain("Alpha");
    expect(parsed.qualityWarnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RF01-01: entity preprocessing must not change XML grammar
// ---------------------------------------------------------------------------

describe("RF01 entity grammar preservation", () => {
  const parse = async (body: string) => parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: contentDocument(body) }] }), "application/epub+zip");

  it("keeps XML predefined entities grammar-owned: amp round-trips as text", async () => {
    const parsed = await parse("<p>A &amp; B &lt; C &gt; D &apos;E&apos;</p>");
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["A & B < C > D 'E'"]);
    expect(parsed.qualityWarnings).toEqual([]);
  });

  it("never re-interprets escaped markup as a DOM image", async () => {
    const parsed = await parse('<p>&lt;img src=&quot;https://evil.test/x.png&quot;/&gt;</p>');
    expect(blocksOf(parsed)).toHaveLength(1);
    expect(blocksOf(parsed)[0]).toMatchObject({ kind: "PARAGRAPH", text: '<img src="https://evil.test/x.png"/>' });
    expect(parsed.qualityWarnings).toEqual([]);
  });

  it("keeps &quot; inside attribute values as attribute text", async () => {
    const parsed = await parse('<p title="say &quot;hi&quot; now">body text</p>');
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["body text"]);
  });

  it("still decodes XML-unknown HTML named entities via numeric references", async () => {
    const parsed = await parse("<p>Caf&eacute; &mdash; A&nbsp;B</p>");
    expect(blocksOf(parsed)[0]?.text).toBe("Café — A B");
  });

  it("rejects unknown entities and malformed recovery instead of silently succeeding", async () => {
    await expect(parse("<p>&mysteryentity;</p>")).rejects.toThrow(SourceError.CORRUPTED);
    await expect(parse("<p>unclosed")).rejects.toThrow(SourceError.CORRUPTED);
  });
});

// ---------------------------------------------------------------------------
// RF01-02: post-DOM resource-reference security gate
// ---------------------------------------------------------------------------

describe("RF01 post-DOM resource gate", () => {
  const parse = async (body: string, extraNamespace = "") => {
    const doc = '<?xml version="1.0"?><html ' + XHTML_NS + extraNamespace + '><body>' + body + "</body></html>";
    return parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: doc }] }), "application/epub+zip");
  };

  it("allows inert outbound links while still rejecting undeclared remote embedded resources", async () => {
    await expect(parse('<img src="https://evil.test/x.png"/>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    await expect(parse('<img src=" https://evil.test/x.png"/>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    const linked = await parse('<p>Read <a href="https://example.test/article">the article</a>.</p>');
    expect(blocksOf(linked).map((block) => block.text)).toEqual(["Read the article."]);
  });

  it("rejects entity-obfuscated external references that the decoded DOM reveals", async () => {
    await expect(parse('<img src="&#x68;ttps://evil.test/x.png"/>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    await expect(parse('<img src="&#104;ttps://evil.test/x.png"/>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
  });

  it("rejects protocol-relative, absolute, drive, backslash, and root-escaping references", async () => {
    await expect(parse('<img src="//evil.test/x.png"/>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    await expect(parse('<img src="/abs/x.png"/>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    await expect(parse('<img src="..\\escape.png"/>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    await expect(parse('<img src="C:\\x.png"/>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    await expect(parse('<img src="../../../../escape.png"/>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
  });

  it("allows safe fragments and legal parent-relative archive paths", async () => {
    const parsed = await parse('<p>See <a href="#anchor">note</a></p><figure><img src="../images/a.png" alt="Chart"/></figure>');
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["See note", "Chart"]);
    expect(parsed.qualityWarnings).toEqual([]);
  });

  it("allows declared remote audio as inert content but never broadens remote images", async () => {
    const remoteOpf = opfDocument({
      manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml" properties="remote-resources"/><item id="audio" href="https://media.example.test/ch1.mp3" media-type="audio/mpeg"/>',
      spine: '<itemref idref="c1"/>',
    });
    const parsed = await parseDocument(book({ opf: remoteOpf, files: [
      { name: "OEBPS/text/ch1.xhtml", text: contentDocument('<p>Before</p><audio src="https://media.example.test/ch1.mp3"/><p>After</p>') },
    ] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["Before", "After"]);

    const undeclaredOpf = opfDocument({
      manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>',
      spine: '<itemref idref="c1"/>',
    });
    await expect(parseDocument(book({ opf: undeclaredOpf, files: [
      { name: "OEBPS/text/ch1.xhtml", text: contentDocument('<audio src="https://media.example.test/ch1.mp3"/>') },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);

    await expect(parseDocument(book({ opf: remoteOpf, files: [
      { name: "OEBPS/text/ch1.xhtml", text: contentDocument('<img src="https://media.example.test/cover.png" alt="remote"/>') },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
  });

  it("validates SVG xlink:href against the same contract", async () => {
    const xlinkNs = ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    await expect(parse('<svg><image xlink:href="https://evil.test/x.png"/></svg>', xlinkNs)).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    const safe = await parse('<svg><title>Diagram</title><image xlink:href="../images/diagram.png"/></svg>', xlinkNs);
    expect(blocksOf(safe).map((block) => block.text)).toEqual(["Diagram"]);
  });

  it("keeps noteref internal targets safe", async () => {
    const parsed = await parse('<p>Body<a epub:type="noteref" href="#fn-1">1</a></p>');
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["Body1"]);
  });
});

// ---------------------------------------------------------------------------
// RF01-03: true namespace-aware XML
// ---------------------------------------------------------------------------

describe("RF01 namespace-prefixed documents", () => {
  const prefixedContainer = '<?xml version="1.0"?><c:container xmlns:c="urn:oasis:names:tc:opendocument:xmlns:container"><c:rootfiles><c:rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></c:rootfiles></c:container>';
  const prefixedOpf = '<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="pub-id"><opf:metadata><dc:identifier id="pub-id">urn:uuid:prefixed</dc:identifier><dc:title>Prefixed Book</dc:title><dc:language>en</dc:language></opf:metadata><opf:manifest><opf:item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><opf:item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></opf:manifest><opf:spine><opf:itemref idref="c1"/></opf:spine></opf:package>';
  const prefixedNav = '<?xml version="1.0"?><xhtml:html xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><xhtml:body><xhtml:nav epub:type="toc"><xhtml:ol><xhtml:li><xhtml:a href="text/ch1.xhtml">Prefixed Chapter</xhtml:a><xhtml:ol><xhtml:li><xhtml:a href="text/ch1.xhtml#s1">Prefixed Section</xhtml:a></xhtml:li></xhtml:ol></xhtml:li></xhtml:ol></xhtml:nav></xhtml:body></xhtml:html>';
  const prefixedXhtml = '<?xml version="1.0"?><xhtml:html xmlns:xhtml="http://www.w3.org/1999/xhtml"><xhtml:body><xhtml:h1 id="px">Prefixed Head</xhtml:h1><xhtml:p>Prefixed para</xhtml:p><xhtml:table><xhtml:tr><xhtml:td>A</xhtml:td><xhtml:td>1</xhtml:td></xhtml:tr></xhtml:table></xhtml:body></xhtml:html>';

  const prefixedBook = (contentXhtml: string) => zip([
    { name: "mimetype", text: "application/epub+zip" },
    { name: "META-INF/container.xml", text: prefixedContainer },
    { name: "OEBPS/content.opf", text: prefixedOpf },
    { name: "OEBPS/nav.xhtml", text: prefixedNav },
    { name: "OEBPS/text/ch1.xhtml", text: contentXhtml },
  ]);

  it("parses prefixed container/OPF/nav/XHTML with default-namespace-equivalent output", async () => {
    const parsed = await parseDocument(prefixedBook(prefixedXhtml), "application/epub+zip");
    const metadata = parseEpubExtractionMetadata(parsed.formatMetadata);
    expect(metadata.navigationSource).toBe("EPUB3_NAV");
    expect(metadata.navigation).toEqual([
      { ordinal: 0, depth: 0, label: "Prefixed Chapter", href: "OEBPS/text/ch1.xhtml", fragmentId: null },
      { ordinal: 1, depth: 1, label: "Prefixed Section", href: "OEBPS/text/ch1.xhtml", fragmentId: "s1" },
    ]);
    expect(metadata.dcTitle).toBe("Prefixed Book");
    expect(metadata.epubVersion).toBe("3.0");
    expect(blocksOf(parsed).map((block) => [block.kind, block.text, epubLocatorOf(block)?.elementPath])).toEqual([
      ["HEADING", "Prefixed Head", "/html[1]/body[1]/h1[1]"],
      ["PARAGRAPH", "Prefixed para", "/html[1]/body[1]/p[1]"],
      ["TABLE", "A\t1", "/html[1]/body[1]/table[1]"],
    ]);
    expect(blocksOf(parsed)[0]?.metadata?.headingLevel).toBe(1);
    expect(epubLocatorOf(blocksOf(parsed)[0]!)?.fragmentId).toBe("px");
  });

  it("parses a prefixed EPUB2 NCX via the spine toc attribute", async () => {
    const prefixedNcxOpf = '<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="pub-id"><opf:metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">x</dc:identifier></opf:metadata><opf:manifest><opf:item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><opf:item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></opf:manifest><opf:spine toc="ncx"><opf:itemref idref="c1"/></opf:spine></opf:package>';
    const prefixedNcx = '<?xml version="1.0"?><ncx:ncx xmlns:ncx="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><ncx:navMap><ncx:navPoint id="n1"><ncx:navLabel><ncx:text>NCX Prefixed</ncx:text></ncx:navLabel><ncx:content src="text/ch1.xhtml"/><ncx:navPoint id="n2"><ncx:navLabel><ncx:text>Nested</ncx:text></ncx:navLabel><ncx:content src="text/ch1.xhtml#s1"/></ncx:navPoint></ncx:navPoint></ncx:navMap></ncx:ncx>';
    const parsed = await parseDocument(zip([
      { name: "mimetype", text: "application/epub+zip" },
      { name: "META-INF/container.xml", text: prefixedContainer },
      { name: "OEBPS/content.opf", text: prefixedNcxOpf },
      { name: "OEBPS/toc.ncx", text: prefixedNcx },
      { name: "OEBPS/text/ch1.xhtml", text: prefixedXhtml },
    ]), "application/epub+zip");
    const metadata = parseEpubExtractionMetadata(parsed.formatMetadata);
    expect(metadata.navigationSource).toBe("EPUB2_NCX");
    expect(metadata.epubVersion).toBe("2.0");
    expect(metadata.navigation).toEqual([
      { ordinal: 0, depth: 0, label: "NCX Prefixed", href: "OEBPS/text/ch1.xhtml", fragmentId: null },
      { ordinal: 1, depth: 1, label: "Nested", href: "OEBPS/text/ch1.xhtml", fragmentId: "s1" },
    ]);
  });

  it("keeps outbound hyperlinks inert inside prefixed documents", async () => {
    const linkedXhtml = prefixedXhtml.replace("<xhtml:p>Prefixed para</xhtml:p>", '<xhtml:p><xhtml:a href="https://example.test/x">Outbound</xhtml:a></xhtml:p>');
    const parsed = await parseDocument(prefixedBook(linkedXhtml), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => block.text)).toContain("Outbound");
  });
});

// ---------------------------------------------------------------------------
// RF01-05: unsupported content failure model
// ---------------------------------------------------------------------------

describe("RF01 unsupported spine content", () => {
  it("fails a reflowable EPUB content document with no usable textual evidence on SOURCE_EPUB_NO_USABLE_TEXT", async () => {
    const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    const opf = opfDocument({ manifest: '<item id="page" href="pages/page1.svg" media-type="image/svg+xml"/>', spine: '<itemref idref="page"/>' });
    await expect(parseDocument(book({ opf, files: [{ name: "OEBPS/pages/page1.svg", text: svg }] }), "application/epub+zip")).rejects.toThrow(SourceError.EPUB_NO_USABLE_TEXT);
  });
  it("validates auxiliary foreign spine items through fallback without inflating them", async () => {
    const opf = opfDocument({
      manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="f1" href="media/font.woff" media-type="application/font-woff" fallback="c1"/><item id="a1" href="media/audio.mp3" media-type="audio/mpeg" fallback="c1"/>',
      spine: '<itemref idref="f1" linear="no"/><itemref idref="c1"/><itemref idref="a1" linear="no"/>',
    });
    const parsed = await parseDocument(book({ opf, files: [
      { name: "OEBPS/text/ch1.xhtml", text: chapterOne },
      { name: "OEBPS/media/font.woff", text: "WWOFFDATA" },
      { name: "OEBPS/media/audio.mp3", text: "MP3DATA" },
    ] }), "application/epub+zip");
    expect(blocksOf(parsed).map((block) => block.text)).toContain("Alpha");
    expect(parsed.qualityWarnings).toEqual([]);
  });
  it("fails a missing unsupported spine item as corrupted before media-type classification", async () => {
    const opf = opfDocument({ manifest: '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="media/missing.png" media-type="image/png" fallback="c1"/>', spine: '<itemref idref="c1"/><itemref idref="img"/>' });
    await expect(parseDocument(book({ opf, files: [{ name: "OEBPS/text/ch1.xhtml", text: chapterOne }] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
  });

  it("fails an all-binary spine with one missing item as corrupted, not no-usable-text", async () => {
    const opf = opfDocument({
      manifest: '<item id="fallback" href="text/fallback.xhtml" media-type="application/xhtml+xml"/><item id="img1" href="media/cover.png" media-type="image/png" fallback="fallback"/><item id="img2" href="media/missing.png" media-type="image/png" fallback="fallback"/>',
      spine: '<itemref idref="img1"/><itemref idref="img2" linear="no"/>',
    });
    await expect(parseDocument(book({ opf, files: [
      { name: "OEBPS/text/fallback.xhtml", text: contentDocument("<p>Fallback</p>") },
      { name: "OEBPS/media/cover.png", text: "PNGDATA" },
    ] }), "application/epub+zip")).rejects.toThrow(SourceError.CORRUPTED);
  });
});

// ---------------------------------------------------------------------------
// RF02-02: raw XML lexical context preservation
// ---------------------------------------------------------------------------

describe("RF02 lexical context preservation", () => {
  const parse = async (body: string) => parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: contentDocument(body) }] }), "application/epub+zip");

  it("keeps ordinary text mentioning href/src URL syntax as paragraph text, not a false positive", async () => {
    const parsed = await parse('<p>The attribute href="https://example.com" is external.</p><p>src="file:///example" is also prose here.</p>');
    expect(parsed.qualityWarnings).toEqual([]);
    expect(blocksOf(parsed).map((block) => block.text)).toEqual([
      'The attribute href="https://example.com" is external.',
      'src="file:///example" is also prose here.',
    ]);
  });

  it("still rejects real decoded DOM attributes after the raw regex removal", async () => {
    await expect(parse('<img src="https://evil.test/x.png"/>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    await expect(parse('<img src="&#x68;ttps://evil.test/x.png"/>')).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
  });

  it("keeps CDATA sections verbatim: the preprocessor never mutates them", async () => {
    const parsed = await parse("<p><![CDATA[&eacute; &mdash;]]></p>");
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["&eacute; &mdash;"]);
  });

  it("keeps comments and processing instructions out of entity rewriting", async () => {
    const parsed = await parse("<?xml-render &eacute; ?><!-- &eacute; --><p>Visible &eacute; text</p>");
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["Visible é text"]);
  });

  it("preserves predefined-entity and escaped-markup semantics after the lexical rework", async () => {
    const parsed = await parse("<p>A &amp; B &lt; C</p>");
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["A & B < C"]);
    const escaped = await parse('<p>&lt;img src=&quot;https://evil.test/x.png&quot;/&gt;</p>');
    expect(blocksOf(escaped)[0]).toMatchObject({ kind: "PARAGRAPH", text: '<img src="https://evil.test/x.png"/>' });
    await expect(parse("<p>&mysteryentity;</p>")).rejects.toThrow(SourceError.CORRUPTED);
  });
});

// ---------------------------------------------------------------------------
// RF02-03: DOM helpers preserve document order
// ---------------------------------------------------------------------------

describe("RF02 document-order traversal", () => {
  const parse = async (body: string, limits = {}) => parseDocument(book({ opf: epub3Opf(), files: [...basicFiles.slice(0, 1), { name: "OEBPS/text/ch1.xhtml", text: contentDocument(body) }] }), "application/epub+zip", limits);

  it("picks the first source-order candidate among same-type elements (SVG titles)", async () => {
    const parsed = await parse("<svg><title>First chart</title><title>Second chart</title><desc>Bars</desc></svg>");
    expect(blocksOf(parsed)).toHaveLength(1);
    expect(blocksOf(parsed)[0]).toMatchObject({ kind: "IMAGE", text: "First chart" });
  });

  it("picks the first source-order TeX annotation in MathML", async () => {
    const parsed = await parse('<math><annotation encoding="application/x-tex">first</annotation><annotation encoding="application/x-tex">second</annotation></math>');
    expect(blocksOf(parsed)[0]).toMatchObject({ kind: "EQUATION", text: "first" });
  });

  it("selects the first valid container rootfile in document order", async () => {
    const container = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/first.opf" media-type="application/oebps-package+xml"/><rootfile full-path="OEBPS/second.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
    const firstOpf = '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">x</dc:identifier><dc:title>First OPF</dc:title></metadata><manifest><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>';
    const secondOpf = firstOpf.replace("First OPF", "Second OPF");
    const parsed = await parseDocument(zip([
      { name: "mimetype", text: "application/epub+zip" },
      { name: "META-INF/container.xml", text: container },
      { name: "OEBPS/first.opf", text: firstOpf },
      { name: "OEBPS/second.opf", text: secondOpf },
      { name: "OEBPS/text/ch1.xhtml", text: chapterOne },
    ]), "application/epub+zip");
    expect(parseEpubExtractionMetadata(parsed.formatMetadata).dcTitle).toBe("First OPF");
  });

  it("keeps normal block DOM order unchanged (root, a, b, c pre-order)", async () => {
    const parsed = await parse("<div>one</div><div>two</div><div>three</div>");
    expect(blocksOf(parsed).map((block) => block.text)).toEqual(["one", "two", "three"]);
  });

  it("still enforces the maxEpubDomNodes bound during traversal", async () => {
    await expect(parse("<div><p>1</p></div><div><p>2</p></div><div><p>3</p></div>", { maxEpubDomNodes: 5 })).rejects.toThrow(SourceError.TOO_LARGE);
  });
});