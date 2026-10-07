import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import {
  buildSourceSpan,
  CANONICAL_SCHEMA_VERSION,
  isUtf16Boundary,
  parseCanonicalBlockMetadata,
  parseExtractionQualityMetadata,
  sha256Utf8,
  tryParseCanonicalBlockMetadata,
  validateSourceSpan,
} from "@ai-cognitive/domain";
import { crc32, deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import type { StorageProvider } from "@ai-cognitive/storage";
import { CANONICAL_BLOCK_SEPARATOR } from "../src/canonical-text.js";
import { canonicalBlockMetadata, createIngestionService, SourceError } from "../src/index.js";
import { parseDocument, type ParsedBlock } from "../src/document-parsers.js";

const workspaceIds: string[] = [];
const userIds: string[] = [];
const runIds: string[] = [];

class FakeStorageProvider implements StorageProvider {
  readonly objects = new Map<string, Uint8Array>();

  async createPresignedUpload(input: { key: string; contentType: string; expiresInSeconds: number }) {
    return { url: `https://storage.test/${input.key}`, headers: { "content-type": input.contentType } };
  }
  async headObject(key: string) { const body = this.objects.get(key); return body ? { key, size: body.length, contentType: "application/octet-stream" } : null; }
  async getObjectStream(key: string) {
    const body = await this.getObjectBytes(key);
    return (async function* () { yield body; })();
  }
  async getObjectBytes(key: string) { const body = this.objects.get(key); if (!body) throw new Error(`OBJECT_NOT_FOUND:${key}`); return body; }
  async putObject({ key, body }: { key: string; body: Uint8Array; contentType: string }) { this.objects.set(key, body); }
  async copyObject(sourceKey: string, targetKey: string) { this.objects.set(targetKey, await this.getObjectBytes(sourceKey)); }
  async deleteObject(key: string) { this.objects.delete(key); }
  async objectExists(key: string) { return this.objects.has(key); }
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// Local equivalent of the authoritative book-intelligence isSafeBoundary check:
// an offset must land on a UTF-16 code-unit boundary, never inside a surrogate pair.
const isSafeChunkBoundary = (text: string, offset: number): boolean => offset <= 0 || offset >= text.length || !(/[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!));

type ZipEntry = { name: string; text: string };
function epubBytes(entries: ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), raw = Buffer.from(entry.text), stored = entry.name === "mimetype", body = stored ? raw : deflateRawSync(raw), method = stored ? 0 : 8, checksum = crc32(raw) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, body);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(method, 10); record.writeUInt32LE(checksum, 16); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); central.push(record, name); offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
}
function epubFixture(): Uint8Array {
  return epubBytes([
    { name: "mimetype", text: "application/epub+zip" },
    { name: "META-INF/container.xml", text: '<container><rootfile full-path="OPS/book.opf"/></container>' },
    { name: "OPS/book.opf", text: '<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>' },
    { name: "OPS/a.xhtml", text: "<html><body><h1>First</h1><p>A</p></body></html>" },
    { name: "OPS/b.xhtml", text: "<html><body><p>B</p><li>C</li></body></html>" },
  ]);
}
async function pdfFixture(pages: string[]): Promise<Buffer> {
  const document = new PDFDocument({ autoFirstPage: false }); const stream = new PassThrough(), chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk)); const complete = new Promise<Buffer>((resolve) => stream.on("end", () => resolve(Buffer.concat(chunks))));
  document.pipe(stream); for (const text of pages) { document.addPage(); document.text(text); } document.end(); return complete;
}

