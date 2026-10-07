import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARSER_LIMITS, epubChildArgs, parseDocument, runNative } from "../src/document-parsers.js";

type Entry = { name: string; text: string; deflate?: boolean; descriptor?: boolean; omitDescriptor?: boolean };
function zip(entries: Entry[]): Uint8Array {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), raw = Buffer.from(entry.text), body = entry.deflate ? deflateRawSync(raw) : raw, method = entry.deflate ? 8 : 0, flags = entry.descriptor ? 0x08 : 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); if (!entry.descriptor) { local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); } local.writeUInt16LE(name.length, 26);
    const descriptor = entry.descriptor && !entry.omitDescriptor ? Buffer.alloc(16) : Buffer.alloc(0); if (descriptor.length) { descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(body.length, 8); descriptor.writeUInt32LE(raw.length, 12); }
    locals.push(local, name, body, descriptor);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); central.push(record, name); offset += local.length + name.length + body.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
}
function epub(overrides: Entry[] = []): Uint8Array { return zip([{ name: "mimetype", text: "application/epub+zip" }, { name: "META-INF/container.xml", text: '<container><rootfile full-path="OPS/book.opf"/></container>' }, { name: "OPS/book.opf", text: '<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>' }, { name: "OPS/a.xhtml", text: "<html><body><h1>First</h1><p>A</p></body></html>" }, { name: "OPS/b.xhtml", text: "<html><body><p>B</p><li>C</li></body></html>" }, ...overrides]); }
async function pdf(pages: Array<string | null>, options: ConstructorParameters<typeof PDFDocument>[0] = {}): Promise<Buffer> { const document = new PDFDocument({ autoFirstPage: false, ...options }); const stream = new PassThrough(), chunks: Buffer[] = []; stream.on("data", (chunk: Buffer) => chunks.push(chunk)); const complete = new Promise<Buffer>((resolve) => stream.on("end", () => resolve(Buffer.concat(chunks)))); document.pipe(stream); for (const text of pages) { document.addPage(); if (text === null) document.rect(20, 20, 100, 100).fill(); else document.text(text); } document.end(); return complete; }

