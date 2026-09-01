import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { cognitionDetail, listCognitions, updateCognitionUserState } from "../lib/cognitions";

async function fixture() {
  const suffix = randomUUID();
  const userA = await prisma.user.create({ data: { email: `${suffix}-a@phase10.test` } });
  const userB = await prisma.user.create({ data: { email: `${suffix}-b@phase10.test` } });
  const workspace = await prisma.workspace.create({ data: { name: `phase10-${suffix}` } });
  await prisma.workspaceMember.createMany({ data: [{ workspaceId: workspace.id, userId: userA.id, role: "OWNER" }, { workspaceId: workspace.id, userId: userB.id, role: "VIEWER" }] });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "Evidence book.md" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: `phase10/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: blob.storageKey } });
  const ingestionJob = await prisma.job.create({ data: { workspaceId: workspace.id, type: "source.ingest", payload: {} } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: ingestionJob.id, parserVersion: "test", normalizationVersion: "test", status: "SUCCEEDED" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } });
  const block = await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal: 0, kind: "PARAGRAPH", text: "Exact source evidence remains verifiable for every reader.", contentHash: suffix } });
  await prisma.currentDocumentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id } });
  return { suffix, userA, userB, workspace, document, extraction, block };
}

async function createRun(data: Awaited<ReturnType<typeof fixture>>, label: string) {
  const job = await prisma.job.create({ data: { workspaceId: data.workspace.id, type: "book.analysis", payload: {} } });
  const chunkSet = await prisma.chunkSet.create({ data: { workspaceId: data.workspace.id, sourceDocumentId: data.document.id, extractionId: data.extraction.id, chunkingVersion: `phase10-${label}`, configuration: {}, configurationHash: `${data.suffix}-${label}`, status: "SUCCEEDED" } });
  const run = await prisma.bookAnalysisRun.create({ data: { workspaceId: data.workspace.id, sourceDocumentId: data.document.id, extractionId: data.extraction.id, chunkSetId: chunkSet.id, jobId: job.id, pipelineVersion: "phase10", promptVersion: label, provider: "fixture", model: "fixture", modelVersionKey: "fixture", idempotencyKey: `phase10:${data.suffix}:${label}`, analysisIdentityHash: `phase10:${data.suffix}:${label}`, status: "SUCCEEDED", analysisStage: "COMPLETED", completedAt: new Date() } });
  const artifact = await prisma.analysisArtifact.create({ data: { analysisRunId: run.id, workspaceId: data.workspace.id, chunkSetId: chunkSet.id, extractionId: data.extraction.id, scope: "BOOK", ordinal: 0, structuredOutput: {} } });
  return { run, chunkSet, artifact };
}

async function memory(data: Awaited<ReturnType<typeof fixture>>, run: Awaited<ReturnType<typeof createRun>>, ordinal: number, content: string, type: "SUMMARY" | "CLAIM" = "SUMMARY", evidence = false) {
  const item = await prisma.bookMemoryItem.create({ data: { workspaceId: data.workspace.id, sourceDocumentId: data.document.id, extractionId: data.extraction.id, analysisRunId: run.run.id, sourceArtifactId: run.artifact.id, type, ordinal, content, contentHash: `${content}:${ordinal}`, memoryKey: `${run.run.id}:${ordinal}` } });
  if (evidence) await prisma.bookMemoryEvidence.create({ data: { workspaceId: data.workspace.id, analysisRunId: run.run.id, extractionId: data.extraction.id, memoryItemId: item.id, sourceBlockId: data.block.id, startOffset: 0, endOffset: 14 } });
  return item;
}

async function makeCurrent(data: Awaited<ReturnType<typeof fixture>>, run: Awaited<ReturnType<typeof createRun>>) {
  await prisma.currentBookIntelligence.upsert({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: data.document.id, workspaceId: data.workspace.id } }, create: { workspaceId: data.workspace.id, sourceDocumentId: data.document.id, extractionId: data.extraction.id, chunkSetId: run.chunkSet.id, analysisRunId: run.run.id }, update: { extractionId: data.extraction.id, chunkSetId: run.chunkSet.id, analysisRunId: run.run.id } });
}

afterAll(() => prisma.$disconnect());

describe("Phase 10 cognition product read model", () => {
  it("uses only the current lineage, slices valid evidence exactly, bounds stable pages, and isolates workspaces", async () => {
    const data = await fixture();
    const first = await createRun(data, "a");
    const current = await memory(data, first, 0, "Current evidence-backed cognition", "CLAIM", true);
    const malformed = await prisma.bookMemoryEvidence.create({ data: { workspaceId: data.workspace.id, analysisRunId: first.run.id, extractionId: data.extraction.id, memoryItemId: current.id, sourceBlockId: data.block.id, startOffset: 3, endOffset: 999 } });
    for (let ordinal = 1; ordinal <= 27; ordinal++) await memory(data, first, ordinal, `Cognition ${ordinal}`);
    await makeCurrent(data, first);
    const identityA = { workspaceId: data.workspace.id, userId: data.userA.id };
    const page1 = await listCognitions(identityA, { pageSize: 20 });
    const page2 = await listCognitions(identityA, { pageSize: 20, cursor: page1.nextCursor });
    expect(page1.items).toHaveLength(20);
    expect(page2.items).toHaveLength(8);
    expect(new Set([...page1.items, ...page2.items].map((item) => item.id)).size).toBe(28);
    const detail = await cognitionDetail(identityA, current.id);
    expect(detail?.evidence).toEqual([{ id: expect.any(String), excerpt: data.block.text.slice(0, 14), blockOrdinal: 0 }]);
    expect(detail?.evidence.some((item) => item.id === malformed.id)).toBe(false);
    expect((await listCognitions(identityA, { types: ["CLAIM"] })).items.map((item) => item.id)).toEqual([current.id]);
    const foreign = await fixture();
    const foreignIdentity = { workspaceId: foreign.workspace.id, userId: foreign.userA.id };
    expect(await cognitionDetail(foreignIdentity, current.id)).toBeNull();
    await expect(updateCognitionUserState(foreignIdentity, { cognitionId: current.id, saved: true })).rejects.toThrow("COGNITION_NOT_FOUND");
  });

  it("keeps state user-scoped and never transfers it to a regenerated cognition version", async () => {
    const data = await fixture();
    const runA = await createRun(data, "a");
    const cognitionA = await memory(data, runA, 0, "Run A cognition");
    await makeCurrent(data, runA);
    const identityA = { workspaceId: data.workspace.id, userId: data.userA.id };
    const identityB = { workspaceId: data.workspace.id, userId: data.userB.id };
    await expect(updateCognitionUserState(identityA, { cognitionId: cognitionA.id, saved: true })).resolves.toEqual({ saved: true });
    expect((await cognitionDetail(identityA, cognitionA.id))?.saved).toBe(true);
    expect((await cognitionDetail(identityB, cognitionA.id))?.saved).toBe(false);
    await expect(updateCognitionUserState(identityA, { cognitionId: cognitionA.id, saved: false })).resolves.toEqual({ saved: false });
    expect((await cognitionDetail(identityA, cognitionA.id))?.saved).toBe(false);
    expect(await prisma.userCognitionState.findUniqueOrThrow({ where: { workspaceId_userId_memoryItemId: { workspaceId: data.workspace.id, userId: data.userA.id, memoryItemId: cognitionA.id } } })).toMatchObject({ state: "ARCHIVED" });
    await expect(updateCognitionUserState(identityA, { cognitionId: cognitionA.id, saved: true })).resolves.toEqual({ saved: true });
    const runB = await createRun(data, "b");
    const cognitionB = await memory(data, runB, 0, "Run B cognition");
    await makeCurrent(data, runB);
    expect(await cognitionDetail(identityA, cognitionA.id)).toBeNull();
    expect((await cognitionDetail(identityA, cognitionB.id))?.saved).toBe(false);
    expect((await listCognitions(identityA)).items.map((item) => item.id)).toEqual([cognitionB.id]);
    await expect(updateCognitionUserState(identityA, { cognitionId: cognitionA.id, saved: false })).rejects.toThrow("COGNITION_NOT_FOUND");
    expect(await prisma.userCognitionState.count({ where: { workspaceId: data.workspace.id, userId: data.userA.id, memoryItemId: cognitionA.id } })).toBe(1);
  });
});
