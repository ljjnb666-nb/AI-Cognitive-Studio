import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import type { StorageProvider } from "@ai-cognitive/storage";
import { createHash } from "node:crypto";
import { createIngestionService } from "../src/index.js";

const workspaceIds: string[] = [];
const userIds: string[] = [];
const runIds: string[] = [];

class FakeStorageProvider implements StorageProvider {
  readonly objects = new Map<string, Uint8Array>();

  async createPresignedUpload(input: { key: string; contentType: string; expiresInSeconds: number }) {
    return { url: `https://storage.test/${input.key}`, headers: { "content-type": input.contentType } };
  }
  async headObject(key: string) { const body = this.objects.get(key); return body ? { key, size: body.length, contentType: "text/plain" } : null; }
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

async function createWorkspaceFixture() {
  const user = await prisma.user.create({ data: { email: `canonical-${crypto.randomUUID()}@test`, name: "Canonical" } });
  const workspace = await prisma.workspace.create({ data: { name: `canonical-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  return { user, workspace };
}

async function ingest(storage: FakeStorageProvider, mediaType: "text/plain" | "text/markdown", filename: string, content: string) {
  const { user, workspace } = await createWorkspaceFixture();
  const service = createIngestionService(storage);
  const context = { userId: user.id, workspaceId: workspace.id };
  const bytes = Buffer.from(content, "utf8");
  const { session } = await service.createUploadIntent(context, { filename, mediaType, sizeBytes: bytes.length });
  storage.objects.set(session.temporaryStorageKey, bytes);
  const document = await service.completeUpload(context, session.id);
  const run = await prisma.ingestionRun.findFirstOrThrow({ where: { sourceDocumentId: document.id, workspaceId: workspace.id } });
  runIds.push(run.id);
  await service.processIngestionRun(run.id);
  return { service, workspace, document, run };
}

afterEach(async () => {
  if (runIds.length) {
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
    const leftover = await prisma.outboxEvent.count({ where: { topic: "source.ingestion.requested", aggregateId: { in: runIds } } });
    if (leftover !== 0) throw new Error("CANONICAL_TEST_OUTBOX_CLEANUP_FAILED");
  }
  if (workspaceIds.length) {
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceSpan.deleteMany({ where: { sourceBlock: { extraction: { workspaceId: { in: workspaceIds } } } } });
    await prisma.sourceBlock.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } } });
    await prisma.sourcePage.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } } });
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

describe("canonical extraction persistence", () => {
  it("persists TXT canonical blocks without synthetic pages and establishes provenance", async () => {
    const storage = new FakeStorageProvider();
    const { workspace, document } = await ingest(storage, "text/plain", "book.txt", "\uFEFF第一段\r\n\r\nSecond 🤖 paragraph\r");
    const extraction = await prisma.documentExtraction.findFirstOrThrow({ where: { sourceDocumentId: document.id } });
    const pages = await prisma.sourcePage.findMany({ where: { extractionId: extraction.id } });
    const blocks = await prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } });
    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });

    expect(pages).toHaveLength(0);
    expect(blocks).toHaveLength(2);
    expect(blocks).toMatchObject([
      { ordinal: 0, kind: "PARAGRAPH", text: "第一段", sourcePageId: null },
      { ordinal: 1, kind: "PARAGRAPH", text: "Second 🤖 paragraph", sourcePageId: null },
    ]);
    expect(blocks.every((block) => block.contentHash === sha256(block.text))).toBe(true);
    expect(extraction).toMatchObject({ sourceDocumentId: document.id, workspaceId: workspace.id, parserName: "builtin-text", parserVersion: "text-parser-v1", normalizationVersion: "canonical-text-v1" });
    expect(current.extractionId).toBe(extraction.id);
  });

  it("persists Markdown structural kinds without synthetic pages", async () => {
    const storage = new FakeStorageProvider();
    const { document } = await ingest(storage, "text/markdown", "book.md", "# Heading\n\nParagraph.\n\n- Item\n\n> Quote\n\n```js\nconst x = 1;\n```");
    const extraction = await prisma.documentExtraction.findFirstOrThrow({ where: { sourceDocumentId: document.id } });
    const [pages, blocks] = await Promise.all([
      prisma.sourcePage.count({ where: { extractionId: extraction.id } }),
      prisma.sourceBlock.findMany({ where: { extractionId: extraction.id }, orderBy: { ordinal: "asc" } }),
    ]);

    expect(pages).toBe(0);
    expect(blocks.map((block) => block.kind)).toEqual(["HEADING", "PARAGRAPH", "LIST_ITEM", "QUOTE", "CODE"]);
    expect(blocks.every((block) => block.sourcePageId === null)).toBe(true);
  });

  it("replaces only the current pointer and preserves historical extraction blocks", async () => {
    const storage = new FakeStorageProvider();
    const { service, workspace, document, run: firstRun } = await ingest(storage, "text/plain", "book.txt", "First paragraph\n\nSecond paragraph");
    const first = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: firstRun.id } });
    const firstBlockCount = await prisma.sourceBlock.count({ where: { extractionId: first.id } });
    const job = await prisma.job.create({ data: { workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id }, idempotencyKey: `reingest:${document.id}` } });
    const secondRun = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "text-parser-v1", normalizationVersion: "canonical-text-v1" } });
    runIds.push(secondRun.id);

    await service.processIngestionRun(secondRun.id);

    const second = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: secondRun.id } });
    const current = await prisma.currentDocumentExtraction.findMany({ where: { sourceDocumentId: document.id, workspaceId: workspace.id } });
    expect(await prisma.documentExtraction.count({ where: { sourceDocumentId: document.id } })).toBe(2);
    expect(await prisma.sourceBlock.count({ where: { extractionId: first.id } })).toBe(firstBlockCount);
    expect(current).toHaveLength(1);
    expect(current[0]?.extractionId).toBe(second.id);
  });

  it("keeps the prior current pointer when a later extraction fails", async () => {
    const storage = new FakeStorageProvider();
    const { service, workspace, document, run } = await ingest(storage, "text/plain", "book.txt", "A paragraph");
    const previous = await prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: run.id } });
    const job = await prisma.job.create({ data: { workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id }, idempotencyKey: `failed-reingest:${document.id}` } });
    const failedRun = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "text-parser-v1", normalizationVersion: "canonical-text-v1" } });
    runIds.push(failedRun.id);
    storage.objects.delete(document.storageKey);

    await expect(service.processIngestionRun(failedRun.id)).rejects.toThrow("OBJECT_NOT_FOUND");

    const current = await prisma.currentDocumentExtraction.findUniqueOrThrow({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: document.id, workspaceId: workspace.id } } });
    expect(current.extractionId).toBe(previous.id);
    await expect(prisma.ingestionRun.findUniqueOrThrow({ where: { id: failedRun.id } })).resolves.toMatchObject({ status: "FAILED" });
  });
});