describe("safe EPUB parser", () => {
  it("uses OPF spine order, emits no pages, and retains spine metadata", async () => { const parsed = await parseDocument(epub(), "application/epub+zip"); expect(parsed.pages[0]?.physicalPageIndex).toBeNull(); expect(parsed.pages[0]?.blocks.map((block) => block.text)).toEqual(["B", "C", "First", "A"]); expect(parsed.pages[0]?.blocks[0]).toMatchObject({ kind: "PARAGRAPH", text: "B", locator: { kind: "epub", spineIndex: 0, href: "OPS/b.xhtml", fragmentId: null, elementPath: "/html[1]/body[1]/p[1]" }, provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" } }); expect(parsed.pages[0]?.blocks[3]?.locator).toEqual({ kind: "epub", spineIndex: 1, href: "OPS/a.xhtml", fragmentId: null, elementPath: "/html[1]/body[1]/p[1]" }); });
  it.each([
    ["path traversal", epub([{ name: "../escape.xhtml", text: "x" }]), {}],
    ["absolute path", epub([{ name: "/escape.xhtml", text: "x" }]), {}],
    ["DOCTYPE", epub([{ name: "META-INF/container.xml", text: '<!DOCTYPE x><container><rootfile full-path="OPS/book.opf"/></container>' }]), {}],
    ["external resource", epub([{ name: "OPS/a.xhtml", text: '<p><img src="https://example.test/x"/>A</p>' }]), {}],
    ["encryption", epub([{ name: "META-INF/encryption.xml", text: "<encryption/>" }]), {}],
  ])("rejects %s", async (_name, input) => { await expect(parseDocument(input as Uint8Array, "application/epub+zip")).rejects.toThrow(); });
  it("enforces archive limits during inspection", async () => { await expect(parseDocument(epub(), "application/epub+zip", { maxArchiveEntries: 1 })).rejects.toThrow("SOURCE_ARCHIVE_UNSAFE"); await expect(parseDocument(zip([{ name: "mimetype", text: "A".repeat(10_000), deflate: true }]), "application/epub+zip", { maxArchiveCompressionRatio: 1 })).rejects.toThrow("SOURCE_ARCHIVE_UNSAFE"); });
  it("rejects duplicate central-directory names before Map materialization", async () => {
    await expect(parseDocument(epub([{ name: "OPS/a.xhtml", text: "<html><body><p>shadow</p></body></html>" }]), "application/epub+zip")).rejects.toThrow("SOURCE_ARCHIVE_UNSAFE");
  });
  it("rejects dot-segment ZIP entry aliases before archive lookup", async () => {
    await expect(parseDocument(epub([{ name: "OPS/./shadow.xhtml", text: "<html><body><p>shadow</p></body></html>" }]), "application/epub+zip")).rejects.toThrow("SOURCE_ARCHIVE_UNSAFE");
  });
  it("rejects central/local header identity mismatches deterministically", async () => {
    const input = Buffer.from(epub());
    // First local header belongs to mimetype. Central says STORE (0); mutate
    // the local method only so authority disagreement is observable.
    input.writeUInt16LE(8, 8);
    await expect(parseDocument(input, "application/epub+zip")).rejects.toThrow("SOURCE_CORRUPTED");
  });
  it("accepts safe directory records after the mandatory first mimetype entry", async () => {
    const input = zip([
      { name: "mimetype", text: "application/epub+zip" },
      { name: "META-INF/", text: "" },
      { name: "META-INF/container.xml", text: '<container><rootfile full-path="OPS/book.opf"/></container>' },
      { name: "OPS/", text: "" },
      { name: "OPS/book.opf", text: '<package><manifest><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>' },
      { name: "OPS/a.xhtml", text: "<html><body><p>A</p></body></html>" },
    ]);
    await expect(parseDocument(input, "application/epub+zip")).resolves.toMatchObject({ parser: { name: "builtin-epub" } });
  });
  it("finds the real EOCD when an archive comment contains a fake EOCD signature", async () => {
    const original = Buffer.from(epub());
    const eocd = original.length - 22;
    const comment = Buffer.from([0x41, 0x50, 0x4b, 0x05, 0x06, 0x42]);
    const input = Buffer.concat([original, comment]);
    input.writeUInt16LE(comment.length, eocd + 20);
    await expect(parseDocument(input, "application/epub+zip")).resolves.toMatchObject({ parser: { name: "builtin-epub" } });
  });
  it("enforces OCF mimetype as the first local stored file", async () => {
    const input = zip([
      { name: "META-INF/", text: "" },
      { name: "mimetype", text: "application/epub+zip" },
      { name: "META-INF/container.xml", text: '<container><rootfile full-path="OPS/book.opf"/></container>' },
      { name: "OPS/book.opf", text: '<package><manifest><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>' },
      { name: "OPS/a.xhtml", text: "<html><body><p>A</p></body></html>" },
    ]);
    await expect(parseDocument(input, "application/epub+zip")).rejects.toThrow("SOURCE_CORRUPTED");
  });
  it("resolves the tsx EPUB preloader from the ingestion runtime dependency", () => {
    const args = epubChildArgs("source.epub", DEFAULT_PARSER_LIMITS);
    expect(args[2]).toMatch(/^file:/);
    expect(args[2]).not.toBe("tsx");
  });
  it("validates bit-3 data descriptors as part of the bounded local ZIP range", async () => {
    const valid = epub([{ name: "OPS/empty.bin", text: "", descriptor: true }]);
    await expect(parseDocument(valid, "application/epub+zip")).resolves.toMatchObject({ parser: { name: "builtin-epub" } });

    const missing = epub([{ name: "OPS/empty.bin", text: "", descriptor: true, omitDescriptor: true }]);
    await expect(parseDocument(missing, "application/epub+zip")).rejects.toThrow("SOURCE_CORRUPTED");

    const mismatched = Buffer.from(valid);
    const descriptor = mismatched.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
    expect(descriptor).toBeGreaterThanOrEqual(0);
    mismatched.writeUInt32LE(1, descriptor + 8);
    await expect(parseDocument(mismatched, "application/epub+zip")).rejects.toThrow("SOURCE_CORRUPTED");
  });
  it("preserves split UTF-8 code points across child stdout chunks", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/epub-child-split-utf8.mjs", import.meta.url));
    const parsed = await parseDocument(epub(), "application/epub+zip", { epubChildEntry: fixture });
    expect(parsed.pages[0]?.blocks[0]?.text).toBe("中文");
  });
  it("rejects malformed result payloads and unknown child error codes as stable parser failures", async () => {
    const malformed = fileURLToPath(new URL("./fixtures/epub-child-malformed-result.mjs", import.meta.url));
    const unknownError = fileURLToPath(new URL("./fixtures/epub-child-unknown-error.mjs", import.meta.url));
    await expect(parseDocument(epub(), "application/epub+zip", { epubChildEntry: malformed })).rejects.toThrow("SOURCE_PARSE_ERROR");
    await expect(parseDocument(epub(), "application/epub+zip", { epubChildEntry: unknownError })).rejects.toThrow("SOURCE_PARSE_ERROR");
  });
  it("isolates EPUB parsing behind a memory-capped child with a hard deadline", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/pdf-child-stall.mjs", import.meta.url));
    await expect(parseDocument(epub(), "application/epub+zip", { epubChildEntry: fixture, epubTimeoutMs: 5 })).rejects.toThrow("SOURCE_PARSE_TIMEOUT");
  });
  it("rejects abnormal EPUB child exits and bounds both IPC channels", async () => {
    const abnormal = fileURLToPath(new URL("./fixtures/pdf-child-abnormal.mjs", import.meta.url));
    const stdout = fileURLToPath(new URL("./fixtures/pdf-child-utf8-stdout.mjs", import.meta.url));
    const stderr = fileURLToPath(new URL("./fixtures/pdf-child-utf8-stderr.mjs", import.meta.url));
    await expect(parseDocument(epub(), "application/epub+zip", { epubChildEntry: abnormal })).rejects.toThrow("SOURCE_PARSE_ERROR");
    await expect(parseDocument(epub(), "application/epub+zip", { epubChildEntry: stdout, maxEpubIpcBytes: 5 })).rejects.toThrow("SOURCE_TOO_LARGE");
    await expect(parseDocument(epub(), "application/epub+zip", { epubChildEntry: stderr, maxEpubStderrBytes: 5 })).rejects.toThrow("SOURCE_PARSE_ERROR");
  });
});

describe("isolated PDF parser", () => {
  it("extracts ordered conservative paragraph blocks through the memory-capped child", async () => { const parsed = await parseDocument(await pdf(["Hello PDF", "Second Page"]), "application/pdf"); expect(parsed.parser.name).toBe("pdfjs-isolated"); expect(parsed.pages.map((page) => page.physicalPageIndex)).toEqual([0, 1]); expect(parsed.pages.flatMap((page) => page.blocks)).toMatchObject([{ kind: "PARAGRAPH", text: "Hello PDF" }, { kind: "PARAGRAPH", text: "Second Page" }]); });
  it("attaches a physical-page locator and native provenance to every block without fabricating bbox or confidence", async () => { const parsed = await parseDocument(await pdf(["Hello PDF", "Second Page"]), "application/pdf"); for (const [pageIndex, page] of parsed.pages.entries()) for (const block of page.blocks) { expect(block.locator).toEqual({ kind: "pdf", physicalPageIndex: pageIndex, printedPageLabel: null }); expect(block.provenance).toEqual({ sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" }); expect(block.bbox).toBeUndefined(); expect(block.provenance?.confidence ?? null).toBeNull(); } });
  it("classifies password, OCR, page, and output limits in the child", async () => { await expect(parseDocument(await pdf(["secret"], { userPassword: "secret" }), "application/pdf")).rejects.toThrow("SOURCE_PASSWORD_REQUIRED"); await expect(parseDocument(await pdf([null]), "application/pdf")).rejects.toThrow("SOURCE_OCR_REQUIRED"); await expect(parseDocument(await pdf(["one", "two", "three"]), "application/pdf", { maxPdfPages: 2 })).rejects.toThrow("SOURCE_TOO_LARGE"); await expect(parseDocument(await pdf(["x".repeat(500)]), "application/pdf", { maxPdfOutputChars: 50 })).rejects.toThrow("SOURCE_TOO_LARGE"); }, 30_000);
  it("executes the native child boundary for malformed PDFs", async () => { await expect(parseDocument(Buffer.from("%PDF-1.7\nnot a PDF"), "application/pdf")).rejects.toThrow(); });
  it("kills a stalled child at the parser timeout", async () => { const fixture = fileURLToPath(new URL("./fixtures/pdf-child-stall.mjs", import.meta.url)); await expect(runNative(process.execPath, [fixture], 5, 1024)).rejects.toThrow("SOURCE_PARSE_TIMEOUT"); });
  it("rejects an abnormal production child exit rather than treating it as OCR", async () => { const fixture = fileURLToPath(new URL("./fixtures/pdf-child-abnormal.mjs", import.meta.url)); await expect(parseDocument(await pdf(["input"]), "application/pdf", { pdfChildEntry: fixture })).rejects.toThrow("SOURCE_PARSE_ERROR"); });
  it("enforces stdout and stderr limits by UTF-8 bytes before decoding", async () => { const stdout = fileURLToPath(new URL("./fixtures/pdf-child-utf8-stdout.mjs", import.meta.url)), stderr = fileURLToPath(new URL("./fixtures/pdf-child-utf8-stderr.mjs", import.meta.url)), input = await pdf(["input"]); await expect(parseDocument(input, "application/pdf", { pdfChildEntry: stdout, maxPdfIpcBytes: 5 })).rejects.toThrow("SOURCE_TOO_LARGE"); await expect(parseDocument(input, "application/pdf", { pdfChildEntry: stderr, maxPdfStderrBytes: 5 })).rejects.toThrow("SOURCE_PARSE_ERROR"); });
});

describe("plain-text parser provenance", () => {
  it("records NATIVE_TEXT provenance for TXT without inventing a locator", async () => { const parsed = await parseDocument(Buffer.from("First paragraph\n\nSecond paragraph"), "text/plain"); expect(parsed.pages[0]?.blocks).toMatchObject([{ kind: "PARAGRAPH", text: "First paragraph", provenance: { sourceMethod: "NATIVE_TEXT", parserName: "builtin-text", parserVersion: "text-parser-v1" } }, { provenance: { sourceMethod: "NATIVE_TEXT" } }]); for (const block of parsed.pages[0]?.blocks ?? []) expect(block.locator).toBeUndefined(); });
  it("records STRUCTURED_MARKUP provenance for Markdown without inventing a locator", async () => { const parsed = await parseDocument(Buffer.from("# Title\n\nBody."), "text/markdown"); expect(parsed.pages[0]?.blocks).toMatchObject([{ kind: "HEADING", text: "# Title", provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-markdown", parserVersion: "markdown-parser-v1" } }, { kind: "PARAGRAPH", provenance: { sourceMethod: "STRUCTURED_MARKUP" } }]); for (const block of parsed.pages[0]?.blocks ?? []) expect(block.locator).toBeUndefined(); });
});