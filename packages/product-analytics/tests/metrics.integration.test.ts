import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { clearSyntheticClosedBetaCohort, clientEventSchema, computeClosedBetaMetrics, feedbackSchema, HARDCODED_KPI_OUTPUT_COUNT, PHASE17_SYNTHETIC_AS_OF, seedSyntheticClosedBetaCohort } from "../src/index.js";

afterEach(async () => { await clearSyntheticClosedBetaCohort(); });

const hour = 3_600_000;
const at = (base: Date, hours: number) => new Date(base.getTime() + hours * hour);

/** Creates raw durable rows only; it deliberately does not use the 18-person fixture. */
async function boundaryParticipant(label: string, enrolledAt: Date) {
  const marker = `phase17-synthetic-cohort-boundary-${label}-${randomUUID()}`;
  const user = await prisma.user.create({ data: { email: `${marker}@test.invalid` } });
  const workspace = await prisma.workspace.create({ data: { name: marker } });
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const participant = await prisma.betaParticipant.create({ data: { userId: user.id, cohort: "boundary", consentVersion: "synthetic", consentedAt: enrolledAt, enrolledAt, status: "ACTIVE" } });
  const lineage = async (completedAt: Date) => {
    const key = `${marker}-${completedAt.getTime()}`;
    const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: key } });
    const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: key, sizeBytes: 1, mediaType: "text/plain", storageKey: key } });
    const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: key, sizeBytes: 1, mediaType: "text/plain", storageKey: key } });
    const ingestJob = await prisma.job.create({ data: { workspaceId: workspace.id, userId: user.id, type: "source.ingest", status: "SUCCEEDED", payload: {} } });
    const ingestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: ingestJob.id, parserVersion: "phase17", normalizationVersion: "phase17", status: "SUCCEEDED" } });
    const extraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "phase17", parserVersion: "phase17", normalizationVersion: "phase17" } });
    const job = await prisma.job.create({ data: { workspaceId: workspace.id, userId: user.id, type: "book.analysis", status: "SUCCEEDED", payload: {} } });
    const chunk = await prisma.chunkSet.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "phase17", configuration: {}, configurationHash: key, status: "SUCCEEDED" } });
    const run = await prisma.bookAnalysisRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunk.id, jobId: job.id, pipelineVersion: "phase17", promptVersion: "phase17", provider: "synthetic", model: "synthetic", modelVersionKey: "synthetic", idempotencyKey: key, analysisIdentityHash: key, status: "SUCCEEDED", analysisStage: "COMPLETED", completedAt } });
    const artifact = await prisma.analysisArtifact.create({ data: { workspaceId: workspace.id, analysisRunId: run.id, chunkSetId: chunk.id, extractionId: extraction.id, scope: "BOOK", ordinal: 0, structuredOutput: {} } });
    return { run, memory: await prisma.bookMemoryItem.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id, analysisRunId: run.id, sourceArtifactId: artifact.id, type: "SUMMARY", ordinal: 0, content: key, contentHash: key, memoryKey: key } }) };
  };
  const event = (eventName: string, occurredAt: Date) => prisma.productEvent.create({ data: { participantId: participant.id, userId: user.id, workspaceId: workspace.id, eventName, clientEventId: randomUUID(), route: "/studio", properties: {}, occurredAt } });
  return { participant, user, workspace, lineage, event };
}

