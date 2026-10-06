import { createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";

/**
 * Test fixture helper for the OCR reconciler integration gate: creates the
 * full durable lineage (user/workspace/document/job/run) and tracks everything
 * for cleanup, mirroring the 04B-2/04B-3 integration harness.
 */

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const workspaceIds: string[] = [];
const userIds: string[] = [];
const runIds: string[] = [];

export type ReconcilerRunFixture = { workspaceId: string; documentId: string; runId: string };

const fixtures: ReconcilerRunFixture[] = [];

export const createRunFixtureHelper = {
  async create(): Promise<ReconcilerRunFixture> {
    const user = await prisma.user.create({ data: { email: `ocr-reconciler-${crypto.randomUUID()}@test`, name: "Ocr Reconciler" } });
    const workspace = await prisma.workspace.create({ data: { name: `ocr-reconciler-${crypto.randomUUID()}` } });
    userIds.push(user.id);
    workspaceIds.push(workspace.id);
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256(`blob-${crypto.randomUUID()}`), sizeBytes: 12, mediaType: "application/pdf", storageKey: `test/${crypto.randomUUID()}` } });
    const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "ocr-reconciler" } });
    const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: 12, mediaType: "application/pdf", storageKey: blob.storageKey } });
    const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id } } });
    const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "pdf-router", normalizationVersion: "canonical-text-v1", status: "QUEUED" } });
    runIds.push(run.id);
    const fixture = { workspaceId: workspace.id, documentId: document.id, runId: run.id };
    fixtures.push(fixture);
    return fixture;
  },
  async cleanup(): Promise<void> {
    if (runIds.length) {
      const bootstraps = await prisma.bookAnalysisBootstrap.findMany({ where: { ingestionRunId: { in: runIds } }, select: { id: true } });
      if (bootstraps.length) await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: bootstraps.map((bootstrap) => bootstrap.id) } } });
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
    }
    if (workspaceIds.length) {
      await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.bookAnalysisBootstrap.deleteMany({ where: { ingestionRunId: { in: runIds } } });
      await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.ocrServerInstance.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.ocrPageAttempt.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
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
    fixtures.length = 0;
  },
};
