/**
 * BOOK-INGESTION-03 synthetic fixture builders — TEST-ONLY.
 *
 * Deterministic, repository-local, no network, no copyrighted material.
 * PDFs are generated with pdfkit through the REAL production parser path
 * (parseDocument → pdfjs-isolated child); EPUBs are hand-assembled ZIP
 * archives parsed by builtin-epub.
 *
 * EMPIRICAL AUTHORING CONSTRAINTS (from the fidelity probe against the
 * production PDF path):
 *   - Line breaks are dropped WITHOUT any separator; the comparison view
 *     joins blocks with pure concatenation, so every fixture places
 *     page/spine block boundaries at no-whitespace positions of the linear
 *     text. Spaces exist only INSIDE blocks, at identical positions in both
 *     encodings.
 *   - Lines must stay far below the pdfkit auto-wrap width: a wrap silently
 *     drops the space at the break ("lazydog"), which no allowed
 *     normalization can repair.
 *   - pdfkit standard fonts are WinAnsi: NBSP arrives as U+0020 and U+00AD
 *     arrives as U+002D. Cross-format soft-hyphen equivalence is therefore
 *     unprovable without forbidden dash normalization; N5 is covered by
 *     helper-level invariant tests plus real-EPUB parsing instead. CJK and
 *     emoji cannot be encoded at all on the PDF side and are covered at
 *     helper level (UTF-16 surrogate invariants).
 */

import { crc32, deflateRawSync } from "node:zlib";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";

/** One PDF page: each entry is one text() call (one visual line). */
export type PdfPage = string[];

export async function buildPdf(pages: PdfPage[]): Promise<Uint8Array> {
  const document = new PDFDocument({ autoFirstPage: false });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Buffer>((resolve) => stream.on("end", () => resolve(Buffer.concat(chunks))));
  document.pipe(stream);
  for (const lines of pages) {
    document.addPage();
    for (const line of lines) document.text(line);
  }
  document.end();
  return complete;
}

type ZipEntry = { name: string; text: string };

function zip(entries: ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.from(entry.text, "utf8");
    const stored = entry.name === "mimetype";
    const body = stored ? raw : deflateRawSync(raw);
    const method = stored ? 0 : 8;
    const checksum = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const XHTML = 'xmlns="http://www.w3.org/1999/xhtml"';

export type EpubSpineDoc = { href: string; body: string; epubNamespaces?: boolean };

/** Assembles a minimal (navigation-less, which is legal) EPUB archive. */
export function buildEpub(spineDocs: EpubSpineDoc[], extraArchiveEntries: ZipEntry[] = []): Uint8Array {
  const manifest = spineDocs
    .map((doc) => `<item id="s${spineDocs.indexOf(doc)}" href="${doc.href}" media-type="application/xhtml+xml"/>`)
    .join("");
  const spine = spineDocs.map((_, index) => `<itemref idref="s${index}"/>`).join("");
  const files: ZipEntry[] = spineDocs.map((doc) => ({
    name: `OPS/${doc.href}`,
    text: `<?xml version="1.0"?><html ${XHTML}${doc.epubNamespaces ? ' xmlns:epub="http://www.idpf.org/2007/ops"' : ""}><head><title>t</title></head><body>${doc.body}</body></html>`,
  }));
  return zip([
    { name: "mimetype", text: "application/epub+zip" },
    { name: "META-INF/container.xml", text: '<container><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></container>' },
    { name: "OPS/book.opf", text: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:fixture</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>` },
    ...files,
    ...extraArchiveEntries,
  ]);
}

export type FixtureSpec = {
  id: string;
  pdfPages: PdfPage[];
  epubSpine: EpubSpineDoc[];
  epubNamespaces?: boolean;
  extraArchiveEntries?: ZipEntry[];
  includeTables?: boolean;
  /** Which side the manifest declares complete (for truncation attribution). */
  pdfComplete?: boolean;
  epubComplete?: boolean;
};

// Shared three-chapter synthetic book. Every segment boundary sits at a
// no-whitespace position of the linear text; "Preface." is deliberately
// short (below any plausible anchor minimum) and drives the mandatory
// short-content negative regression.
export const BOOK_A_SEGMENTS = {
  preface: "Preface.",
  chapterOne: "Chapter One",
  chapterOneBody: ["The first chapter opens the book.", "It continues with a second sentence."],
  chapterTwo: "Chapter Two",
  middlePassage: "A short middle passage appears here.",
  chapterThree: "Chapter Three",
  finalPassage: "The final chapter closes the volume.",
} as const;

/** PDF pages deliberately cut ACROSS semantic units. */
export function bookAPdfPages(): PdfPage[] {
  const s = BOOK_A_SEGMENTS;
  return [
    [s.preface, s.chapterOne],
    [s.chapterOneBody[0]!],
    [s.chapterOneBody[1]!, s.chapterTwo],
    [s.middlePassage],
    [s.chapterThree, s.finalPassage],
  ];
}

/** EPUB spine boundaries deliberately differ from the PDF page cuts. */
export function bookAEpubSpine(): EpubSpineDoc[] {
  const s = BOOK_A_SEGMENTS;
  return [
    { href: "part1.xhtml", body: `<p>${s.preface}</p><p>${s.chapterOne}</p><p>${s.chapterOneBody[0]!}</p>` },
    { href: "part2.xhtml", body: `<p>${s.chapterOneBody[1]!}</p><p>${s.chapterTwo}</p>` },
    { href: "part3.xhtml", body: `<p>${s.middlePassage}</p><p>${s.chapterThree}</p><p>${s.finalPassage}</p>` },
  ];
}