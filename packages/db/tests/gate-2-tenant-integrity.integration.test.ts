import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/index.js";

const workspaces: string[] = [];

async function createWorkspace() {
  const workspace = await prisma.workspace.create({ data: { name: `gate-2-${crypto.randomUUID()}` } });
  workspaces.push(workspace.id);
  return workspace;
}

async function createBlob(workspaceId: string) {
  const suffix = crypto.randomUUID();
  return prisma.sourceBlob.create({ data: { workspaceId, sha256: `sha-${suffix}`, sizeBytes: 1, mediaType: "text/plain", storageKey: `gate-2/${suffix}` } });
}

async function createSource(workspaceId: string, editionId?: string) {
  return prisma.source.create({ data: { workspaceId, editionId, kind: "FILE", displayName: `gate-2-${crypto.randomUUID()}.txt` } });
}

async function createDocument(workspaceId: string) {
  const [blob, source] = await Promise.all([createBlob(workspaceId), createSource(workspaceId)]);
  return prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId, version: 1, sha256: blob.sha256, sizeBytes: 1, mediaType: "text/plain", storageKey: blob.storageKey } });
}

async function createSession(workspaceId: string) {
  const suffix = crypto.randomUUID();
  return prisma.uploadSession.create({ data: { workspaceId, originalFilename: `${suffix}.txt`, declaredMediaType: "text/plain", declaredSizeBytes: 1, temporaryStorageKey: `temporary/${suffix}`, expiresAt: new Date(Date.now() + 60_000) } });
}

afterEach(async () => {
  if (!workspaces.length) return;
  await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.uploadCompletion.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.uploadSession.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.job.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.projectSource.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.source.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.edition.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.work.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.project.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaces } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
  workspaces.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Gate 2 tenant integrity", () => {
  it("accepts a complete same-workspace relation graph", async () => {
    const workspace = await createWorkspace();
    const work = await prisma.work.create({ data: { workspaceId: workspace.id, title: "Gate 2 work" } });
    const edition = await prisma.edition.create({ data: { workspaceId: workspace.id, workId: work.id } });
    const source = await createSource(workspace.id, edition.id);
    const project = await prisma.project.create({ data: { workspaceId: workspace.id, name: "Gate 2 project" } });
    const projectSource = await prisma.projectSource.create({ data: { workspaceId: workspace.id, projectId: project.id, sourceId: source.id } });
    const blob = await createBlob(workspace.id);
    const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: blob.sha256, sizeBytes: 1, mediaType: "text/plain", storageKey: blob.storageKey } });
    const session = await createSession(workspace.id);
    const completion = await prisma.uploadCompletion.create({ data: { workspaceId: workspace.id, uploadSessionId: session.id, sourceDocumentId: document.id } });
    const job = await prisma.job.create({ data: { workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id } } });
    const run = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: job.id, parserVersion: "test", normalizationVersion: "test" } });

    expect(edition.workspaceId).toBe(workspace.id);
    expect(source.workspaceId).toBe(workspace.id);
    expect(projectSource.workspaceId).toBe(workspace.id);
    expect(document.workspaceId).toBe(workspace.id);
    expect(completion.workspaceId).toBe(workspace.id);
    expect(job.workspaceId).toBe(workspace.id);
    expect(run.workspaceId).toBe(workspace.id);
  });

  it("rejects cross-workspace Edition -> Work", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const workA = await prisma.work.create({ data: { workspaceId: workspaceA.id, title: "Work A" } });

    await expect(prisma.edition.create({ data: { workspaceId: workspaceB.id, workId: workA.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects cross-workspace Source -> Edition", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const workA = await prisma.work.create({ data: { workspaceId: workspaceA.id, title: "Work A" } });
    const editionA = await prisma.edition.create({ data: { workspaceId: workspaceA.id, workId: workA.id } });

    await expect(createSource(workspaceB.id, editionA.id)).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects a ProjectSource with a cross-workspace source", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const projectA = await prisma.project.create({ data: { workspaceId: workspaceA.id, name: "Project A" } });
    const sourceB = await createSource(workspaceB.id);

    await expect(prisma.projectSource.create({ data: { workspaceId: workspaceA.id, projectId: projectA.id, sourceId: sourceB.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects a ProjectSource with a cross-workspace project", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const projectA = await prisma.project.create({ data: { workspaceId: workspaceA.id, name: "Project A" } });
    const sourceB = await createSource(workspaceB.id);

    await expect(prisma.projectSource.create({ data: { workspaceId: workspaceB.id, projectId: projectA.id, sourceId: sourceB.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects a SourceDocument with a cross-workspace Source", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const [blobA, sourceB] = await Promise.all([createBlob(workspaceA.id), createSource(workspaceB.id)]);

    await expect(prisma.sourceDocument.create({ data: { workspaceId: workspaceA.id, sourceId: sourceB.id, sourceBlobId: blobA.id, version: 1, sha256: blobA.sha256, sizeBytes: 1, mediaType: "text/plain", storageKey: blobA.storageKey } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects a SourceDocument with a cross-workspace SourceBlob", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const [sourceA, blobB] = await Promise.all([createSource(workspaceA.id), createBlob(workspaceB.id)]);

    await expect(prisma.sourceDocument.create({ data: { workspaceId: workspaceA.id, sourceId: sourceA.id, sourceBlobId: blobB.id, version: 1, sha256: blobB.sha256, sizeBytes: 1, mediaType: "text/plain", storageKey: blobB.storageKey } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects an UploadCompletion with a cross-workspace UploadSession", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const [documentA, sessionB] = await Promise.all([createDocument(workspaceA.id), createSession(workspaceB.id)]);

    await expect(prisma.uploadCompletion.create({ data: { workspaceId: workspaceA.id, uploadSessionId: sessionB.id, sourceDocumentId: documentA.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects an UploadCompletion with a cross-workspace SourceDocument", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const [sessionA, documentB] = await Promise.all([createSession(workspaceA.id), createDocument(workspaceB.id)]);

    await expect(prisma.uploadCompletion.create({ data: { workspaceId: workspaceA.id, uploadSessionId: sessionA.id, sourceDocumentId: documentB.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("enforces one completion per upload session and source document", async () => {
    const workspace = await createWorkspace();
    const [documentA, documentB, sessionA, sessionB] = await Promise.all([createDocument(workspace.id), createDocument(workspace.id), createSession(workspace.id), createSession(workspace.id)]);

    await prisma.uploadCompletion.create({ data: { workspaceId: workspace.id, uploadSessionId: sessionA.id, sourceDocumentId: documentA.id } });
    await expect(prisma.uploadCompletion.create({ data: { workspaceId: workspace.id, uploadSessionId: sessionA.id, sourceDocumentId: documentB.id } })).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.uploadCompletion.create({ data: { workspaceId: workspace.id, uploadSessionId: sessionB.id, sourceDocumentId: documentA.id } })).rejects.toMatchObject({ code: "P2002" });
  });

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
});
