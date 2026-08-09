import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument, runNative } from "../src/document-parsers.js";

type Entry = { name: string; text: string; deflate?: boolean };
function zip(entries: Entry[]): Uint8Array {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), raw = Buffer.from(entry.text), body = entry.deflate ? deflateRawSync(raw) : raw, method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, body);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(method, 10); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); central.push(record, name); offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
}
function epub(overrides: Entry[] = []): Uint8Array { return zip([{ name: "mimetype", text: "application/epub+zip" }, { name: "META-INF/container.xml", text: '<container><rootfile full-path="OPS/book.opf"/></container>' }, { name: "OPS/book.opf", text: '<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>' }, { name: "OPS/a.xhtml", text: "<html><body><h1>First</h1><p>A</p></body></html>" }, { name: "OPS/b.xhtml", text: "<html><body><p>B</p><li>C</li></body></html>" }, ...overrides]); }

describe("safe EPUB parser", () => {
  it("uses OPF spine order, emits no pages, and retains spine metadata", async () => { const parsed = await parseDocument(epub(), "application/epub+zip"); expect(parsed.pages[0]?.physicalPageIndex).toBeNull(); expect(parsed.pages[0]?.blocks.map((block) => block.text)).toEqual(["B", "C", "First", "A"]); expect(parsed.pages[0]?.blocks[0]?.metadata).toEqual({ spineIndex: 0, href: "OPS/b.xhtml" }); });
  it.each([
    ["path traversal", epub([{ name: "../escape.xhtml", text: "x" }]), {}],
    ["absolute path", epub([{ name: "/escape.xhtml", text: "x" }]), {}],
    ["DOCTYPE", epub([{ name: "META-INF/container.xml", text: '<!DOCTYPE x><container><rootfile full-path="OPS/book.opf"/></container>' }]), {}],
    ["external resource", epub([{ name: "OPS/a.xhtml", text: '<p><img src="https://example.test/x"/>A</p>' }]), {}],
    ["encryption", epub([{ name: "META-INF/encryption.xml", text: "<encryption/>" }]), {}],
  ])("rejects %s", async (_name, input) => { await expect(parseDocument(input as Uint8Array, "application/epub+zip")).rejects.toThrow(); });
  it("enforces archive limits during inspection", async () => { await expect(parseDocument(epub(), "application/epub+zip", { maxArchiveEntries: 1 })).rejects.toThrow("SOURCE_ARCHIVE_UNSAFE"); await expect(parseDocument(zip([{ name: "mimetype", text: "A".repeat(10_000), deflate: true }]), "application/epub+zip", { maxArchiveCompressionRatio: 1 })).rejects.toThrow("SOURCE_ARCHIVE_UNSAFE"); });
});

describe("isolated PDF parser", () => {
  it("executes the native child boundary for malformed PDFs", async () => { await expect(parseDocument(Buffer.from("%PDF-1.7\nnot a PDF"), "application/pdf")).rejects.toThrow(); });
  it("kills a stalled child at the parser timeout", async () => { const fixture = fileURLToPath(new URL("./fixtures/pdf-child-stall.mjs", import.meta.url)); await expect(runNative(process.execPath, [fixture], 5, 1024)).rejects.toThrow("SOURCE_PARSE_TIMEOUT"); });
});
