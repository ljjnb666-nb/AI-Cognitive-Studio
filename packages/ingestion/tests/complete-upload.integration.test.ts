import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import type { StorageProvider } from "@ai-cognitive/storage";
import { createIngestionService } from "../src/index.js";
import { SOURCE_SNIFF_PREFIX_BYTES } from "../src/object-inspection.js";

const workspaceIds: string[] = [];
const userIds: string[] = [];
const outboxAggregateIds: string[] = [];

class FakeStorageProvider implements StorageProvider {
  readonly objects = new Map<string, Uint8Array>();
  readonly headSizes = new Map<string, number>();
  readonly deletedKeys: string[] = [];
  forbidGetObjectBytes = false;
  streamChunkSize = Number.MAX_SAFE_INTEGER;
  copyTransform?: (source: Uint8Array, sourceKey: string, targetKey: string) => Uint8Array;

  async createPresignedUpload(input: { key: string; contentType: string; expiresInSeconds: number }) {
    return { url: `https://storage.test/${input.key}`, headers: { "content-type": input.contentType } };
  }

  async headObject(key: string) {
    const body = this.objects.get(key);
    return body ? { key, size: this.headSizes.get(key) ?? body.length, contentType: "text/plain" } : null;
  }

  async getObjectStream(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error(`OBJECT_NOT_FOUND:${key}`);
    const chunkSize = this.streamChunkSize;
    return (async function* () {
      for (let offset = 0; offset < body.length; offset += chunkSize) yield body.subarray(offset, offset + chunkSize);
    })();
  }

  async getObjectBytes(key: string) {
    if (this.forbidGetObjectBytes) throw new Error("GET_OBJECT_BYTES_FORBIDDEN");
    const body = this.objects.get(key);
    if (!body) throw new Error(`OBJECT_NOT_FOUND:${key}`);
    return body;
  }

  async putObject({ key, body }: { key: string; body: Uint8Array; contentType: string }) {
    this.objects.set(key, body);
  }

  async copyObject(sourceKey: string, targetKey: string) {
    const source = this.objects.get(sourceKey);
    if (!source) throw new Error(`OBJECT_NOT_FOUND:${sourceKey}`);
    this.objects.set(targetKey, this.copyTransform?.(source, sourceKey, targetKey) ?? source);
  }

  async deleteObject(key: string) {
    this.deletedKeys.push(key);
    this.objects.delete(key);
  }

  async objectExists(key: string) {
    return this.objects.has(key);
  }
}

