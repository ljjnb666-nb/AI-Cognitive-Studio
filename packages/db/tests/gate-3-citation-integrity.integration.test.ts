import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/index.js";
import { sha256Utf8, validateSourceSpan } from "@ai-cognitive/domain";

const workspaceIds: string[] = [];

async function createWorkspace() {
  const workspace = await prisma.workspace.create({ data: { name: `gate-3-${crypto.randomUUID()}` } });
  workspaceIds.push(workspace.id);
  return workspace;
}

async function createDocument(workspaceId: string) {
  const suffix = crypto.randomUUID();
  const blob = await prisma.sourceBlob.create({ data: { workspaceId, sha256: `sha-${suffix}`, sizeBytes: 1, mediaType: "text/plain", storageKey: `gate-3/${suffix}` } });
  const source = await prisma.source.create({ data: { workspaceId, kind: "FILE", displayName: `gate-3-${suffix}.txt` } });
  return prisma.sourceDocument.create({ data: { workspaceId, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: blob.sha256, sizeBytes: 1, mediaType: "text/plain", storageKey: blob.storageKey } });
}

async function createExtraction(document: { id: string; workspaceId: string }) {
  const job = await prisma.job.create({ data: { workspaceId: document.workspaceId, type: "source.ingest", payload: { sourceDocumentId: document.id }, idempotencyKey: `gate-3:${crypto.randomUUID()}` } });
  const run = await prisma.ingestionRun.create({ data: { workspaceId: document.workspaceId, sourceDocumentId: document.id, jobId: job.id, parserVersion: "test-parser-v1", normalizationVersion: "canonical-text-v1" } });
  return prisma.documentExtraction.create({ data: { ingestionRunId: run.id, sourceDocumentId: document.id, workspaceId: document.workspaceId, status: "SUCCEEDED", parserName: "test-parser", parserVersion: "test-parser-v1", normalizationVersion: "canonical-text-v1" } });
}

afterEach(async () => {
  if (workspaceIds.length) {
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  }
  workspaceIds.length = 0;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("Gate 3 citation integrity", () => {
  it("accepts an extraction only for its exact same-workspace document", async () => {
    const workspace = await createWorkspace();
    const document = await createDocument(workspace.id);
    const extraction = await createExtraction(document);

    expect(extraction).toMatchObject({ sourceDocumentId: document.id, workspaceId: workspace.id });
  });

  it("rejects a cross-workspace extraction/document association", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const documentB = await createDocument(workspaceB.id);
    const job = await prisma.job.create({ data: { workspaceId: workspaceB.id, type: "source.ingest", payload: {} } });
    const run = await prisma.ingestionRun.create({ data: { workspaceId: workspaceB.id, sourceDocumentId: documentB.id, jobId: job.id, parserVersion: "test", normalizationVersion: "canonical-text-v1" } });

    await expect(prisma.documentExtraction.create({ data: { ingestionRunId: run.id, sourceDocumentId: documentB.id, workspaceId: workspaceA.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "canonical-text-v1" } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("enforces exact document ownership and one current marker", async () => {
    const workspace = await createWorkspace();
    const documentA = await createDocument(workspace.id);
    const documentB = await createDocument(workspace.id);
    const extractionA = await createExtraction(documentA);
    const extractionB = await createExtraction(documentB);
    await expect(prisma.currentDocumentExtraction.create({ data: { sourceDocumentId: documentA.id, extractionId: extractionB.id, workspaceId: workspace.id } })).rejects.toMatchObject({ code: "P2003" });
    const marker = await prisma.currentDocumentExtraction.create({ data: { sourceDocumentId: documentA.id, extractionId: extractionA.id, workspaceId: workspace.id } });
    expect(marker.extractionId).toBe(extractionA.id);
    const secondExtraction = await createExtraction(documentA);
    await expect(prisma.currentDocumentExtraction.create({ data: { sourceDocumentId: documentA.id, extractionId: secondExtraction.id, workspaceId: workspace.id } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects a current marker whose workspace does not own its document", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const documentA = await createDocument(workspaceA.id);
    const extractionA = await createExtraction(documentA);

    await expect(prisma.currentDocumentExtraction.create({ data: { sourceDocumentId: documentA.id, extractionId: extractionA.id, workspaceId: workspaceB.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("round-trips canonical SourceBlock text and UTF-16 SourceSpan values exactly", async () => {
    const workspace = await createWorkspace();
    const document = await createDocument(workspace.id);
    const extraction = await createExtraction(document);
    const text = "A🤖中文";
    const block = await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal: 0, kind: "PARAGRAPH", text, contentHash: sha256Utf8(text) } });
    const span = await prisma.sourceSpan.create({ data: { sourceBlockId: block.id, startOffset: 1, endOffset: 3, quoteText: "🤖", quoteHash: sha256Utf8("🤖") } });
    const stored = await prisma.sourceBlock.findUniqueOrThrow({ where: { id: block.id }, include: { spans: true } });

    expect(stored).toMatchObject({ text, kind: "PARAGRAPH", contentHash: sha256Utf8(text), sourcePageId: null });
    expect(stored.spans).toEqual([expect.objectContaining({ id: span.id, startOffset: 1, endOffset: 3, quoteText: "🤖", quoteHash: sha256Utf8("🤖") })]);
    expect(validateSourceSpan(stored.text, span.startOffset, span.endOffset, span.quoteText)).toBe(true);
    expect(stored.text.slice(1, 3)).toBe(span.quoteText);
  });
});
