import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { parseExtractionQualityMetadata } from "@ai-cognitive/domain";
import { crc32, deflateRawSync } from "node:zlib";
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

type Entry = { name: string; text: string };

function epubBytes(entries: Entry[]): Uint8Array {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), raw = Buffer.from(entry.text), stored = entry.name === "mimetype";
    const body = stored ? raw : deflateRawSync(raw), method = stored ? 0 : 8, checksum = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const container = '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const xhtml = (body: string) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

function epubFixture(input: { body?: string; secondBody?: string; metadata?: string } = {}): Uint8Array {
  const body = input.body ?? "<h1>Accepted</h1><p>Body</p>";
  const second = input.secondBody;
  const manifest = '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>' +
    (second === undefined ? "" : '<item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>');
  const spine = '<itemref idref="c1"/>' + (second === undefined ? "" : '<itemref idref="c2"/>');
  const metadata = `<dc:identifier id="pub-id">urn:uuid:untrusted-publication-id</dc:identifier><dc:title>Package Title Must Stay Evidence</dc:title><dc:language>en</dc:language>${input.metadata ?? ""}`;
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="pub-id"><metadata>${metadata}</metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
  const entries: Entry[] = [
    { name: "mimetype", text: "application/epub+zip" },
    { name: "META-INF/container.xml", text: container },
    { name: "OPS/book.opf", text: opf },
    { name: "OPS/c1.xhtml", text: xhtml(body) },
  ];
  if (second !== undefined) entries.push({ name: "OPS/c2.xhtml", text: xhtml(second) });
  return epubBytes(entries);
}

async function createFixture() {
  const user = await prisma.user.create({ data: { email: `epub-quality-${crypto.randomUUID()}@test`, name: "EPUB Quality" } });
  const workspace = await prisma.workspace.create({ data: { name: `epub-quality-${crypto.randomUUID()}` } });
  userIds.push(user.id); workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  return { user, workspace };
}

async function upload(storage: FakeStorageProvider, user: { id: string }, workspace: { id: string }, bytes: Uint8Array) {
  const service = createIngestionService(storage);
  const context = { userId: user.id, workspaceId: workspace.id };
  const { session } = await service.createUploadIntent(context, { filename: "book.epub", mediaType: "application/epub+zip", sizeBytes: bytes.length });
  storage.objects.set(session.temporaryStorageKey, bytes);
  const document = await service.completeUpload(context, session.id);
  const run = await prisma.ingestionRun.findFirstOrThrow({ where: { sourceDocumentId: document.id, workspaceId: workspace.id } });
  runIds.push(run.id);
  return { service, document, run };
}

afterEach(async () => {
  if (runIds.length) {
    const bootstraps = await prisma.bookAnalysisBootstrap.findMany({ where: { ingestionRunId: { in: runIds } }, select: { id: true } });
    if (bootstraps.length) await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: bootstraps.map((x) => x.id) } } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
  }
  if (workspaceIds.length) {
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceSpan.deleteMany({ where: { sourceBlock: { extraction: { workspaceId: { in: workspaceIds } } } } });
    await prisma.sourceBlock.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } } });
    await prisma.sourcePage.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } });
    await prisma.bookAnalysisBootstrap.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.uploadCompletion.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.uploadSession.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.outboxEvent.deleteMany({ where: { workspaceId: { in: workspaceIds } } }).catch(() => undefined);
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.edition.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.work.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  runIds.length = 0; userIds.length = 0; workspaceIds.length = 0;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("EPUB production publication quality authority", () => {
  it("publishes ACCEPTED EPUB and keeps package metadata as evidence, not automatic product identity", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createFixture();
    const { service, document, run } = await upload(storage, user, workspace, epubFixture());
    await service.processIngestionRun(run.id);

    const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
    expect(extraction.qualityStatus).toBe("ACCEPTED");
    expect(parseExtractionQualityMetadata(extraction.qualityMetadata)).toEqual({ warnings: [] });
    expect(await prisma.currentDocumentExtraction.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } })).toMatchObject({ extractionId: extraction.id });
    expect(await prisma.bookAnalysisBootstrap.findUnique({ where: { ingestionRunId: run.id } })).toMatchObject({ extractionId: extraction.id });
    expect(await prisma.source.findUniqueOrThrow({ where: { id: document.sourceId } })).toMatchObject({ editionId: null });
    expect(await prisma.work.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(await prisma.edition.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it("publishes DEGRADED EPUB with deterministic warning evidence", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createFixture();
    const bytes = epubFixture({ body: '<table><tr><td rowspan="2">A</td><td>1</td></tr><tr><td>2</td></tr></table>' });
    const { service, document, run } = await upload(storage, user, workspace, bytes);
    await service.processIngestionRun(run.id);

    const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
    expect(extraction.qualityStatus).toBe("DEGRADED");
    expect(parseExtractionQualityMetadata(extraction.qualityMetadata)).toEqual({ warnings: ["TABLE_FLATTENED"] });
    expect(await prisma.currentDocumentExtraction.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } })).toMatchObject({ extractionId: extraction.id });
    expect(await prisma.bookAnalysisBootstrap.findUnique({ where: { ingestionRunId: run.id } })).not.toBeNull();
  });

  it("rejects PARTIAL_EXTRACTION before publication and preserves an existing current authority", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createFixture();
    const { service, document, run } = await upload(storage, user, workspace, epubFixture({ secondBody: "<div></div>" }));

    // Historical current evidence can exist from an older parser generation.
    // The new rejected run must never retarget or delete it.
    const priorJob = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", status: "SUCCEEDED", progress: 100, payload: { sourceDocumentId: document.id }, idempotencyKey: `historical:${document.id}` } });
    const priorRun = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: priorJob.id, status: "SUCCEEDED", parserVersion: "epub-parser-v1", normalizationVersion: "canonical-text-v1", completedAt: new Date() } });
    runIds.push(priorRun.id);
    const priorExtraction = await prisma.documentExtraction.create({ data: { ingestionRunId: priorRun.id, sourceDocumentId: document.id, workspaceId: workspace.id, status: "SUCCEEDED", parserName: "builtin-epub", parserVersion: "epub-parser-v1", normalizationVersion: "canonical-text-v1", qualityStatus: "UNKNOWN", qualityMetadata: { warnings: [] } } });
    await prisma.currentDocumentExtraction.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, extractionId: priorExtraction.id } });

    await expect(service.processIngestionRun(run.id)).rejects.toThrow(SourceError.QUALITY_REJECTED);

    expect(await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "REJECTED", errorCode: SourceError.QUALITY_REJECTED });
    expect(await prisma.documentExtraction.findUnique({ where: { ingestionRunId: run.id } })).toBeNull();
    expect(await prisma.bookAnalysisBootstrap.findUnique({ where: { ingestionRunId: run.id } })).toBeNull();
    expect(await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } })).toMatchObject({ extractionId: priorExtraction.id });
    expect([...storage.objects.keys()].some((key) => key.includes(`/extractions/${run.id}/text/`))).toBe(false);
  });
});