describe("phase 17 metrics integrity synthetic cohort", () => {
  it("calculates twice from raw PostgreSQL rows with enrollment, maturity, meaningful-retention, withdrawal, and playback ordering guards", async () => {
    await seedSyntheticClosedBetaCohort();
    const first = await computeClosedBetaMetrics(PHASE17_SYNTHETIC_AS_OF);
    const second = await computeClosedBetaMetrics(PHASE17_SYNTHETIC_AS_OF);
    expect(second).toEqual(first);
    expect(HARDCODED_KPI_OUTPUT_COUNT).toBe(0);
    expect(first.enrolledParticipants).toBe(18);
    expect(first.activationWithin24hEligible).toBeLessThan(18);
    expect(first.activationWithin24hCount).toBeGreaterThan(0);
    expect(first.activationWithin24hCount).toBeLessThanOrEqual(first.activationWithin24hEligible);
    expect(first.timeToActivationMilliseconds.negativeCount).toBe(0);
    expect(first.meaningfulD1.rate).not.toBe(first.d1.rate);
    expect(first.podcast.completedPairs).toBe(2);
    expect(first.podcast.startedPairs).toBe(3);
    expect(first.podcast.naturalness.distribution[1]).toBe(0);
    expect(first.podcast.value.sampleCount).toBeGreaterThan(0);
    expect(first.thinking.startedUsers).toBeGreaterThan(0);
    expect(first.thinking.completedUsers).toBeGreaterThan(0);
    expect(first.teachBack.startedUsers).toBeGreaterThan(0);
    expect(first.teachBack.assessedUsers).toBeGreaterThan(0);
  });

  it("enforces the event and feedback entity semantics before durable writes", () => {
    const id = "1c4ccf99-2cfa-4c18-a5d1-c70a10559221";
    expect(() => clientEventSchema.parse({ eventName: "STUDIO_SESSION_STARTED", clientEventId: id, entityType: "PODCAST_AUDIO_REVISION", entityId: "cmphase17audio0000000000001" })).toThrow("EVENT_ENTITY_NOT_ALLOWED");
    expect(() => clientEventSchema.parse({ eventName: "PODCAST_PLAYBACK_STARTED", clientEventId: id })).toThrow("PLAYBACK_ENTITY_REQUIRED");
    expect(() => feedbackSchema.parse({ category: "QUALITY", dimension: "PODCAST_VALUE", rating: 5 })).toThrow("PODCAST_FEEDBACK_ENTITY_REQUIRED");
    expect(() => feedbackSchema.parse({ category: "OTHER", message: "general feedback" })).not.toThrow();
  });

  it("excludes a valid 23-hour activation until the exact 24-hour maturity boundary", async () => {
    const asOf = new Date("2026-03-01T12:00:00.000Z"), enrolledAt = at(asOf, -23);
    const fixture = await boundaryParticipant("maturity", enrolledAt);
    await fixture.lineage(at(enrolledAt, 1));
    const memory = await fixture.lineage(at(enrolledAt, 1.5));
    await prisma.userCognitionState.create({ data: { workspaceId: fixture.workspace.id, userId: fixture.user.id, memoryItemId: memory.memory.id, state: "SAVED", createdAt: at(enrolledAt, 2) } });
    const immature = await computeClosedBetaMetrics(asOf);
    expect(immature.activationWithin24hEligible).toBe(0);
    expect(immature.activationWithin24hCount).toBe(0);
    const mature = await computeClosedBetaMetrics(at(enrolledAt, 24));
    expect(mature.activationWithin24hEligible).toBe(1);
    expect(mature.activationWithin24hCount).toBe(1);
  });

  it("does not activate a Thinking session until it is completed", async () => {
    const enrolledAt = new Date("2026-03-01T12:00:00.000Z"), asOf = at(enrolledAt, 30);
    const thinking = await boundaryParticipant("thinking", enrolledAt);
    const thinkingLineage = await thinking.lineage(at(enrolledAt, 1));
    const started = await prisma.thinkingSession.create({ data: { workspaceId: thinking.workspace.id, userId: thinking.user.id, memoryItemId: thinkingLineage.memory.id, status: "ACTIVE", createdAt: at(enrolledAt, 2) } });
    expect((await computeClosedBetaMetrics(asOf)).activatedParticipants).toBe(0);
    await prisma.thinkingSession.update({ where: { id: started.id }, data: { status: "COMPLETED", completedAt: at(enrolledAt, 3) } });
    expect((await computeClosedBetaMetrics(asOf)).activatedParticipants).toBe(1);

  });

  it("does not activate a Teach Back attempt until it is assessed", async () => {
    const enrolledAt = new Date("2026-03-01T12:00:00.000Z"), asOf = at(enrolledAt, 30);
    const teachBack = await boundaryParticipant("teach-back", enrolledAt);
    const teachBackLineage = await teachBack.lineage(at(enrolledAt, 1));
    const attempt = await prisma.teachBackAttempt.create({ data: { id: randomUUID(), workspaceId: teachBack.workspace.id, userId: teachBack.user.id, memoryItemId: teachBackLineage.memory.id, content: "boundary", status: "PENDING_ASSESSMENT", createdAt: at(enrolledAt, 2) } });
    expect((await computeClosedBetaMetrics(asOf)).activatedParticipants).toBe(0);
    await prisma.teachBackAttempt.update({ where: { id: attempt.id }, data: { status: "ASSESSED", assessedAt: at(enrolledAt, 3) } });
    expect((await computeClosedBetaMetrics(asOf)).activatedParticipants).toBe(1);
  });

  it("does not count background BookAnalysis completion as meaningful D1 or D7 retention", async () => {
    const enrolledAt = new Date("2026-03-01T12:00:00.000Z"), activationAt = at(enrolledAt, 2);
    const fixture = await boundaryParticipant("background", enrolledAt);
    const activation = await fixture.lineage(at(enrolledAt, 1));
    await prisma.userCognitionState.create({ data: { workspaceId: fixture.workspace.id, userId: fixture.user.id, memoryItemId: activation.memory.id, state: "SAVED", createdAt: activationAt } });
    await fixture.lineage(at(activationAt, 26));
    await fixture.lineage(at(activationAt, 170));
    const metrics = await computeClosedBetaMetrics(at(activationAt, 193));
    expect(metrics.meaningfulD1.retained).toBe(0);
    expect(metrics.meaningfulD7.retained).toBe(0);
  });

  it("includes activation plus 24 hours and excludes activation plus 48 hours from D1", async () => {
    const enrolledAt = new Date("2026-03-01T12:00:00.000Z"), activationAt = at(enrolledAt, 2);
    const fixture = await boundaryParticipant("d1-boundary", enrolledAt);
    const activation = await fixture.lineage(at(enrolledAt, 1));
    await prisma.userCognitionState.create({ data: { workspaceId: fixture.workspace.id, userId: fixture.user.id, memoryItemId: activation.memory.id, state: "SAVED", createdAt: activationAt } });
    await fixture.event("STUDIO_SESSION_STARTED", at(activationAt, 24));
    await fixture.event("STUDIO_SESSION_STARTED", at(activationAt, 48));
    const metrics = await computeClosedBetaMetrics(at(activationAt, 49));
    expect(metrics.d1.eligible).toBe(1);
    expect(metrics.d1.retained).toBe(1);
  });

  it("includes activation plus 168 hours and excludes activation plus 192 hours from D7", async () => {
    const enrolledAt = new Date("2026-03-01T12:00:00.000Z"), activationAt = at(enrolledAt, 2);
    const fixture = await boundaryParticipant("d7-boundary", enrolledAt);
    const activation = await fixture.lineage(at(enrolledAt, 1));
    await prisma.userCognitionState.create({ data: { workspaceId: fixture.workspace.id, userId: fixture.user.id, memoryItemId: activation.memory.id, state: "SAVED", createdAt: activationAt } });
    await fixture.event("STUDIO_SESSION_STARTED", at(activationAt, 168));
    await fixture.event("STUDIO_SESSION_STARTED", at(activationAt, 192));
    const metrics = await computeClosedBetaMetrics(at(activationAt, 193));
    expect(metrics.d7.eligible).toBe(1);
    expect(metrics.d7.retained).toBe(1);
  });
});
