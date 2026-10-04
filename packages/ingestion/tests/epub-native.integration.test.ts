import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import {
  CANONICAL_SCHEMA_VERSION,
  parseCanonicalBlockMetadata,
  parseEpubExtractionMetadata,
  parseExtractionQualityMetadata,
  sha256Utf8,
  tryParseCanonicalBlockMetadata,
} from "@ai-cognitive/domain";
import { deflateRawSync } from "node:zlib";
import type { StorageProvider } from "@ai-cognitive/storage";
import { createIngestionService, SourceError } from "../src/index.js";

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

const XHTML_NS = 'xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"';
/** EPUB3 reflowable fixture: nav, heading-rich body, merged-cell table, footnotes. */
function epub3Fixture(): Uint8Array {
  return epubBytes([
    { name: "mimetype", text: "application/epub+zip" },
    { name: "META-INF/container.xml", text: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    {
      name: "OEBPS/content.opf",
      text: '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:fixture-02</dc:identifier><dc:title>Fixture Book</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    },
    { name: "OEBPS/nav.xhtml", text: `<?xml version="1.0"?><html ${XHTML_NS}><body><nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Chapter One</a><ol><li><a href="text/ch1.xhtml#s1">Section One</a></li></ol></li></ol></nav></body></html>` },
    { name: "OEBPS/text/ch1.xhtml", text: `<?xml version="1.0"?><html ${XHTML_NS}><body><h1 id="ch1">Chapter One</h1><section id="s1"><h2>Section One</h2><p>Body paragraph.</p></section><table><tr><td rowspan="2">A</td><td>1</td></tr><tr><td>2</td></tr></table><aside id="fn1" epub:type="footnote"><p>Note body.</p></aside></body></html>` },
  ]);
}

async function createWorkspaceFixture() {
  const user = await prisma.user.create({ data: { email: `epub-native-${crypto.randomUUID()}@test`, name: "Epub Native" } });
  const workspace = await prisma.workspace.create({ data: { name: `epub-native-${crypto.randomUUID()}` } });
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

describe("EPUB native ingestion persistence", () => {
  it("persists epub-parser-v2 extractions with format metadata, typed warnings, and no synthetic pages", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { document, run } = await ingest(storage, user, workspace, "application/epub+zip", "book.epub", epub3Fixture());
    const extraction = await prisma.documentExtraction.findFirstOrThrow({ where: { sourceDocumentId: document.id } });
    const [pageCount, blocks, current] = await Promise.all([
      prisma.sourcePage.count({ where: { extractionId: extraction.id } }),
      prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } }),
      prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } }),
    ]);

    // Planned parser provenance on the run matches the actual v2 extraction.
    expect(run.parserVersion).toBe("epub-parser-v2");
    expect(extraction.parserVersion).toBe("epub-parser-v2");
    expect(extraction.parserName).toBe("builtin-epub");
    expect(extraction.canonicalSchemaVersion).toBe(CANONICAL_SCHEMA_VERSION);
    expect(extraction.qualityStatus).toBe("UNKNOWN");
    expect(pageCount).toBe(0);
    expect(current.extractionId).toBe(extraction.id);

    // Durable, schema-validated EPUB format metadata (additive column).
    const formatMetadata = parseEpubExtractionMetadata(extraction.formatMetadata);
    expect(formatMetadata).toMatchObject({
      kind: "epub",
      epubVersion: "3.0",
      packagePath: "OEBPS/content.opf",
      renditionLayout: "UNKNOWN",
      spineItemCount: 1,
      navigationSource: "EPUB3_NAV",
    });
    expect(formatMetadata.navigation).toEqual([
      { ordinal: 0, depth: 0, label: "Chapter One", href: "OEBPS/text/ch1.xhtml", fragmentId: null },
      { ordinal: 1, depth: 1, label: "Section One", href: "OEBPS/text/ch1.xhtml", fragmentId: "s1" },
    ]);

    // Evidence-backed typed warnings survive persistence; the merged-cell
    // table is flagged TABLE_FLATTENED, quality stays UNKNOWN.
    expect(parseExtractionQualityMetadata(extraction.qualityMetadata)).toEqual({ warnings: ["TABLE_FLATTENED"] });

    // Every persisted EPUB block: v2 provenance, epub locator, valid contract.
    expect(blocks.length).toBeGreaterThan(4);
    for (const block of blocks) {
      const metadata = parseCanonicalBlockMetadata(block.metadata);
      expect(metadata.provenance).toEqual({ sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" });
      expect(metadata.locator?.kind).toBe("epub");
    }
    const kinds = blocks.map((block) => [block.kind, block.text]);
    expect(kinds).toContainEqual(["HEADING", "Chapter One"]);
    expect(kinds).toContainEqual(["HEADING", "Section One"]);
    expect(kinds).toContainEqual(["FOOTNOTE", "Note body."]);
    expect(kinds).toContainEqual(["TABLE", "A\t1\n2"]);
    const heading = blocks.find((block) => block.text === "Chapter One")!;
    expect(parseCanonicalBlockMetadata(heading.metadata)?.headingLevel).toBe(1);
    const footnote = blocks.find((block) => block.text === "Note body.")!;
    expect(parseCanonicalBlockMetadata(footnote.metadata)?.locator).toMatchObject({ spineIndex: 0, href: "OEBPS/text/ch1.xhtml", fragmentId: "fn1", elementPath: "/html[1]/body[1]/aside[1]/p[1]" });

    // Extraction text artifact integrity.
    const text = blocks.map((block) => block.text).join("\n\n");
    expect(extraction.textSha256).toBe(sha256Utf8(text));
    expect(extraction.characterCount).toBe(text.length);
  });

  it("keeps the prior current extraction when a newer extraction fails", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { service, document } = await ingest(storage, user, workspace, "application/epub+zip", "book.epub", epub3Fixture());
    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });

    // Corrupt the canonical blob in storage, then run a new ingestion for the
    // same document (the recovery path): the failed run must not replace the
    // prior current pointer or mutate the immutable extraction lineage.
    storage.objects.set(document.storageKey, Buffer.from("corrupted bytes, not a zip"));
    const retryRun = await createFixtureRun(user, workspace, document.id, "epub-parser-v2");
    runIds.push(retryRun.id);
    await expect(service.processIngestionRun(retryRun.id)).rejects.toThrow(SourceError.CORRUPTED);
    const failed = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: retryRun.id } });
    expect(failed.status).toBe("REJECTED");
    expect(failed.errorCode).toBe(SourceError.CORRUPTED);

    const stillCurrent = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });
    expect(stillCurrent.extractionId).toBe(current.extractionId);
  });

  it("keeps legacy EPUB v1 extraction rows readable without backfill", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { document } = await ingest(storage, user, workspace, "text/plain", "anchor.txt", Buffer.from("anchor"));
    const anchor = await prisma.documentExtraction.findFirstOrThrow({ where: { sourceDocumentId: document.id } });

    // Legacy v1-contract row: locator without fragmentId/elementPath populated,
    // parser provenance v1, no format metadata.
    const legacyRun = await createFixtureRun(user, workspace, anchor.sourceDocumentId, "epub-parser-v1");
    runIds.push(legacyRun.id);
    const legacy = await prisma.documentExtraction.create({
      data: { ingestionRunId: legacyRun.id, sourceDocumentId: anchor.sourceDocumentId, workspaceId: workspace.id, status: "SUCCEEDED", parserName: "builtin-epub", parserVersion: "epub-parser-v1", normalizationVersion: "canonical-text-v1", canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION, qualityStatus: "UNKNOWN", qualityMetadata: { warnings: [] } },
    });
    const legacyBlock = await prisma.sourceBlock.create({
      data: { extractionId: legacy.id, ordinal: 0, kind: "PARAGRAPH", text: "legacy block", contentHash: sha256Utf8("legacy block"), metadata: { locator: { kind: "epub", spineIndex: 0, href: "OPS/legacy.xhtml", fragmentId: null, elementPath: null }, provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v1" } } },
    });
    expect(legacy.formatMetadata).toBeNull();
    // The v1 locator shape still validates under the current schema contract.
    expect(tryParseCanonicalBlockMetadata(legacyBlock.metadata)).toMatchObject({ locator: { kind: "epub", spineIndex: 0, href: "OPS/legacy.xhtml", fragmentId: null, elementPath: null } });
  });

  it("rejects unsafe EPUB archives with the stable archive-unsafe code", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const service = createIngestionService(storage);
    const context = { userId: user.id, workspaceId: workspace.id };
    const bytes = epubBytes([
      { name: "mimetype", text: "application/epub+zip" },
      { name: "META-INF/encryption.xml", text: "<encryption/>" },
    ]);
    const { session } = await service.createUploadIntent(context, { filename: "evil.epub", mediaType: "application/epub+zip", sizeBytes: bytes.length });
    storage.objects.set(session.temporaryStorageKey, bytes);
    const document = await service.completeUpload(context, session.id);
    const run = await prisma.ingestionRun.findFirstOrThrow({ where: { sourceDocumentId: document.id, workspaceId: workspace.id } });
    runIds.push(run.id);
    await expect(service.processIngestionRun(run.id)).rejects.toThrow(SourceError.ARCHIVE_UNSAFE);
    const rejected = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.errorCode).toBe(SourceError.ARCHIVE_UNSAFE);
    const extraction = await prisma.documentExtraction.findFirst({ where: { sourceDocumentId: document.id } });
    expect(extraction).toBeNull();
    const current = await prisma.currentDocumentExtraction.findFirst({ where: { sourceDocumentId: document.id } });
    expect(current).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RF01-05: unsupported content failure model (real persistence classification)
// ---------------------------------------------------------------------------

describe("EPUB unsupported content failure model", () => {
  const XHTML_NS = 'xmlns="http://www.w3.org/1999/xhtml"';
  const textDoc = '<?xml version="1.0"?><html ' + XHTML_NS + '><body><p>Readable text.</p></body></html>';

  async function ingestEpub(storage: FakeStorageProvider, user: { id: string }, workspace: { id: string }, filename: string, buildBytes: () => Uint8Array) {
    const service = createIngestionService(storage);
    const context = { userId: user.id, workspaceId: workspace.id };
    const bytes = buildBytes();
    const { session } = await service.createUploadIntent(context, { filename, mediaType: "application/epub+zip", sizeBytes: bytes.length });
    storage.objects.set(session.temporaryStorageKey, bytes);
    const document = await service.completeUpload(context, session.id);
    const run = await prisma.ingestionRun.findFirstOrThrow({ where: { sourceDocumentId: document.id, workspaceId: workspace.id } });
    runIds.push(run.id);
    return { service, document, run, process: () => service.processIngestionRun(run.id) };
  }

  it("succeeds with PARTIAL_EXTRACTION when unsupported spine items coexist with usable text", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const entries = [
      { name: "mimetype", text: "application/epub+zip" },
      { name: "META-INF/container.xml", text: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
      { name: "OEBPS/content.opf", text: '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:x</dc:identifier></metadata><manifest><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="media/cover.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/><itemref idref="img"/></spine></package>' },
      { name: "OEBPS/text/ch1.xhtml", text: textDoc },
      { name: "OEBPS/media/cover.png", text: "PNGDATA" },
    ];
    const { process, document } = await ingestEpub(storage, user, workspace, "partial.epub", () => epubBytes(entries));
    await process();
    const extraction = await prisma.documentExtraction.findFirstOrThrow({ where: { sourceDocumentId: document.id } });
    expect(extraction.status).toBe("SUCCEEDED");
    expect(extraction.qualityStatus).toBe("UNKNOWN");
    expect(parseExtractionQualityMetadata(extraction.qualityMetadata)).toEqual({ warnings: ["PARTIAL_EXTRACTION"] });
    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });
    expect(current.extractionId).toBe(extraction.id);
  });

  it("rejects an all-binary reflowable spine with SOURCE_EPUB_NO_USABLE_TEXT and leaves no current pointer", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const entries = [
      { name: "mimetype", text: "application/epub+zip" },
      { name: "META-INF/container.xml", text: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
      { name: "OEBPS/content.opf", text: '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:x</dc:identifier></metadata><manifest><item id="img" href="media/cover.png" media-type="image/png"/></manifest><spine><itemref idref="img"/></spine></package>' },
      { name: "OEBPS/media/cover.png", text: "PNGDATA" },
    ];
    const { process, document, run } = await ingestEpub(storage, user, workspace, "images-only.epub", () => epubBytes(entries));
    await expect(process()).rejects.toThrow(SourceError.EPUB_NO_USABLE_TEXT);
    const rejected = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.errorCode).toBe(SourceError.EPUB_NO_USABLE_TEXT);
    expect(await prisma.documentExtraction.findFirst({ where: { sourceDocumentId: document.id } })).toBeNull();
    expect(await prisma.currentDocumentExtraction.findFirst({ where: { sourceDocumentId: document.id } })).toBeNull();
  });

  it("classifies a text-less fixed-layout EPUB as REJECTED with the fixed-layout code, not FAILED", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const entries = [
      { name: "mimetype", text: "application/epub+zip" },
      { name: "META-INF/container.xml", text: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
      { name: "OEBPS/content.opf", text: '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xmlns:rendition="http://www.idpf.org/2013/rendition"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:x</dc:identifier><meta property="rendition:layout">pre-paginated</meta></metadata><manifest><item id="img" href="media/page1.png" media-type="image/png"/></manifest><spine><itemref idref="img"/></spine></package>' },
      { name: "OEBPS/media/page1.png", text: "PNGDATA" },
    ];
    const { process, document, run } = await ingestEpub(storage, user, workspace, "fixed-empty.epub", () => epubBytes(entries));
    await expect(process()).rejects.toThrow(SourceError.EPUB_FIXED_LAYOUT_UNSUPPORTED);
    const rejected = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.errorCode).toBe(SourceError.EPUB_FIXED_LAYOUT_UNSUPPORTED);
    expect(await prisma.currentDocumentExtraction.findFirst({ where: { sourceDocumentId: document.id } })).toBeNull();
  });

  it("keeps the prior current extraction when an unsupported-content re-ingest fails", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { process, document } = await ingestEpub(storage, user, workspace, "good.epub", () => epub3Fixture());
    await process();
    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });

    // Replace the canonical blob with an all-binary reflowable EPUB; the
    // recovery run must fail as REJECTED and never displace the pointer.
    const entries = [
      { name: "mimetype", text: "application/epub+zip" },
      { name: "META-INF/container.xml", text: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
      { name: "OEBPS/content.opf", text: '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:x</dc:identifier></metadata><manifest><item id="img" href="media/cover.png" media-type="image/png"/></manifest><spine><itemref idref="img"/></spine></package>' },
      { name: "OEBPS/media/cover.png", text: "PNGDATA" },
    ];
    storage.objects.set(document.storageKey, epubBytes(entries));
    const service = createIngestionService(storage);
    const retryRun = await createFixtureRun(user, workspace, document.id, "epub-parser-v2");
    runIds.push(retryRun.id);
    await expect(service.processIngestionRun(retryRun.id)).rejects.toThrow(SourceError.EPUB_NO_USABLE_TEXT);
    const rejected = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: retryRun.id } });
    expect(rejected.status).toBe("REJECTED");

    const stillCurrent = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });
    expect(stillCurrent.extractionId).toBe(current.extractionId);
  });

  it("rejects a missing unsupported spine item as corrupted while the prior current survives", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { process, document } = await ingestEpub(storage, user, workspace, "good.epub", () => epub3Fixture());
    await process();
    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });

    // RF02-01: a referenced-but-missing spine item is fatal even when its
    // media type is unsupported binary — never a silent skip, never
    // SOURCE_EPUB_NO_USABLE_TEXT.
    const entries = [
      { name: "mimetype", text: "application/epub+zip" },
      { name: "META-INF/container.xml", text: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
      { name: "OEBPS/content.opf", text: '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">urn:uuid:x</dc:identifier></metadata><manifest><item id="img" href="media/missing.png" media-type="image/png"/></manifest><spine><itemref idref="img"/></spine></package>' },
    ];
    storage.objects.set(document.storageKey, epubBytes(entries));
    const service = createIngestionService(storage);
    const retryRun = await createFixtureRun(user, workspace, document.id, "epub-parser-v2");
    runIds.push(retryRun.id);
    await expect(service.processIngestionRun(retryRun.id)).rejects.toThrow(SourceError.CORRUPTED);
    const rejected = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: retryRun.id } });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.errorCode).toBe(SourceError.CORRUPTED);

    const stillCurrent = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });
    expect(stillCurrent.extractionId).toBe(current.extractionId);
  });
});