async function createWorkspaceFixture() {
  const user = await prisma.user.create({ data: { email: `locator-${crypto.randomUUID()}@test`, name: "Locator" } });
  const workspace = await prisma.workspace.create({ data: { name: `locator-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  return { user, workspace };
}

async function ingest(storage: FakeStorageProvider, user: { id: string }, workspace: { id: string }, mediaType: string, filename: string, bytes: Uint8Array) {
  const service = createIngestionService(storage);
  const context = { userId: user.id, workspaceId: workspace.id };
  const { session } = await service.createUploadIntent(context, { filename, mediaType, sizeBytes: bytes.length });
  storage.objects.set(session.temporaryStorageKey, bytes);
  const document = await service.completeUpload(context, session.id);
  const run = await prisma.ingestionRun.findFirstOrThrow({ where: { sourceDocumentId: document.id, workspaceId: workspace.id } });
  runIds.push(run.id);
  await service.processIngestionRun(run.id);
  return { service, document, run };
}

/** Fixture runs satisfy the unique (extraction ← run) lineage like production does. */
async function createFixtureRun(user: { id: string }, workspace: { id: string }, sourceDocumentId: string, parserVersion: string) {
  const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId }, idempotencyKey: `fixture:${crypto.randomUUID()}` } });
  return prisma.ingestionRun.create({ data: { sourceDocumentId, workspaceId: workspace.id, jobId: job.id, parserVersion, normalizationVersion: "canonical-text-v1" } });
}

afterEach(async () => {
  if (runIds.length) {
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
    const bootstraps = await prisma.bookAnalysisBootstrap.findMany({ where: { ingestionRunId: { in: runIds } }, select: { id: true } });
    if (bootstraps.length) await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: bootstraps.map((bootstrap) => bootstrap.id) } } });
  }
  if (workspaceIds.length) {
    await prisma.chunkSourceSpan.deleteMany({ where: { chunk: { workspaceId: { in: workspaceIds } } } });
    await prisma.documentChunk.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.chunkSet.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceSpan.deleteMany({ where: { sourceBlock: { extraction: { workspaceId: { in: workspaceIds } } } } });
    await prisma.sourceBlock.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } } });
    await prisma.sourcePage.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } } });
    await prisma.bookAnalysisBootstrap.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.uploadCompletion.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.uploadSession.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: workspaceIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  workspaceIds.length = 0;
  userIds.length = 0;
  runIds.length = 0;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("canonical contract persistence", () => {
  it("persists PDF blocks with pdf locators and native provenance while pages stay physical", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { document } = await ingest(storage, user, workspace, "application/pdf", "book.pdf", await pdfFixture(["Hello PDF", "Second Page"]));
    const extraction = await prisma.documentExtraction.findFirstOrThrow({ where: { sourceDocumentId: document.id } });
    const pages = await prisma.sourcePage.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
    const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });

    expect(pages.map((page) => page.physicalPageIndex)).toEqual([0, 1]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => parseCanonicalBlockMetadata(block.metadata))).toEqual([
      { locator: { kind: "pdf", physicalPageIndex: 0, printedPageLabel: null }, provenance: { sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" } },
      { locator: { kind: "pdf", physicalPageIndex: 1, printedPageLabel: null }, provenance: { sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" } },
    ]);
    expect(blocks.every((block) => block.bbox === null)).toBe(true);
    expect(blocks[0]?.sourcePageId).toBe(pages[0]?.id);
    expect(blocks[1]?.sourcePageId).toBe(pages[1]?.id);
    expect(extraction.canonicalSchemaVersion).toBe(CANONICAL_SCHEMA_VERSION);
    // BOOK-INGESTION-04B-2: PDF publication is quality-authoritative. The
    // routing pipeline's deterministic decision is persisted verbatim — a
    // fully native document is ACCEPTED, never UNKNOWN.
    expect(extraction.parserVersion).toBe("pdf-router-v1");
    expect(extraction.qualityStatus).toBe("ACCEPTED");
    expect(parseExtractionQualityMetadata(extraction.qualityMetadata)).toEqual({ warnings: [] });
  });

  it("persists EPUB blocks with epub locators and structured-markup provenance without synthetic pages", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { document } = await ingest(storage, user, workspace, "application/epub+zip", "book.epub", epubFixture());
    const extraction = await prisma.documentExtraction.findFirstOrThrow({ where: { sourceDocumentId: document.id } });
    const [pageCount, blocks] = await Promise.all([
      prisma.sourcePage.count({ where: { extractionId: extraction.id } }),
      prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } }),
    ]);

    expect(pageCount).toBe(0);
    expect(blocks).toHaveLength(4);
    expect(blocks.map((block) => parseCanonicalBlockMetadata(block.metadata))).toEqual([
      { locator: { kind: "epub", spineIndex: 0, href: "OPS/b.xhtml", fragmentId: null, elementPath: "/html[1]/body[1]/p[1]" }, provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" } },
      { locator: { kind: "epub", spineIndex: 0, href: "OPS/b.xhtml", fragmentId: null, elementPath: "/html[1]/body[1]/li[1]" }, provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" } },
      { headingLevel: 1, locator: { kind: "epub", spineIndex: 1, href: "OPS/a.xhtml", fragmentId: null, elementPath: "/html[1]/body[1]/h1[1]" }, provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" } },
      { locator: { kind: "epub", spineIndex: 1, href: "OPS/a.xhtml", fragmentId: null, elementPath: "/html[1]/body[1]/p[1]" }, provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" } },
    ]);
    expect(extraction.canonicalSchemaVersion).toBe(CANONICAL_SCHEMA_VERSION);
    expect(extraction.qualityStatus).toBe("ACCEPTED");
    expect(parseExtractionQualityMetadata(extraction.qualityMetadata)).toEqual({ warnings: [] });
  });

  it("keeps citation compatibility: content hash and authoritative UTF-16 source spans", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { document } = await ingest(storage, user, workspace, "text/plain", "book.txt", Buffer.from("\uFEFF第一段 🤖\r\n\r\nSecond paragraph\r", "utf8"));
    const extraction = await prisma.documentExtraction.findFirstOrThrow({ where: { sourceDocumentId: document.id } });
    const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
    const text = blocks.map((block) => block.text).join(CANONICAL_BLOCK_SEPARATOR);

    expect(extraction.textSha256).toBe(sha256(text));
    expect(blocks.every((block) => block.contentHash === sha256(block.text))).toBe(true);

    const chinese = blocks[0]!;
    const ascii = blocks[1]!;
    expect(chinese.text).toBe("第一段 🤖");
    expect(ascii.text).toBe("Second paragraph");

    // Spans are generated through the domain authority (buildSourceSpan), never
    // through fixed offsets that String.slice would silently truncate: ASCII,
    // CJK, and a full emoji surrogate pair must all round-trip.
    const validCases = [
      { block: ascii, startOffset: 0, endOffset: 6 },
      { block: chinese, startOffset: 0, endOffset: 3 },
      { block: chinese, startOffset: 4, endOffset: 6 },
    ];
    for (const { block, startOffset, endOffset } of validCases) {
      const span = buildSourceSpan(block.text, startOffset, endOffset);
      expect(span.endOffset).toBeLessThanOrEqual(block.text.length);
      expect(isUtf16Boundary(block.text, span.startOffset)).toBe(true);
      expect(isUtf16Boundary(block.text, span.endOffset)).toBe(true);
      expect(span.quoteText).toBe(block.text.slice(span.startOffset, span.endOffset));
      expect(span.quoteHash).toBe(sha256Utf8(span.quoteText));
      expect(validateSourceSpan(block.text, span.startOffset, span.endOffset, span.quoteText)).toBe(true);

      const persisted = await prisma.sourceSpan.create({ data: { sourceBlockId: block.id, startOffset: span.startOffset, endOffset: span.endOffset, quoteText: span.quoteText, quoteHash: span.quoteHash } });
      expect(validateSourceSpan(block.text, persisted.startOffset, persisted.endOffset, persisted.quoteText)).toBe(true);
      expect(persisted.quoteHash).toBe(sha256Utf8(persisted.quoteText));
    }

    // Out-of-bounds and mid-surrogate offsets must be rejected by the domain
    // authority instead of being masked by String.slice truncation.
    expect(() => buildSourceSpan(chinese.text, 0, 8)).toThrow(RangeError);
    expect(() => buildSourceSpan(chinese.text, 0, 5)).toThrow(RangeError);
    expect(validateSourceSpan(chinese.text, 0, 8, chinese.text.slice(0, 8))).toBe(false);
  });

  it("persists a mixed-parser extraction where provenance varies per block", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { document } = await ingest(storage, user, workspace, "text/plain", "anchor.txt", Buffer.from("anchor"));
    const anchorExtraction = await prisma.documentExtraction.findFirstOrThrow({ where: { sourceDocumentId: document.id } });

    const fixtureRun = await createFixtureRun(user, workspace, anchorExtraction.sourceDocumentId, "pdf-isolation-v3");
    const mixed = await prisma.documentExtraction.create({
      data: {
        ingestionRunId: fixtureRun.id,
        sourceDocumentId: anchorExtraction.sourceDocumentId,
        workspaceId: workspace.id,
        status: "SUCCEEDED",
        parserName: "pdfjs-isolated",
        parserVersion: "pdf-isolation-v3",
        normalizationVersion: "canonical-text-v1",
        canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
        qualityStatus: "UNKNOWN",
        qualityMetadata: { warnings: [] },
      },
    });
    const pageZero = await prisma.sourcePage.create({ data: { extractionId: mixed.id, ordinal: 0, physicalPageIndex: 0 } });
    const pageOne = await prisma.sourcePage.create({ data: { extractionId: mixed.id, ordinal: 1, physicalPageIndex: 1 } });
    const blockTexts = ["native block zero", "ocr fallback block", "native block two"];
    const nativeProvenance = { sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" };
    const ocrProvenance = { sourceMethod: "OCR", parserName: "mineru", parserVersion: "0.9.3", parserMode: "ocr-fallback", confidence: 0.92 };
    const mixedBlocks = [
      await prisma.sourceBlock.create({ data: { extractionId: mixed.id, sourcePageId: pageZero.id, ordinal: 0, kind: "PARAGRAPH", text: blockTexts[0]!, contentHash: sha256Utf8(blockTexts[0]!), metadata: { locator: { kind: "pdf", physicalPageIndex: 0, printedPageLabel: null }, provenance: nativeProvenance }, bbox: { x0: 0, y0: 0, x1: 100, y1: 20 } } }),
      await prisma.sourceBlock.create({ data: { extractionId: mixed.id, sourcePageId: pageOne.id, ordinal: 1, kind: "PARAGRAPH", text: blockTexts[1]!, contentHash: sha256Utf8(blockTexts[1]!), metadata: { locator: { kind: "pdf", physicalPageIndex: 1, printedPageLabel: null }, provenance: ocrProvenance } } }),
      await prisma.sourceBlock.create({ data: { extractionId: mixed.id, sourcePageId: pageOne.id, ordinal: 2, kind: "PARAGRAPH", text: blockTexts[2]!, contentHash: sha256Utf8(blockTexts[2]!), metadata: { locator: { kind: "pdf", physicalPageIndex: 1, printedPageLabel: null }, provenance: nativeProvenance } } }),
    ];

    // Chunk + span lineage over the mixed blocks must stay semantically intact.
    const chunkSet = await prisma.chunkSet.create({
      data: { workspaceId: workspace.id, sourceDocumentId: mixed.sourceDocumentId, extractionId: mixed.id, chunkingVersion: "chunking-test", configuration: {}, configurationHash: sha256Utf8("chunking-test") },
    });
    const content = blockTexts.join(CANONICAL_BLOCK_SEPARATOR);
    const chunk = await prisma.documentChunk.create({
      data: { workspaceId: workspace.id, chunkSetId: chunkSet.id, extractionId: mixed.id, structureVersion: "structure-test", ordinal: 0, content, contentHash: sha256Utf8(content), characterCount: content.length, tokenEstimate: content.length },
    });
    for (const [ordinal, block] of mixedBlocks.entries()) {
      // ChunkSourceSpan offsets are SOURCE-BLOCK-LOCAL UTF-16 offsets (the
      // authoritative chunkBlocks contract): a full-block span covers
      // [0, block.text.length) and never accumulates chunk-global offsets.
      await prisma.chunkSourceSpan.create({ data: { chunkId: chunk.id, sourceBlockId: block.id, extractionId: mixed.id, ordinal, startOffset: 0, endOffset: block.text.length } });
    }
    for (const block of mixedBlocks) {
      const span = buildSourceSpan(block.text, 0, block.text.length);
      await prisma.sourceSpan.create({ data: { sourceBlockId: block.id, startOffset: span.startOffset, endOffset: span.endOffset, quoteText: span.quoteText, quoteHash: span.quoteHash } });
    }

    const persistedBlocks = await prisma.sourceBlock.findMany({ where: { extractionId: mixed.id }, orderBy: { ordinal: "asc" }, include: { sourcePage: true } });
    expect(persistedBlocks.map((block) => block.ordinal)).toEqual([0, 1, 2]);
    expect(persistedBlocks.map((block) => block.sourcePage?.physicalPageIndex)).toEqual([0, 1, 1]);
    expect(parseCanonicalBlockMetadata(persistedBlocks[0]?.metadata)).toEqual({ locator: { kind: "pdf", physicalPageIndex: 0, printedPageLabel: null }, provenance: nativeProvenance });
    expect(parseCanonicalBlockMetadata(persistedBlocks[1]?.metadata)).toEqual({ locator: { kind: "pdf", physicalPageIndex: 1, printedPageLabel: null }, provenance: ocrProvenance });
    expect(persistedBlocks[1]?.bbox).toBeNull();
    expect(persistedBlocks[0]?.bbox).toEqual({ x0: 0, y0: 0, x1: 100, y1: 20 });

    // Reconstruction follows the authoritative production contract: order spans
    // by ordinal, slice each SOURCE block locally, join with the canonical
    // separator, and the result must equal the chunk content exactly.
    const spans = await prisma.chunkSourceSpan.findMany({ where: { chunkId: chunk.id }, orderBy: { ordinal: "asc" } });
    const reconstructedPieces = spans.map((span) => {
      const block = persistedBlocks.find((candidate) => candidate.id === span.sourceBlockId);
      expect(block).toBeDefined();
      // Equivalent of the authoritative validateEvidence invariant: integer,
      // bounded, UTF-16-safe block-local offsets.
      expect(Number.isInteger(span.startOffset) && Number.isInteger(span.endOffset)).toBe(true);
      expect(span.startOffset).toBeGreaterThanOrEqual(0);
      expect(span.endOffset).toBeGreaterThan(span.startOffset);
      expect(span.endOffset).toBeLessThanOrEqual(block!.text.length);
      expect(isSafeChunkBoundary(block!.text, span.startOffset)).toBe(true);
      expect(isSafeChunkBoundary(block!.text, span.endOffset)).toBe(true);
      return block!.text.slice(span.startOffset, span.endOffset);
    });
    expect(reconstructedPieces.join(CANONICAL_BLOCK_SEPARATOR)).toBe(chunk.content);
    const sourceSpans = await prisma.sourceSpan.findMany({ where: { sourceBlock: { extractionId: mixed.id } } });
    for (const span of sourceSpans) {
      const block = persistedBlocks.find((candidate) => candidate.id === span.sourceBlockId)!;
      expect(span.quoteText).toBe(block.text.slice(span.startOffset, span.endOffset));
    }
    const reloaded = await prisma.documentExtraction.findUniqueOrThrow({ where: { id: mixed.id } });
    expect(reloaded.qualityStatus).toBe("UNKNOWN");
    expect(parseExtractionQualityMetadata(reloaded.qualityMetadata)).toEqual({ warnings: [] });
  });

  it("keeps legacy extractions and legacy block metadata readable without backfill", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { document } = await ingest(storage, user, workspace, "text/plain", "book.txt", Buffer.from("Current paragraph"));
    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });

    // Legacy row: pre-contract extraction and a pre-contract EPUB-style block.
    const legacyRun = await createFixtureRun(user, workspace, document.id, "epub-parser-v1");
    const legacy = await prisma.documentExtraction.create({
      data: { ingestionRunId: legacyRun.id, sourceDocumentId: document.id, workspaceId: workspace.id, status: "SUCCEEDED", parserName: "builtin-epub", parserVersion: "epub-parser-v1", normalizationVersion: "canonical-text-v1" },
    });
    const legacyBlock = await prisma.sourceBlock.create({
      data: { extractionId: legacy.id, ordinal: 0, kind: "PARAGRAPH", text: "legacy block", contentHash: sha256Utf8("legacy block"), metadata: { spineIndex: 3, href: "OPS/legacy.xhtml" } },
    });

    const reloaded = await prisma.documentExtraction.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(reloaded.canonicalSchemaVersion).toBeNull();
    expect(reloaded.qualityStatus).toBeNull();
    expect(reloaded.qualityMetadata).toBeNull();
    expect(reloaded.parserName).toBe("builtin-epub");
    expect(tryParseCanonicalBlockMetadata(legacyBlock.metadata)).toBeNull();
    expect(legacyBlock.metadata).toEqual({ spineIndex: 3, href: "OPS/legacy.xhtml" });
    // Legacy data is still plain readable JSON for existing consumers.
    expect((legacyBlock.metadata as { spineIndex: number }).spineIndex).toBe(3);

    // The current pointer still refers to the new-contract extraction.
    const stillCurrent = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });
    expect(stillCurrent.extractionId).toBe(current.extractionId);
    expect(stillCurrent.extractionId).not.toBe(legacy.id);
  });
});

describe("canonical v1 write gate", () => {
  const pdfProvenance = { sourceMethod: "NATIVE_TEXT", parserName: "pdfjs-isolated", parserVersion: "pdf-isolation-v3" };
  const epubProvenance = { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" };
  const textProvenance = { sourceMethod: "NATIVE_TEXT", parserName: "builtin-text", parserVersion: "text-parser-v1" };
  const markdownProvenance = { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-markdown", parserVersion: "markdown-parser-v1" };
  const pdfLocator = { kind: "pdf" as const, physicalPageIndex: 2, printedPageLabel: null };
  const epubLocator = { kind: "epub" as const, spineIndex: 1, href: "OPS/b.xhtml", fragmentId: null, elementPath: null };

  it("fails closed when a new canonical block has no provenance", () => {
    expect(() => canonicalBlockMetadata({ kind: "PARAGRAPH", text: "orphan" }, "text/plain")).toThrow(SourceError.CANONICAL_BLOCK_CONTRACT_INVALID);
    expect(() => canonicalBlockMetadata({ kind: "PARAGRAPH", text: "orphan", locator: pdfLocator }, "application/pdf")).toThrow(SourceError.CANONICAL_BLOCK_CONTRACT_INVALID);
  });

  it.each([
    ["a PDF block without a locator", "application/pdf", { kind: "PARAGRAPH", text: "x", provenance: pdfProvenance }],
    ["a PDF block with an epub locator", "application/pdf", { kind: "PARAGRAPH", text: "x", provenance: pdfProvenance, locator: epubLocator }],
    ["an EPUB block without a locator", "application/epub+zip", { kind: "PARAGRAPH", text: "x", provenance: epubProvenance }],
    ["an EPUB block with a pdf locator", "application/epub+zip", { kind: "PARAGRAPH", text: "x", provenance: epubProvenance, locator: pdfLocator }],
    ["a TXT block with a fabricated pdf locator", "text/plain", { kind: "PARAGRAPH", text: "x", provenance: textProvenance, locator: pdfLocator }],
    ["a Markdown block with a fabricated epub locator", "text/markdown", { kind: "PARAGRAPH", text: "x", provenance: markdownProvenance, locator: epubLocator }],
  ])("rejects %s by media type", (_name, mediaType, block) => {
    expect(() => canonicalBlockMetadata(block as ParsedBlock, mediaType)).toThrow(SourceError.CANONICAL_BLOCK_CONTRACT_INVALID);
  });

  it.each([
    ["a valid PDF block", "application/pdf", { kind: "PARAGRAPH", text: "x", provenance: pdfProvenance, locator: pdfLocator }, { locator: pdfLocator, provenance: pdfProvenance }],
    ["a valid EPUB block", "application/epub+zip", { kind: "PARAGRAPH", text: "x", provenance: epubProvenance, locator: epubLocator }, { locator: epubLocator, provenance: epubProvenance }],
    ["a valid TXT block with null locator", "text/plain", { kind: "PARAGRAPH", text: "x", provenance: textProvenance }, { locator: null, provenance: textProvenance }],
    ["a valid Markdown block with null locator", "text/markdown", { kind: "PARAGRAPH", text: "x", provenance: markdownProvenance }, { locator: null, provenance: markdownProvenance }],
  ])("accepts %s", (_name, mediaType, block, expected) => {
    expect(parseCanonicalBlockMetadata(canonicalBlockMetadata(block as ParsedBlock, mediaType))).toEqual(expected);
  });

  it("keeps every production parser's output writable under the strict v1 gate", async () => {
    const txt = (await parseDocument(Buffer.from("Plain paragraph"), "text/plain")).pages[0]!.blocks[0]!;
    const markdown = (await parseDocument(Buffer.from("# Title"), "text/markdown")).pages[0]!.blocks[0]!;
    const pdf = (await parseDocument(await pdfFixture(["Hello PDF"]), "application/pdf")).pages[0]!.blocks[0]!;
    const epub = (await parseDocument(epubFixture(), "application/epub+zip")).pages[0]!.blocks[0]!;

    expect(parseCanonicalBlockMetadata(canonicalBlockMetadata(txt, "text/plain"))).toEqual({ locator: null, provenance: textProvenance });
    expect(parseCanonicalBlockMetadata(canonicalBlockMetadata(markdown, "text/markdown"))).toEqual({ locator: null, provenance: markdownProvenance });
    expect(parseCanonicalBlockMetadata(canonicalBlockMetadata(pdf, "application/pdf"))).toEqual({ locator: { kind: "pdf", physicalPageIndex: 0, printedPageLabel: null }, provenance: pdfProvenance });
    expect(parseCanonicalBlockMetadata(canonicalBlockMetadata(epub, "application/epub+zip"))).toEqual({ locator: { kind: "epub", spineIndex: 0, href: "OPS/b.xhtml", fragmentId: null, elementPath: "/html[1]/body[1]/p[1]" }, provenance: epubProvenance });
  });
});