async function createWorkspaceFixture() {
  const user = await prisma.user.create({ data: { email: `ingestion-${crypto.randomUUID()}@test`, name: "Ingestion" } });
  const workspace = await prisma.workspace.create({ data: { name: `ingestion-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  return { user, workspace };
}

async function createCompletedFixture() {
  const { user, workspace } = await createWorkspaceFixture();
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: crypto.randomUUID(), sizeBytes: 1, mediaType: "text/plain", storageKey: "test" } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "test.txt" } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: blob.sha256, sizeBytes: 1, mediaType: "text/plain", storageKey: "test" } });
  const session = await prisma.uploadSession.create({ data: { workspaceId: workspace.id, originalFilename: "test.txt", declaredMediaType: "text/plain", declaredSizeBytes: 1, temporaryStorageKey: "test", status: "COMPLETED", expiresAt: new Date(Date.now() + 60_000) } });
  await prisma.uploadCompletion.create({ data: { workspaceId: workspace.id, uploadSessionId: session.id, sourceDocumentId: document.id } });
  return { user, workspace, document, session };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function createPendingUpload(storage: FakeStorageProvider, bytes: Uint8Array, input: { filename?: string; mediaType?: string } = {}) {
  const { user, workspace } = await createWorkspaceFixture();
  const context = { userId: user.id, workspaceId: workspace.id };
  const service = createIngestionService(storage);
  const { session } = await service.createUploadIntent(context, { filename: input.filename ?? "source.txt", mediaType: input.mediaType ?? "text/plain", sizeBytes: bytes.byteLength });
  storage.objects.set(session.temporaryStorageKey, bytes);
  return { context, service, session, workspace };
}

afterEach(async () => {
  if (outboxAggregateIds.length) await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: outboxAggregateIds } } });
  if (workspaceIds.length) {
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.bookAnalysisBootstrap.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceSpan.deleteMany({ where: { sourceBlock: { extraction: { workspaceId: { in: workspaceIds } } } } });
    await prisma.sourceBlock.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } } });
    await prisma.sourcePage.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.uploadCompletion.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.uploadSession.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.projectSource.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.edition.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.work.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.project.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  workspaceIds.length = 0;
  userIds.length = 0;
  outboxAggregateIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("completeUpload", () => {
  it("returns the authoritative document from UploadCompletion", async () => {
    const value = await createCompletedFixture();
    const service = createIngestionService(new FakeStorageProvider());

    await expect(service.completeUpload({ userId: value.user.id, workspaceId: value.workspace.id }, value.session.id)).resolves.toMatchObject({ id: value.document.id });
  });

  it("rejects a session from another workspace", async () => {
    const value = await createCompletedFixture();
    const other = await prisma.workspace.create({ data: { name: `other-${crypto.randomUUID()}` } });
    workspaceIds.push(other.id);
    await prisma.workspaceMember.create({ data: { workspaceId: other.id, userId: value.user.id, role: "OWNER" } });
    const service = createIngestionService(new FakeStorageProvider());

    await expect(service.completeUpload({ userId: value.user.id, workspaceId: other.id }, value.session.id)).rejects.toThrow();
  });

  it("creates one complete workspace-scoped ingestion transaction and reuses it sequentially", async () => {
    const { user, workspace } = await createWorkspaceFixture();
    const storage = new FakeStorageProvider();
    const service = createIngestionService(storage);
    const context = { userId: user.id, workspaceId: workspace.id };
    const bytes = Buffer.from("hello phase one");
    const { session } = await service.createUploadIntent(context, { filename: "phase-one.txt", mediaType: "text/plain", sizeBytes: bytes.length });
    storage.objects.set(session.temporaryStorageKey, bytes);

    const document = await service.completeUpload(context, session.id);
    const source = await prisma.source.findFirstOrThrow({ where: { workspaceId: workspace.id, id: document.sourceId } });
    const blob = await prisma.sourceBlob.findFirstOrThrow({ where: { workspaceId: workspace.id, id: document.sourceBlobId } });
    const completion = await prisma.uploadCompletion.findUniqueOrThrow({ where: { uploadSessionId_workspaceId: { uploadSessionId: session.id, workspaceId: workspace.id } } });
    const run = await prisma.ingestionRun.findFirstOrThrow({ where: { workspaceId: workspace.id, sourceDocumentId: document.id }, include: { job: true } });
    const completedSession = await prisma.uploadSession.findUniqueOrThrow({ where: { id: session.id } });
    const outbox = await prisma.outboxEvent.findMany({ where: { aggregateId: run.id, topic: "source.ingestion.requested" } });
    outboxAggregateIds.push(run.id);

    expect(source.workspaceId).toBe(workspace.id);
    expect(blob.workspaceId).toBe(workspace.id);
    expect(document.workspaceId).toBe(workspace.id);
    expect(completion).toMatchObject({ workspaceId: workspace.id, uploadSessionId: session.id, sourceDocumentId: document.id });
    expect(run).toMatchObject({ workspaceId: workspace.id, sourceDocumentId: document.id, jobId: run.job.id });
    expect(run.job).toMatchObject({ type: "source.ingest", workspaceId: workspace.id, userId: user.id });
    expect(completedSession).toMatchObject({ status: "COMPLETED" });
    expect(completedSession.completedAt).not.toBeNull();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ aggregateId: run.id, topic: "source.ingestion.requested", payload: { ingestionRunId: run.id } });

    await expect(service.completeUpload(context, session.id)).resolves.toMatchObject({ id: document.id });

    await expect(prisma.source.count({ where: { workspaceId: workspace.id } })).resolves.toBe(1);
    await expect(prisma.sourceDocument.count({ where: { workspaceId: workspace.id } })).resolves.toBe(1);
    await expect(prisma.job.count({ where: { workspaceId: workspace.id } })).resolves.toBe(1);
    await expect(prisma.ingestionRun.count({ where: { workspaceId: workspace.id } })).resolves.toBe(1);
    await expect(prisma.uploadCompletion.count({ where: { workspaceId: workspace.id } })).resolves.toBe(1);
    await expect(prisma.outboxEvent.count({ where: { aggregateId: run.id, topic: "source.ingestion.requested" } })).resolves.toBe(1);
  });

  it("never uses the whole-object compatibility method during completion", async () => {
    const storage = new FakeStorageProvider();
    storage.forbidGetObjectBytes = true;
    const value = await createPendingUpload(storage, Buffer.from("stream-only completion"));

    await expect(value.service.completeUpload(value.context, value.session.id)).resolves.toMatchObject({ workspaceId: value.workspace.id });
  });

  it("uses the full stream for identity while retaining only a bounded sniff prefix", async () => {
    const storage = new FakeStorageProvider();
    storage.streamChunkSize = 257;
    const bytes = Buffer.alloc(SOURCE_SNIFF_PREFIX_BYTES * 4, "x");
    const value = await createPendingUpload(storage, bytes);

    const document = await value.service.completeUpload(value.context, value.session.id);
    const blob = await prisma.sourceBlob.findUniqueOrThrow({ where: { id: document.sourceBlobId } });
    expect(blob.sha256).toBe(sha256(bytes));
    expect(blob.sizeBytes).toBe(BigInt(bytes.byteLength));
  });

  it("rejects a head and streamed-size mismatch before creating database records", async () => {
    const storage = new FakeStorageProvider();
    const bytes = Buffer.from("mismatched stream");
    const value = await createPendingUpload(storage, bytes);
    storage.headSizes.set(value.session.temporaryStorageKey, bytes.byteLength - 1);

    await expect(value.service.completeUpload(value.context, value.session.id)).rejects.toThrow("UPLOAD_SIZE_INVALID");
    await expect(prisma.sourceDocument.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
    await expect(prisma.sourceBlob.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
  });

  it("rejects when the streamed bytes no longer match an otherwise valid head and declaration", async () => {
    const storage = new FakeStorageProvider();
    const bytes = Buffer.from("stream changed after head");
    const value = await createPendingUpload(storage, bytes);
    const expectedSize = bytes.byteLength - 1;
    await prisma.uploadSession.update({ where: { id: value.session.id }, data: { declaredSizeBytes: expectedSize } });
    storage.headSizes.set(value.session.temporaryStorageKey, expectedSize);

    await expect(value.service.completeUpload(value.context, value.session.id)).rejects.toThrow("UPLOAD_STORAGE_SIZE_MISMATCH");
    await expect(prisma.sourceDocument.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
    await expect(prisma.sourceBlob.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
  });

  it("rejects a canonical object changed during copy and removes the newly created corrupt object", async () => {
    const storage = new FakeStorageProvider();
    const original = Buffer.from("temporary bytes A");
    const corrupt = Buffer.from("canonical bytes B");
    const value = await createPendingUpload(storage, original);
    const canonicalKey = `workspaces/${value.workspace.id}/source-blobs/${sha256(original)}`;
    storage.copyTransform = () => corrupt;

    await expect(value.service.completeUpload(value.context, value.session.id)).rejects.toThrow("CANONICAL_STORAGE_INTEGRITY_FAILURE");
    expect(storage.deletedKeys).toContain(canonicalKey);
    expect(storage.objects.has(canonicalKey)).toBe(false);
    await expect(prisma.sourceBlob.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
    await expect(prisma.sourceDocument.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
  });

  it("adopts a valid orphan canonical object after streaming verification", async () => {
    const storage = new FakeStorageProvider();
    const bytes = Buffer.from("orphan canonical bytes");
    const value = await createPendingUpload(storage, bytes);
    const canonicalKey = `workspaces/${value.workspace.id}/source-blobs/${sha256(bytes)}`;
    storage.objects.set(canonicalKey, bytes);

    const document = await value.service.completeUpload(value.context, value.session.id);
    await expect(prisma.sourceBlob.findUniqueOrThrow({ where: { id: document.sourceBlobId } })).resolves.toMatchObject({ sha256: sha256(bytes), storageKey: canonicalKey });
  });

  it("rejects a corrupt orphan canonical object without overwriting it", async () => {
    const storage = new FakeStorageProvider();
    const bytes = Buffer.from("expected canonical bytes");
    const corrupt = Buffer.from("corrupt orphan canonical bytes");
    const value = await createPendingUpload(storage, bytes);
    const canonicalKey = `workspaces/${value.workspace.id}/source-blobs/${sha256(bytes)}`;
    storage.objects.set(canonicalKey, corrupt);

    await expect(value.service.completeUpload(value.context, value.session.id)).rejects.toThrow("CANONICAL_STORAGE_INTEGRITY_FAILURE");
    expect(storage.objects.get(canonicalKey)).toEqual(corrupt);
    await expect(prisma.sourceBlob.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
  });

  it("rejects an existing database blob whose canonical object is missing", async () => {
    const storage = new FakeStorageProvider();
    const bytes = Buffer.from("existing missing blob");
    const value = await createPendingUpload(storage, bytes);
    const storageKey = `workspaces/${value.workspace.id}/source-blobs/${sha256(bytes)}`;
    await prisma.sourceBlob.create({ data: { workspaceId: value.workspace.id, sha256: sha256(bytes), sizeBytes: bytes.byteLength, mediaType: "text/plain", storageKey } });

    await expect(value.service.completeUpload(value.context, value.session.id)).rejects.toThrow("CANONICAL_STORAGE_INTEGRITY_FAILURE");
    await expect(prisma.sourceDocument.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
  });

  it("deduplicates sequential uploads while creating two source documents", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const context = { userId: user.id, workspaceId: workspace.id };
    const service = createIngestionService(storage);
    const bytes = Buffer.from("sequential duplicate bytes");
    const first = await service.createUploadIntent(context, { filename: "first.txt", mediaType: "text/plain", sizeBytes: bytes.byteLength });
    const second = await service.createUploadIntent(context, { filename: "second.txt", mediaType: "text/plain", sizeBytes: bytes.byteLength });
    storage.objects.set(first.session.temporaryStorageKey, bytes);
    storage.objects.set(second.session.temporaryStorageKey, bytes);

    const firstDocument = await service.completeUpload(context, first.session.id);
    const secondDocument = await service.completeUpload(context, second.session.id);
    expect(firstDocument.sourceBlobId).toBe(secondDocument.sourceBlobId);
    await expect(prisma.sourceBlob.count({ where: { workspaceId: workspace.id } })).resolves.toBe(1);
    await expect(prisma.sourceDocument.count({ where: { workspaceId: workspace.id } })).resolves.toBe(2);
  });

  it("deduplicates bytes without deduplicating TXT and Markdown interpretation", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const context = { userId: user.id, workspaceId: workspace.id };
    const service = createIngestionService(storage);
    const bytes = Buffer.from("# Heading\n\nParagraph.");
    const txt = await service.createUploadIntent(context, { filename: "same.txt", mediaType: "text/plain", sizeBytes: bytes.byteLength });
    const markdown = await service.createUploadIntent(context, { filename: "same.md", mediaType: "text/markdown", sizeBytes: bytes.byteLength });
    storage.objects.set(txt.session.temporaryStorageKey, bytes);
    storage.objects.set(markdown.session.temporaryStorageKey, bytes);

    const txtDocument = await service.completeUpload(context, txt.session.id);
    const markdownDocument = await service.completeUpload(context, markdown.session.id);
    const [txtRun, markdownRun] = await Promise.all([
      prisma.ingestionRun.findFirstOrThrow({ where: { sourceDocumentId: txtDocument.id, workspaceId: workspace.id } }),
      prisma.ingestionRun.findFirstOrThrow({ where: { sourceDocumentId: markdownDocument.id, workspaceId: workspace.id } }),
    ]);

    expect(txtDocument.sourceBlobId).toBe(markdownDocument.sourceBlobId);
    expect(txtDocument.mediaType).toBe("text/plain");
    expect(markdownDocument.mediaType).toBe("text/markdown");
    expect(txtRun.parserVersion).toBe("text-parser-v1");
    expect(markdownRun.parserVersion).toBe("markdown-parser-v1");
    await expect(prisma.sourceBlob.count({ where: { workspaceId: workspace.id } })).resolves.toBe(1);
    await expect(prisma.sourceDocument.count({ where: { workspaceId: workspace.id } })).resolves.toBe(2);

    await service.processIngestionRun(txtRun.id);
    await service.processIngestionRun(markdownRun.id);
    const [txtExtraction, markdownExtraction, txtBlocks, markdownBlocks, current] = await Promise.all([
      prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: txtRun.id } }),
      prisma.documentExtraction.findUniqueOrThrow({ where: { ingestionRunId: markdownRun.id } }),
      prisma.sourceBlock.findMany({ where: { extraction: { ingestionRunId: txtRun.id } }, orderBy: { ordinal: "asc" } }),
      prisma.sourceBlock.findMany({ where: { extraction: { ingestionRunId: markdownRun.id } }, orderBy: { ordinal: "asc" } }),
      prisma.currentDocumentExtraction.findMany({ where: { workspaceId: workspace.id } }),
    ]);

    expect(txtBlocks[0]).toMatchObject({ kind: "PARAGRAPH", text: "# Heading" });
    expect(markdownBlocks[0]).toMatchObject({ kind: "HEADING", text: "# Heading" });
    expect(txtExtraction).toMatchObject({ parserName: "builtin-text", parserVersion: "text-parser-v1" });
    expect(markdownExtraction).toMatchObject({ parserName: "builtin-markdown", parserVersion: "markdown-parser-v1" });
    expect(current.map((entry) => entry.sourceDocumentId).sort()).toEqual([txtDocument.id, markdownDocument.id].sort());
  });

  it("converges same-session completion and prevents the non-owner from starting storage work", async () => {
    const storage = new FakeStorageProvider();
    const value = await createPendingUpload(storage, Buffer.from("same session concurrent"));
    const first = value.service.completeUpload(value.context, value.session.id);
    const second = value.service.completeUpload(value.context, value.session.id);
    const outcomes = await Promise.allSettled([first, second]);
    const success = outcomes.find((outcome) => outcome.status === "fulfilled");
    const inProgress = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(success?.status).toBe("fulfilled");
    if (!success || success.status !== "fulfilled") throw new Error("expected one completion owner");
    expect(success.value.id).toBeDefined();
    expect(inProgress?.reason).toMatchObject({ message: "UPLOAD_COMPLETION_IN_PROGRESS" });
    const retried = await value.service.completeUpload(value.context, value.session.id);
    expect(retried.id).toBe(success?.value.id);
    await expect(prisma.uploadCompletion.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(1);
    await expect(prisma.sourceDocument.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(1);
    await expect(prisma.job.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(1);
    await expect(prisma.ingestionRun.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(1);
  });

  it("reclaims a stale completion claim and clears ownership fields on completion", async () => {
    const storage = new FakeStorageProvider();
    const value = await createPendingUpload(storage, Buffer.from("stale completion claim"));
    await prisma.uploadSession.update({ where: { id: value.session.id }, data: { status: "COMPLETING", completionClaimToken: "abandoned-token", completionClaimedAt: new Date(Date.now() - 10_000), completionLeaseUntil: new Date(Date.now() - 1_000) } });
    await expect(value.service.completeUpload(value.context, value.session.id)).resolves.toMatchObject({ workspaceId: value.workspace.id });
    await expect(prisma.uploadSession.findUniqueOrThrow({ where: { id: value.session.id } })).resolves.toMatchObject({ status: "COMPLETED", completionClaimToken: null, completionClaimedAt: null, completionLeaseUntil: null });
  });

  it.each(["SUCCEEDED", "REJECTED", "OCR_REQUIRED", "PASSWORD_REQUIRED"] as const)("does not re-enter parsing when a %s ingestion run is redelivered", async (status) => {
    const value = await createCompletedFixture();
    const storage = new FakeStorageProvider();
    storage.forbidGetObjectBytes = true;
    const service = createIngestionService(storage);
    const job = await prisma.job.create({
      data: {
        workspaceId: value.workspace.id,
        userId: value.user.id,
        type: "source.ingest",
        status: "FAILED",
        attemptCount: 7,
        payload: { sourceDocumentId: value.document.id },
        idempotencyKey: `terminal-redelivery:${status}:${value.document.id}`,
      },
    });
    const run = await prisma.ingestionRun.create({
      data: {
        workspaceId: value.workspace.id,
        sourceDocumentId: value.document.id,
        jobId: job.id,
        status,
        parserVersion: "terminal-redelivery-test",
        normalizationVersion: "terminal-redelivery-test",
        completedAt: new Date(),
      },
    });
    const [beforeJob, beforeExtractionCount, beforeCurrent] = await Promise.all([
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.documentExtraction.count({ where: { sourceDocumentId: value.document.id, workspaceId: value.workspace.id } }),
      prisma.currentDocumentExtraction.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: value.document.id, workspaceId: value.workspace.id } } }),
    ]);

    await service.processIngestionRun(run.id);

    const [afterRun, afterJob, afterExtractionCount, afterCurrent] = await Promise.all([
      prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } }),
      prisma.job.findUniqueOrThrow({ where: { id: job.id } }),
      prisma.documentExtraction.count({ where: { sourceDocumentId: value.document.id, workspaceId: value.workspace.id } }),
      prisma.currentDocumentExtraction.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: value.document.id, workspaceId: value.workspace.id } } }),
    ]);

    expect(afterRun.status).toBe(status);
    expect(afterJob.attemptCount).toBe(beforeJob.attemptCount);
    expect(afterJob.status).toBe(beforeJob.status);
    expect(afterJob.status).not.toBe("RUNNING");
    expect(afterExtractionCount).toBe(beforeExtractionCount);
    expect(afterCurrent).toEqual(beforeCurrent);
  });

  it("concurrently deduplicates SourceBlob while retaining one document pipeline per session", async () => {
    const storage = new FakeStorageProvider();
    const { user, workspace } = await createWorkspaceFixture();
    const context = { userId: user.id, workspaceId: workspace.id };
    const service = createIngestionService(storage);
    const bytes = Buffer.from("concurrent identical bytes");
    const [a, b] = await Promise.all([
      service.createUploadIntent(context, { filename: "a.txt", mediaType: "text/plain", sizeBytes: bytes.length }),
      service.createUploadIntent(context, { filename: "b.txt", mediaType: "text/plain", sizeBytes: bytes.length }),
    ]);
    storage.objects.set(a.session.temporaryStorageKey, bytes);
    storage.objects.set(b.session.temporaryStorageKey, bytes);
    const [aDocument, bDocument] = await Promise.all([service.completeUpload(context, a.session.id), service.completeUpload(context, b.session.id)]);
    expect(aDocument.sourceBlobId).toBe(bDocument.sourceBlobId);
    await expect(prisma.sourceBlob.count({ where: { workspaceId: workspace.id } })).resolves.toBe(1);
    await expect(prisma.sourceDocument.count({ where: { workspaceId: workspace.id } })).resolves.toBe(2);
    await expect(prisma.uploadCompletion.count({ where: { workspaceId: workspace.id } })).resolves.toBe(2);
    await expect(prisma.job.count({ where: { workspaceId: workspace.id } })).resolves.toBe(2);
    await expect(prisma.ingestionRun.count({ where: { workspaceId: workspace.id } })).resolves.toBe(2);
  });

  it("creates exactly one appended recovery attempt and durable outbox under concurrent retries", async () => {
    const value = await createCompletedFixture(), service = createIngestionService(new FakeStorageProvider());
    const job = await prisma.job.create({ data: { workspaceId: value.workspace.id, userId: value.user.id, type: "source.ingest", status: "FAILED", payload: {}, idempotencyKey: `failed-recovery:${value.document.id}` } });
    const failed = await prisma.ingestionRun.create({ data: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id, jobId: job.id, status: "FAILED", parserVersion: "test", normalizationVersion: "test", completedAt: new Date() } });
    const attempts = await Promise.all(Array.from({ length: 5 }, () => service.recoverIngestionForUser({ workspaceId: value.workspace.id, userId: value.user.id }, value.document.id)));
    const runs = await prisma.ingestionRun.findMany({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id }, orderBy: { createdAt: "asc" } });
    const active = runs.filter((run) => run.status === "QUEUED");
    expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
    expect(runs).toHaveLength(2);
    expect(active).toHaveLength(1);
    expect(runs.find((run) => run.id === failed.id)?.status).toBe("FAILED");
    outboxAggregateIds.push(active[0]!.id);
    await expect(prisma.outboxEvent.count({ where: { aggregateId: active[0]!.id, topic: "source.ingestion.requested" } })).resolves.toBe(1);
  });

  it("creates distinct serialized recovery generations after each failed retry", async () => {
    const value = await createCompletedFixture(), service = createIngestionService(new FakeStorageProvider());
    const originalJob = await prisma.job.create({ data: { workspaceId: value.workspace.id, userId: value.user.id, type: "source.ingest", status: "FAILED", payload: {}, idempotencyKey: `failed-generations:${value.document.id}` } });
    await prisma.ingestionRun.create({ data: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id, jobId: originalJob.id, status: "FAILED", parserVersion: "test", normalizationVersion: "test", completedAt: new Date() } });
    const keys: string[] = [];
    for (let generation = 1; generation <= 3; generation++) {
      const attempts = await Promise.all(Array.from({ length: 5 }, () => service.recoverIngestionForUser({ workspaceId: value.workspace.id, userId: value.user.id }, value.document.id)));
      expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
      const active = attempts.find((attempt) => attempt.created)!.run;
      const job = await prisma.job.findUniqueOrThrow({ where: { id: active.jobId } });
      if (!job.idempotencyKey) throw new Error("RECOVERY_GENERATION_KEY_MISSING");
      keys.push(job.idempotencyKey);
      await expect(prisma.outboxEvent.count({ where: { aggregateId: active.id, topic: "source.ingestion.requested" } })).resolves.toBe(1);
      await prisma.$transaction([prisma.ingestionRun.update({ where: { id: active.id }, data: { status: "FAILED", completedAt: new Date() } }), prisma.job.update({ where: { id: active.jobId }, data: { status: "FAILED", completedAt: new Date() } })]);
    }
    expect(new Set(keys).size).toBe(3);
    await expect(prisma.ingestionRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id, status: "FAILED" } })).resolves.toBe(4);
  });

  it("refuses cross-workspace recovery without mutating the source", async () => {
    const value = await createCompletedFixture(), other = await createWorkspaceFixture(), service = createIngestionService(new FakeStorageProvider());
    await expect(service.recoverIngestionForUser({ workspaceId: other.workspace.id, userId: other.user.id }, value.document.id)).rejects.toThrow("SOURCE_DOCUMENT_ACCESS_DENIED");
    await expect(prisma.ingestionRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id } })).resolves.toBe(0);
  });
});
