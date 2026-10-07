import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { parseEpubExtractionMetadata, parseProductIdentityCandidate } from "@ai-cognitive/domain";
import type { StorageProvider } from "@ai-cognitive/storage";
import { createIngestionService, canonicalFormatMetadata, SourceError } from "../src/index.js";
import { SourceError as ParserSourceError } from "../src/source-errors.js";

// RF01-04: the production persistence gate must run inside the real
// processIngestionRun path, not only in test helpers. The parser seam is
// mocked to return a contract-violating EPUB result (missing formatMetadata);
// everything else (upload, sniffing, transactions, classification) stays real.
const parseDocumentMock = vi.hoisted(() => vi.fn());
vi.mock("../src/document-parsers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/document-parsers.js")>()),
  parseDocument: parseDocumentMock,
}));

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

const epubBlock = {
  kind: "PARAGRAPH" as const,
  text: "Parser output without durable metadata.",
  locator: { kind: "epub" as const, spineIndex: 0, href: "OEBPS/text/ch1.xhtml", fragmentId: null, elementPath: "/html[1]/body[1]/p[1]" },
  provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" },
};

function epubParsedWithoutFormatMetadata() {
  return { parser: { name: "builtin-epub", version: "epub-parser-v2" }, pages: [{ physicalPageIndex: null, blocks: [epubBlock] }] };
}

function epubBytes(): Uint8Array {
  // Minimal PK-prefixed bytes; sniffing only needs the ZIP magic because the
  // parser itself is mocked in this file.
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Buffer.from("fixture")]);
}

