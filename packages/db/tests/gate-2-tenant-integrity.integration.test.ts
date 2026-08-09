import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/index.js";

const workspaces: string[] = [];

async function createWorkspace() {
  const workspace = await prisma.workspace.create({ data: { name: `gate-2-${crypto.randomUUID()}` } });
  workspaces.push(workspace.id);
  return workspace;
}

async function createDocument(workspaceId: string) {
  const suffix = crypto.randomUUID();
  const blob = await prisma.sourceBlob.create({ data: { workspaceId, sha256: `sha-${suffix}`, sizeBytes: 1, mediaType: "text/plain", storageKey: `gate-2/${suffix}` } });
  const source = await prisma.source.create({ data: { workspaceId, kind: "FILE", displayName: `gate-2-${suffix}.txt` } });
  return prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId, version: 1, sha256: blob.sha256, sizeBytes: 1, mediaType: "text/plain", storageKey: blob.storageKey } });
}

afterEach(async () => {
  if (!workspaces.length) return;
  await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.uploadCompletion.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.uploadSession.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.job.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.source.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
  workspaces.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Gate 2 tenant integrity", () => {
  it("keeps business jobs and ingestion runs in the document workspace", async () => {
    const workspace = await createWorkspace();
    const document = await createDocument(workspace.id);
    const job = await prisma.job.create({ data: { workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id } } });
    const run = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: job.id, parserVersion: "test", normalizationVersion: "test" } });

    expect(job.workspaceId).toBe(workspace.id);
    expect(run.workspaceId).toBe(workspace.id);
    expect(run.sourceDocumentId).toBe(document.id);
  });

  it("rejects an ingestion run whose workspace differs from its source document", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const documentB = await createDocument(workspaceB.id);
    const jobA = await prisma.job.create({ data: { workspaceId: workspaceA.id, type: "source.ingest", payload: {} } });

    await expect(prisma.ingestionRun.create({ data: { workspaceId: workspaceA.id, sourceDocumentId: documentB.id, jobId: jobA.id, parserVersion: "test", normalizationVersion: "test" } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("enforces one completion per upload session and source document", async () => {
    const workspace = await createWorkspace();
    const documentA = await createDocument(workspace.id);
    const documentB = await createDocument(workspace.id);
    const sessionA = await prisma.uploadSession.create({ data: { workspaceId: workspace.id, originalFilename: "a.txt", declaredMediaType: "text/plain", declaredSizeBytes: 1, temporaryStorageKey: "temporary/a", expiresAt: new Date(Date.now() + 60_000) } });
    const sessionB = await prisma.uploadSession.create({ data: { workspaceId: workspace.id, originalFilename: "b.txt", declaredMediaType: "text/plain", declaredSizeBytes: 1, temporaryStorageKey: "temporary/b", expiresAt: new Date(Date.now() + 60_000) } });

    const completion = await prisma.uploadCompletion.create({ data: { workspaceId: workspace.id, uploadSessionId: sessionA.id, sourceDocumentId: documentA.id } });
    expect(completion.workspaceId).toBe(workspace.id);
    await expect(prisma.uploadCompletion.create({ data: { workspaceId: workspace.id, uploadSessionId: sessionA.id, sourceDocumentId: documentB.id } })).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.uploadCompletion.create({ data: { workspaceId: workspace.id, uploadSessionId: sessionB.id, sourceDocumentId: documentA.id } })).rejects.toMatchObject({ code: "P2002" });
  });
});
