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
});