async function createWorkspaceFixture() {
  const user = await prisma.user.create({ data: { email: `fmt-gate-${crypto.randomUUID()}@test`, name: "Format Gate" } });
  const workspace = await prisma.workspace.create({ data: { name: `fmt-gate-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  return { user, workspace };
}

async function ingest(storage: FakeStorageProvider, user: { id: string }, workspace: { id: string }) {
  const service = createIngestionService(storage);
  const context = { userId: user.id, workspaceId: workspace.id };
  const bytes = epubBytes();
  const { session } = await service.createUploadIntent(context, { filename: "book.epub", mediaType: "application/epub+zip", sizeBytes: bytes.length });
  storage.objects.set(session.temporaryStorageKey, bytes);
  const document = await service.completeUpload(context, session.id);
  const run = await prisma.ingestionRun.findFirstOrThrow({ where: { sourceDocumentId: document.id, workspaceId: workspace.id } });
  runIds.push(run.id);
  return { service, document, run };
}

afterEach(async () => {
  parseDocumentMock.mockReset();
  if (runIds.length) {
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
    const bootstraps = await prisma.bookAnalysisBootstrap.findMany({ where: { ingestionRunId: { in: runIds } }, select: { id: true } });
    if (bootstraps.length) await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: bootstraps.map((bootstrap) => bootstrap.id) } } });
  }
  if (workspaceIds.length) {
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
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

describe("format metadata persistence gate", () => {
  it("fails an EPUB extraction without format metadata as FAILED with the stable contract code", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { service, document, run } = await ingest(storage, user, workspace);
    parseDocumentMock.mockReturnValueOnce(epubParsedWithoutFormatMetadata());

    await expect(service.processIngestionRun(run.id)).rejects.toThrow(SourceError.FORMAT_METADATA_CONTRACT_INVALID);
    const failed = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed.status).toBe("FAILED");
    expect(failed.errorCode).toBe(SourceError.FORMAT_METADATA_CONTRACT_INVALID);
    expect(await prisma.documentExtraction.findFirst({ where: { sourceDocumentId: document.id } })).toBeNull();
    expect(await prisma.currentDocumentExtraction.findFirst({ where: { sourceDocumentId: document.id } })).toBeNull();
  });

  it("persists valid EPUB metadata and keeps non-EPUB formats NULL through the same gate", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const { service, document, run } = await ingest(storage, user, workspace);
    const validMetadata = {
      kind: "epub" as const,
      epubVersion: "3.0",
      packagePath: "OEBPS/content.opf",
      renditionLayout: "UNKNOWN" as const,
      spineItemCount: 1,
      navigationSource: "NONE" as const,
      navigation: [],
      dcTitle: null,
      dcLanguage: null,
      dcIdentifier: "urn:uuid:fixture",
    };
    parseDocumentMock.mockReturnValueOnce({ ...epubParsedWithoutFormatMetadata(), qualityWarnings: [], formatMetadata: validMetadata });

    await service.processIngestionRun(run.id);
    const extraction = await prisma.documentExtraction.findFirstOrThrow({ where: { sourceDocumentId: document.id } });
    expect(extraction.status).toBe("SUCCEEDED");
    // The persisted format metadata remains the schema-normalized evidence.
    expect(parseEpubExtractionMetadata(extraction.formatMetadata)).toEqual(validMetadata);
    // 04C-4A projects product-identity evidence onto this exact immutable
    // extraction without promoting anything into Work/Edition.
    expect(parseProductIdentityCandidate(extraction.productIdentityCandidate)).toEqual({
      kind: "epub",
      schemaVersion: "product-identity-candidate-v1",
      source: "EPUB_PACKAGE_METADATA",
      authority: "EVIDENCE_ONLY",
      title: null,
      language: null,
      identifier: { sourceField: "dc:identifier", value: "urn:uuid:fixture", classification: "UNCLASSIFIED" },
    });
    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({
      where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } },
    });
    expect(current.extractionId).toBe(extraction.id);
  });

  it("enforces the gate contract directly on both sides of the media-type split", () => {
    const validMetadata = { kind: "epub" as const, epubVersion: null, packagePath: "content.opf", renditionLayout: "UNKNOWN" as const, spineItemCount: 1, navigationSource: "NONE" as const, navigation: [] };
    expect(canonicalFormatMetadata("application/epub+zip", validMetadata)).toEqual(validMetadata);
    // EPUB format metadata is REQUIRED: neither null nor undefined may persist.
    expect(() => canonicalFormatMetadata("application/epub+zip", undefined)).toThrow(SourceError.FORMAT_METADATA_CONTRACT_INVALID);

    expect(() => canonicalFormatMetadata("application/epub+zip", null)).toThrow(SourceError.FORMAT_METADATA_CONTRACT_INVALID);
    expect(() => canonicalFormatMetadata("application/epub+zip", { kind: "epub" })).toThrow(SourceError.FORMAT_METADATA_CONTRACT_INVALID);
    expect(() => canonicalFormatMetadata("application/epub+zip", { ...validMetadata, navigationSource: "EPUB3_NAV" })).toThrow(SourceError.FORMAT_METADATA_CONTRACT_INVALID);
    // No Zod details leak: the error message is the stable code alone.
    let message = "";
    try { canonicalFormatMetadata("application/epub+zip", null); } catch (error) { message = (error as Error).message; }
    expect(message).toBe(ParserSourceError.FORMAT_METADATA_CONTRACT_INVALID);

    expect(canonicalFormatMetadata("application/pdf", undefined)).toBeUndefined();
    expect(canonicalFormatMetadata("text/plain", null)).toBeUndefined();
    expect(canonicalFormatMetadata("text/markdown", undefined)).toBeUndefined();
    expect(() => canonicalFormatMetadata("application/pdf", validMetadata)).toThrow(SourceError.FORMAT_METADATA_CONTRACT_INVALID);
    expect(() => canonicalFormatMetadata("text/plain", { fake: true })).toThrow(SourceError.FORMAT_METADATA_CONTRACT_INVALID);
    expect(() => canonicalFormatMetadata("text/markdown", "metadata")).toThrow(SourceError.FORMAT_METADATA_CONTRACT_INVALID);
  });
});
