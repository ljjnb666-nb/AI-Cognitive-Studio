import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import {
  CANONICAL_SCHEMA_VERSION,
  parseCanonicalBlockMetadata,
  parseExtractionQualityMetadata,
  sha256Utf8,
  tryParseCanonicalBlockMetadata,
} from "@ai-cognitive/domain";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import type { StorageProvider } from "@ai-cognitive/storage";
import { CANONICAL_BLOCK_SEPARATOR } from "../src/canonical-text.js";
import { createIngestionService } from "../src/index.js";

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

type ZipEntry = { name: string; text: string };
function epubBytes(entries: ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), raw = Buffer.from(entry.text), body = deflateRawSync(raw), method = 8;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, body);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(method, 10); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42); central.push(record, name); offset += local.length + name.length + body.length;
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
    // Parser success is not quality acceptance: a fresh canonical-v1
    // extraction is unassessed until a production quality gate exists.
    expect(extraction.qualityStatus).toBe("UNKNOWN");
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
      { locator: { kind: "epub", spineIndex: 0, href: "OPS/b.xhtml", fragmentId: null, elementPath: null }, provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v1" } },
      { locator: { kind: "epub", spineIndex: 0, href: "OPS/b.xhtml", fragmentId: null, elementPath: null }, provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v1" } },
      { locator: { kind: "epub", spineIndex: 1, href: "OPS/a.xhtml", fragmentId: null, elementPath: null }, provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v1" } },
      { locator: { kind: "epub", spineIndex: 1, href: "OPS/a.xhtml", fragmentId: null, elementPath: null }, provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v1" } },
    ]);
    expect(extraction.canonicalSchemaVersion).toBe(CANONICAL_SCHEMA_VERSION);
    expect(extraction.qualityStatus).toBe("UNKNOWN");
  });

  it("keeps citation compatibility: content hash, UTF-16 spans, and quote reconstruction", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { document } = await ingest(storage, user, workspace, "text/plain", "book.txt", Buffer.from("\uFEFF第一段 🤖\r\n\r\nSecond paragraph\r", "utf8"));
    const extraction = await prisma.documentExtraction.findFirstOrThrow({ where: { sourceDocumentId: document.id } });
    const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
    const text = blocks.map((block) => block.text).join(CANONICAL_BLOCK_SEPARATOR);

    expect(extraction.textSha256).toBe(sha256(text));
    expect(blocks.every((block) => block.contentHash === sha256(block.text))).toBe(true);
    for (const block of blocks) {
      const quote = block.text.slice(0, 8);
      const span = await prisma.sourceSpan.create({ data: { sourceBlockId: block.id, startOffset: 0, endOffset: 8, quoteText: quote, quoteHash: sha256Utf8(quote) } });
      expect(span.quoteText).toBe(block.text.slice(span.startOffset, span.endOffset));
    }
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
    let chunkOffset = 0;
    for (const [ordinal, block] of mixedBlocks.entries()) {
      await prisma.chunkSourceSpan.create({ data: { chunkId: chunk.id, sourceBlockId: block.id, extractionId: mixed.id, ordinal, startOffset: chunkOffset, endOffset: chunkOffset + block.text.length } });
      chunkOffset += block.text.length + CANONICAL_BLOCK_SEPARATOR.length;
    }
    for (const [ordinal, block] of mixedBlocks.entries()) {
      await prisma.sourceSpan.create({ data: { sourceBlockId: block.id, startOffset: 0, endOffset: block.text.length, quoteText: block.text, quoteHash: sha256Utf8(block.text) } });
    }

    const persistedBlocks = await prisma.sourceBlock.findMany({ where: { extractionId: mixed.id }, orderBy: { ordinal: "asc" }, include: { sourcePage: true } });
    expect(persistedBlocks.map((block) => block.ordinal)).toEqual([0, 1, 2]);
    expect(persistedBlocks.map((block) => block.sourcePage?.physicalPageIndex)).toEqual([0, 1, 1]);
    expect(parseCanonicalBlockMetadata(persistedBlocks[0]?.metadata)).toEqual({ locator: { kind: "pdf", physicalPageIndex: 0, printedPageLabel: null }, provenance: nativeProvenance });
    expect(parseCanonicalBlockMetadata(persistedBlocks[1]?.metadata)).toEqual({ locator: { kind: "pdf", physicalPageIndex: 1, printedPageLabel: null }, provenance: ocrProvenance });
    expect(persistedBlocks[1]?.bbox).toBeNull();
    expect(persistedBlocks[0]?.bbox).toEqual({ x0: 0, y0: 0, x1: 100, y1: 20 });

    const spans = await prisma.chunkSourceSpan.findMany({ where: { chunkId: chunk.id }, orderBy: { ordinal: "asc" } });
    for (const span of spans) {
      const block = persistedBlocks.find((candidate) => candidate.id === span.sourceBlockId);
      expect(block).toBeDefined();
      expect(chunk.content.slice(span.startOffset, span.endOffset)).toBe(block!.text);
    }
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
