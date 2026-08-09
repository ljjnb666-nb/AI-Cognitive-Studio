import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import type { StorageProvider } from "@ai-cognitive/storage";
import { createIngestionService } from "../src/index.js";

const workspaceIds: string[] = [];
const userIds: string[] = [];
const outboxAggregateIds: string[] = [];

class FakeStorageProvider implements StorageProvider {
  readonly objects = new Map<string, Uint8Array>();

  async createPresignedUpload(input: { key: string; contentType: string; expiresInSeconds: number }) {
    return { url: `https://storage.test/${input.key}`, headers: { "content-type": input.contentType } };
  }

  async headObject(key: string) {
    const body = this.objects.get(key);
    return body ? { key, size: body.length, contentType: "text/plain" } : null;
  }

  async getObjectBytes(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error(`OBJECT_NOT_FOUND:${key}`);
    return body;
  }

  async putObject({ key, body }: { key: string; body: Uint8Array; contentType: string }) {
    this.objects.set(key, body);
  }

  async copyObject(sourceKey: string, targetKey: string) {
    this.objects.set(targetKey, await this.getObjectBytes(sourceKey));
  }

  async deleteObject(key: string) {
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
});
