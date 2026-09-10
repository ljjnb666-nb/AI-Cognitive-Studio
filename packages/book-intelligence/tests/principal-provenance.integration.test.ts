import crypto from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { materializeChunkSet, recoverBookAnalysisForUser, requestBookAnalysis, requestBookAnalysisForUser } from "../src/index.js";

const workspaces: string[] = [], users: string[] = [];

async function fixture() {
  const suffix = crypto.randomUUID();
  const owner = await prisma.user.create({ data: { email: `owner-${suffix}@test` } });
  const member = await prisma.user.create({ data: { email: `member-${suffix}@test` } });
  const outsider = await prisma.user.create({ data: { email: `outsider-${suffix}@test` } });
  users.push(owner.id, member.id, outsider.id);
  const workspace = await prisma.workspace.create({ data: { name: suffix } });
  workspaces.push(workspace.id);
  await prisma.workspaceMember.createMany({ data: [{ workspaceId: workspace.id, userId: owner.id, role: "OWNER" }, { workspaceId: workspace.id, userId: member.id, role: "EDITOR" }] });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "book.md" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: suffix, sizeBytes: BigInt(1), mediaType: "text/markdown", storageKey: `test/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: BigInt(1), mediaType: "text/markdown", storageKey: blob.storageKey } });
  const ingest = await prisma.job.create({ data: { workspaceId: workspace.id, userId: owner.id, type: "source.ingest", payload: {}, idempotencyKey: `ingest:${suffix}` } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: ingest.id, parserVersion: "test", normalizationVersion: "test" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } });
  await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal: 0, kind: "PARAGRAPH", text: "durable provenance", contentHash: suffix } });
  await prisma.currentDocumentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id } });
  const chunkSet = await materializeChunkSet({ workspaceId: workspace.id, sourceDocumentId: document.id, configuration: { targetSize: 80, hardMax: 100 } });
  const input = { sourceDocumentId: document.id, chunkSetId: chunkSet.id, pipelineVersion: `provenance-${suffix}`, promptVersion: "p", provider: "test", model: "test" };
  return { owner, member, outsider, workspace, document, input };
}

afterEach(async () => {
  for (const workspaceId of workspaces.splice(0)) {
    await prisma.currentBookIntelligence.deleteMany({ where: { workspaceId } });
    await prisma.bookAnalysisRun.deleteMany({ where: { workspaceId } });
    await prisma.chunkSet.deleteMany({ where: { workspaceId } });
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId } });
    await prisma.job.deleteMany({ where: { workspaceId } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId } });
    await prisma.source.deleteMany({ where: { workspaceId } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(() => prisma.$disconnect());

describe("BookAnalysis durable initiating principal", () => {
  it("persists the authorized initiating user without changing idempotency or existing provenance", async () => {
    const value = await fixture();
    const first = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    expect(first.job).toMatchObject({ userId: value.owner.id, workspaceId: value.workspace.id });
    expect(first.run.jobId).toBe(first.job.id);
    const duplicate = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.member.id }, value.input);
    expect(duplicate.run.id).toBe(first.run.id);
    expect(duplicate.job.userId).toBe(value.owner.id);
  });

  it("rejects a non-member before creating durable rows", async () => {
    const value = await fixture();
    await expect(requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.outsider.id }, value.input)).rejects.toThrow("WORKSPACE_ACCESS_DENIED");
    expect(await prisma.bookAnalysisRun.count({ where: { workspaceId: value.workspace.id } })).toBe(0);
    expect(await prisma.job.count({ where: { workspaceId: value.workspace.id, type: "book.analysis" } })).toBe(0);
  });

  it("does not backfill actor-null durable state", async () => {
    const value = await fixture();
    const system = await requestBookAnalysis({ workspaceId: value.workspace.id, ...value.input });
    expect(system.job.userId).toBeNull();
    const duplicate = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    expect(duplicate.run.id).toBe(system.run.id);
    expect(duplicate.job.userId).toBeNull();
  });

  it("repairs a succeeded analysis marker concurrently without ingestion or provider replay", async () => {
    const value = await fixture();
    const requested = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "SUCCEEDED", analysisStage: "COMPLETED", completedAt: new Date() } });
    const ingestionBefore = await prisma.ingestionRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id } });
    const repairs = await Promise.all(Array.from({ length: 5 }, () => recoverBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.document.id)));
    expect(repairs.filter(repair => repair.repaired)).toHaveLength(1);
    expect(await prisma.currentBookIntelligence.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: value.document.id, workspaceId: value.workspace.id } } })).toMatchObject({ analysisRunId: requested.run.id, chunkSetId: requested.run.chunkSetId });
    expect(await prisma.ingestionRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id } })).toBe(ingestionBefore);
    expect(await prisma.bookAnalysisRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id } })).toBe(1);
  });

  it("requeues failed analysis without replaying ingestion and keeps foreign recovery private", async () => {
    const value = await fixture();
    const requested = await requestBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.input);
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "FAILED", errorCode: "SAFE_FAILURE" } });
    const ingestionBefore = await prisma.ingestionRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id } });
    await expect(recoverBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.outsider.id }, value.document.id)).rejects.toThrow("WORKSPACE_ACCESS_DENIED");
    const recoveries = await Promise.all(Array.from({ length: 5 }, () => recoverBookAnalysisForUser({ workspaceId: value.workspace.id, userId: value.owner.id }, value.document.id)));
    expect(recoveries.filter(recovery => recovery.created)).toHaveLength(1);
    expect(await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: requested.run.id } })).toMatchObject({ status: "QUEUED" });
    expect(await prisma.ingestionRun.count({ where: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id } })).toBe(ingestionBefore);
  });
});
