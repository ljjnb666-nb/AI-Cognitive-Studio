import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { findCrossBookCognitionConnections, MAX_CROSS_BOOK_CANDIDATES } from "../lib/cognition-associations";
import { getPersonalCognitionCorpus, recordManualCognitionReview } from "../lib/personalized-cognition";

type Identity = { workspaceId: string; userId: string };

async function makeFixture() {
  const suffix = randomUUID(), user = await prisma.user.create({ data: { email: `${suffix}@phase13-final-repair.test` } }), workspace = await prisma.workspace.create({ data: { name: `phase13-final-repair-${suffix}` } });
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const identity: Identity = { workspaceId: workspace.id, userId: user.id };
  async function current(label: string, createdAt = new Date()) {
    const key = `${suffix}-${label}-${randomUUID()}`, source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: label } }), blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: key, sizeBytes: 1, mediaType: "text/plain", storageKey: key } }), document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: key, sizeBytes: 1, mediaType: "text/plain", storageKey: key } }), ingestJob = await prisma.job.create({ data: { workspaceId: workspace.id, userId: user.id, type: "source.ingest", status: "SUCCEEDED", payload: {} } }), ingestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: ingestJob.id, parserVersion: "phase13", normalizationVersion: "phase13", status: "SUCCEEDED" } }), extraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "phase13", parserVersion: "phase13", normalizationVersion: "phase13" } }), analysisJob = await prisma.job.create({ data: { workspaceId: workspace.id, userId: user.id, type: "book.analysis", status: "SUCCEEDED", payload: {} } }), chunk = await prisma.chunkSet.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "phase13", configuration: {}, configurationHash: key, status: "SUCCEEDED" } }), run = await prisma.bookAnalysisRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunk.id, jobId: analysisJob.id, pipelineVersion: "phase13", promptVersion: "phase13", provider: "fixture", model: "fixture", modelVersionKey: "fixture", idempotencyKey: key, analysisIdentityHash: key, status: "SUCCEEDED", analysisStage: "COMPLETED", completedAt: new Date() } }), artifact = await prisma.analysisArtifact.create({ data: { workspaceId: workspace.id, analysisRunId: run.id, chunkSetId: chunk.id, extractionId: extraction.id, scope: "BOOK", ordinal: 0, structuredOutput: {} } }), item = await prisma.bookMemoryItem.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id, analysisRunId: run.id, sourceArtifactId: artifact.id, type: "SUMMARY", ordinal: 0, content: `Phase 13 ${label}`, contentHash: key, memoryKey: `${run.id}:0`, createdAt } });
    await prisma.currentDocumentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id } });
    await prisma.currentBookIntelligence.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunk.id, analysisRunId: run.id } });
    return { document, run, item };
  }
  async function save(row: { item: { id: string } }) { await prisma.userCognitionState.create({ data: { workspaceId: workspace.id, userId: user.id, memoryItemId: row.item.id, state: "SAVED" } }); }
  return { identity, workspace, current, save };
}

describe("Phase 13 final repair: personal reviews", () => {
  it("keeps duplicate submissions idempotent and serializes ten distinct review events", async () => {
    const data = await makeFixture(), row = await data.current("concurrency"); await data.save(row);
    const duplicate = randomUUID();
    await Promise.all([recordManualCognitionReview(data.identity, { memoryItemId: row.item.id, eventId: duplicate }), recordManualCognitionReview(data.identity, { memoryItemId: row.item.id, eventId: duplicate })]);
    expect(await prisma.userCognitionReviewEvent.count({ where: { id: duplicate } })).toBe(1);
    await Promise.all(Array.from({ length: 10 }, () => recordManualCognitionReview(data.identity, { memoryItemId: row.item.id, eventId: randomUUID() })));
    expect(await prisma.userCognitionReviewEvent.count({ where: { workspaceId: data.identity.workspaceId, userId: data.identity.userId, memoryItemId: row.item.id } })).toBe(11);
    expect((await prisma.userCognitionReviewState.findUniqueOrThrow({ where: { workspaceId_userId_memoryItemId: { ...data.identity, memoryItemId: row.item.id } } })).reviewCount).toBe(11);
  });
});

describe("Phase 13 final repair: bounded personal corpus", () => {
  it("uses a stable 24-item cursor page, caps at 50, and excludes archive/history across pages", async () => {
    const data = await makeFixture(), active: Array<{ item: { id: string } }> = [];
    for (let index = 0; index < 27; index += 1) { const row = await data.current(`page-${index}`, new Date(Date.UTC(2026, 8, 1, 0, 0, index))); await data.save(row); active.push(row); }
    const archived = await data.current("archived", new Date("2026-09-02T00:00:00.000Z")); await data.save(archived); await prisma.userCognitionState.update({ where: { workspaceId_userId_memoryItemId: { ...data.identity, memoryItemId: archived.item.id } }, data: { state: "ARCHIVED" } });
    const historical = await data.current("historical", new Date("2026-09-03T00:00:00.000Z")); await data.save(historical); await prisma.currentBookIntelligence.delete({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: historical.document.id, workspaceId: data.identity.workspaceId } } });
    const first = await getPersonalCognitionCorpus(data.identity), repeated = await getPersonalCognitionCorpus(data.identity), second = await getPersonalCognitionCorpus(data.identity, { cursor: first.nextCursor, pageSize: 50 }), capped = await getPersonalCognitionCorpus(data.identity, { pageSize: 999 });
    expect(first.items).toHaveLength(24); expect(first.items.map(item => item.id)).toEqual(repeated.items.map(item => item.id)); expect(first.nextCursor).toBeTruthy(); expect(second.items).toHaveLength(3); expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(27); expect(capped.items).toHaveLength(27); expect([...first.items, ...second.items].map(item => item.id)).not.toContain(archived.item.id); expect([...first.items, ...second.items].map(item => item.id)).not.toContain(historical.item.id);
    const other = await prisma.user.create({ data: { email: `${randomUUID()}@phase13-isolation.test` } }); await prisma.workspaceMember.create({ data: { workspaceId: data.identity.workspaceId, userId: other.id, role: "VIEWER" } }); await prisma.userCognitionState.create({ data: { workspaceId: data.identity.workspaceId, userId: other.id, memoryItemId: active[0]!.item.id, state: "SAVED" } });
    expect((await getPersonalCognitionCorpus({ workspaceId: data.identity.workspaceId, userId: other.id })).items.map(item => item.id)).toEqual([active[0]!.item.id]);
  });
});

describe("Phase 13 final repair: stable cross-book bounds", () => {
  it("orders bounded candidates deterministically and rejects incompatible, malformed, zero, non-finite, historical, and cross-workspace rows", async () => {
    const data = await makeFixture(), source = await data.current("source"), compatibleA = await data.current("compatible-a"), compatibleB = await data.current("compatible-b"), provider = await data.current("provider"), model = await data.current("model"), version = await data.current("version"), embeddingVersion = await data.current("embedding-version"), dimensions = await data.current("dimensions"), malformed = await data.current("malformed"), zero = await data.current("zero"), nonFinite = await data.current("nonfinite"), below = await data.current("below"), historical = await data.current("historical");
    const add = async (row: typeof source, vector: unknown, extra: Record<string, unknown> = {}) => prisma.bookMemoryEmbedding.create({ data: { workspaceId: data.identity.workspaceId, memoryItemId: row.item.id, analysisRunId: row.run.id, extractionId: row.run.extractionId, provider: "fixture", model: "model", modelVersion: "v1", embeddingVersion: "v1", embeddingIdentityHash: `phase13-${row.item.id}`, dimensions: 3, vector, ...extra } as never });
    await add(source, [1, 0, 0]); await add(compatibleA, [1, 0, 0]); await add(compatibleB, [1, 0, 0]); await add(provider, [1, 0, 0], { provider: "other" }); await add(model, [1, 0, 0], { model: "other" }); await add(version, [1, 0, 0], { modelVersion: "v2" }); await add(embeddingVersion, [1, 0, 0], { embeddingVersion: "v2" }); await add(dimensions, [1, 0], { dimensions: 2 }); await add(malformed, { invalid: true }); await add(zero, [0, 0, 0]); await add(nonFinite, [1e308, 1e308, 1e308]); await add(below, [0, 1, 0]); await add(historical, [1, 0, 0]);
    await prisma.currentBookIntelligence.delete({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: historical.document.id, workspaceId: data.identity.workspaceId } } });
    const results = await findCrossBookCognitionConnections(data.identity, source.item.id);
    expect(results.map(item => item.id)).toEqual([compatibleA.item.id, compatibleB.item.id].sort()); expect(results.every(item => Number.isFinite(item.similarity) && item.semantics === "SEMANTICALLY_RELATED")).toBe(true);
  });

  it("does not let a valid candidate beyond the stable configured bound leak into results", async () => {
    const data = await makeFixture(), source = await data.current("bound-source");
    const add = async (row: typeof source, vector: unknown, hash: string) => prisma.bookMemoryEmbedding.create({ data: { workspaceId: data.identity.workspaceId, memoryItemId: row.item.id, analysisRunId: row.run.id, extractionId: row.run.extractionId, provider: "fixture", model: "model", modelVersion: "v1", embeddingVersion: "v1", embeddingIdentityHash: hash, dimensions: 3, vector: vector as never } });
    await add(source, [1, 0, 0], "source");
    for (let index = 0; index < MAX_CROSS_BOOK_CANDIDATES; index += 1) { const row = await data.current(`bound-${index}`); await add(row, [0, 1, 0], `a-${String(index).padStart(3, "0")}`); }
    const outside = await data.current("outside"); await add(outside, [1, 0, 0], "z-valid");
    await expect(findCrossBookCognitionConnections(data.identity, source.item.id)).resolves.toEqual([]);
  });
});

afterAll(() => prisma.$disconnect());
