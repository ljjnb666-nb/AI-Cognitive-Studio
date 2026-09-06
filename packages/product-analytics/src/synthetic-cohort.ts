import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";

export const PHASE17_SYNTHETIC_AS_OF = new Date("2026-01-15T12:00:00.000Z");
export const PHASE17_SYNTHETIC_MARKER = "phase17-synthetic-cohort";
export const PHASE17_SYNTHETIC_PARTICIPANT_COUNT = 18;
export const HARDCODED_KPI_OUTPUT_COUNT = 0;

type Person = { id: string; userId: string; workspaceId: string; enrolledAt: Date; withdrawnAt?: Date | null };
const hours = (base: Date, value: number) => new Date(base.getTime() + value * 3_600_000);

async function createLineage(person: Person, completedAt: Date) {
  const key = `${PHASE17_SYNTHETIC_MARKER}-${person.userId}-${completedAt.getTime()}`;
  const source = await prisma.source.create({ data: { workspaceId: person.workspaceId, kind: "FILE", displayName: key } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: person.workspaceId, sha256: key, sizeBytes: 1, mediaType: "text/plain", storageKey: key } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId: person.workspaceId, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: key, sizeBytes: 1, mediaType: "text/plain", storageKey: key } });
  const ingest = await prisma.job.create({ data: { workspaceId: person.workspaceId, userId: person.userId, type: "source.ingest", status: "SUCCEEDED", payload: {} } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId: person.workspaceId, sourceDocumentId: document.id, jobId: ingest.id, parserVersion: "phase17", normalizationVersion: "phase17", status: "SUCCEEDED" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId: person.workspaceId, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "phase17", parserVersion: "phase17", normalizationVersion: "phase17" } });
  const job = await prisma.job.create({ data: { workspaceId: person.workspaceId, userId: person.userId, type: "book.analysis", status: "SUCCEEDED", payload: {} } });
  const chunk = await prisma.chunkSet.create({ data: { workspaceId: person.workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "phase17", configuration: {}, configurationHash: key, status: "SUCCEEDED" } });
  const run = await prisma.bookAnalysisRun.create({ data: { workspaceId: person.workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunk.id, jobId: job.id, pipelineVersion: "phase17", promptVersion: "phase17", provider: "synthetic", model: "synthetic", modelVersionKey: "synthetic", idempotencyKey: key, analysisIdentityHash: key, status: "SUCCEEDED", analysisStage: "COMPLETED", completedAt } });
  const artifact = await prisma.analysisArtifact.create({ data: { workspaceId: person.workspaceId, analysisRunId: run.id, chunkSetId: chunk.id, extractionId: extraction.id, scope: "BOOK", ordinal: 0, structuredOutput: {} } });
  return prisma.bookMemoryItem.create({ data: { workspaceId: person.workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, analysisRunId: run.id, sourceArtifactId: artifact.id, type: "SUMMARY", ordinal: 0, content: key, contentHash: key, memoryKey: key } });
}

export async function clearSyntheticClosedBetaCohort() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: `${PHASE17_SYNTHETIC_MARKER}-` } }, select: { id: true } });
  const workspaceIds = (await prisma.workspace.findMany({ where: { name: { startsWith: PHASE17_SYNTHETIC_MARKER } }, select: { id: true } })).map((row) => row.id);
  if (workspaceIds.length) {
    const scope = { workspaceId: { in: workspaceIds } };
    await prisma.teachBackAssessment.deleteMany({ where: scope });
    await prisma.teachBackAttempt.deleteMany({ where: scope });
    await prisma.thinkingSessionMessage.deleteMany({ where: scope });
    await prisma.thinkingSession.deleteMany({ where: scope });
    await prisma.userCognitionReviewEvent.deleteMany({ where: scope });
    await prisma.userCognitionReviewState.deleteMany({ where: scope });
    await prisma.userCognitionState.deleteMany({ where: scope });
    await prisma.currentBookIntelligence.deleteMany({ where: scope });
    await prisma.bookMemoryEvidence.deleteMany({ where: scope });
    await prisma.bookMemoryRelation.deleteMany({ where: scope });
    await prisma.bookMemoryItem.deleteMany({ where: scope });
    await prisma.analysisArtifact.deleteMany({ where: scope });
    await prisma.bookAnalysisRun.deleteMany({ where: scope });
    await prisma.chunkSet.deleteMany({ where: scope });
    await prisma.documentExtraction.deleteMany({ where: scope });
    await prisma.currentDocumentExtraction.deleteMany({ where: scope });
    await prisma.ingestionRun.deleteMany({ where: scope });
    await prisma.job.deleteMany({ where: scope });
    await prisma.sourceDocument.deleteMany({ where: scope });
    await prisma.source.deleteMany({ where: scope });
    await prisma.sourceBlob.deleteMany({ where: scope });
    await prisma.workspaceMember.deleteMany({ where: scope });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  }
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((row) => row.id) } } });
}

export async function seedSyntheticClosedBetaCohort(asOf = PHASE17_SYNTHETIC_AS_OF) {
  await clearSyntheticClosedBetaCohort();
  const people: Person[] = [];
  for (let index = 0; index < PHASE17_SYNTHETIC_PARTICIPANT_COUNT; index++) {
    const enrolledAt = hours(asOf, index === 3 ? -23 : -(10 * 24 + index));
    const user = await prisma.user.create({ data: { email: `${PHASE17_SYNTHETIC_MARKER}-${index}@test.invalid` } });
    const workspace = await prisma.workspace.create({ data: { name: `${PHASE17_SYNTHETIC_MARKER}-${index}` } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const withdrawnAt = index === 8 ? hours(enrolledAt, 12) : null;
    const participant = await prisma.betaParticipant.create({ data: { userId: user.id, cohort: index < 9 ? "early" : "late", consentVersion: "synthetic", consentedAt: enrolledAt, enrolledAt, status: index === 8 ? "WITHDRAWN" : "ACTIVE", withdrawnAt } });
    people.push({ id: participant.id, userId: user.id, workspaceId: workspace.id, enrolledAt, withdrawnAt });
  }
  const event = (person: Person, eventName: string, at: Date, entityId?: string) => prisma.productEvent.create({ data: { participantId: person.id, userId: person.userId, workspaceId: person.workspaceId, eventName, clientEventId: randomUUID(), route: "/studio", properties: {}, occurredAt: at, ...(entityId ? { entityType: "PODCAST_AUDIO_REVISION", entityId } : {}) } });
  const cognition = async (person: Person, at: Date, kind: "SAVE" | "REVIEW" = "SAVE") => { const memory = await createLineage(person, hours(at, -1)); if (kind === "SAVE") return prisma.userCognitionState.create({ data: { workspaceId: person.workspaceId, userId: person.userId, memoryItemId: memory.id, state: "SAVED", createdAt: at } }); return prisma.userCognitionReviewEvent.create({ data: { id: randomUUID(), workspaceId: person.workspaceId, userId: person.userId, memoryItemId: memory.id, kind: "MANUAL_REVIEW", createdAt: at } }); };
  // The fixture records raw activities only. It intentionally contains no KPI outputs.
  await cognition(people[0]!, hours(people[0]!.enrolledAt, 2)); await event(people[0]!, "STUDIO_SESSION_STARTED", hours(people[0]!.enrolledAt, 26)); await event(people[0]!, "STUDIO_SESSION_STARTED", hours(people[0]!.enrolledAt, 28)); await event(people[0]!, "PODCAST_PLAYBACK_STARTED", hours(people[0]!.enrolledAt, 30), "cmphase17audio0000000000001"); await event(people[0]!, "PODCAST_PLAYBACK_90", hours(people[0]!.enrolledAt, 31), "cmphase17audio0000000000001");
  await cognition(people[1]!, hours(people[1]!.enrolledAt, 30)); await event(people[1]!, "STUDIO_SESSION_STARTED", hours(people[1]!.enrolledAt, 25)); await event(people[1]!, "STUDIO_SESSION_STARTED", hours(people[1]!.enrolledAt, 60)); await cognition(people[1]!, hours(people[1]!.enrolledAt, 8 * 24), "REVIEW");
  await cognition(people[2]!, hours(people[2]!.enrolledAt, 24));
  await event(people[3]!, "STUDIO_SESSION_STARTED", hours(people[3]!.enrolledAt, 1));
  await event(people[4]!, "STUDIO_SESSION_STARTED", hours(people[4]!.enrolledAt, 1)); await event(people[4]!, "STUDIO_SESSION_STARTED", hours(people[4]!.enrolledAt, 26));
  await cognition(people[5]!, hours(people[5]!.enrolledAt, 2)); await cognition(people[5]!, hours(people[5]!.enrolledAt, 26), "REVIEW");
  await cognition(people[6]!, hours(people[6]!.enrolledAt, -2)); await cognition(people[6]!, hours(people[6]!.enrolledAt, 2));
  await cognition(people[7]!, hours(people[7]!.enrolledAt, -2)); await event(people[7]!, "STUDIO_SESSION_STARTED", hours(people[7]!.enrolledAt, 3));
  await cognition(people[8]!, hours(people[8]!.enrolledAt, 13));
  await event(people[9]!, "PODCAST_PLAYBACK_90", hours(people[9]!.enrolledAt, 2), "cmphase17audio0000000000002"); await event(people[9]!, "PODCAST_PLAYBACK_STARTED", hours(people[9]!.enrolledAt, 3), "cmphase17audio0000000000002");
  await event(people[10]!, "PODCAST_PLAYBACK_STARTED", hours(people[10]!.enrolledAt, 2), "cmphase17audio0000000000003"); await event(people[10]!, "PODCAST_PLAYBACK_ENDED", hours(people[10]!.enrolledAt, 4), "cmphase17audio0000000000003");
  const thinkingMemory = await createLineage(people[11]!, hours(people[11]!.enrolledAt, 1));
  await prisma.thinkingSession.create({ data: { workspaceId: people[11]!.workspaceId, userId: people[11]!.userId, memoryItemId: thinkingMemory.id, status: "ACTIVE", createdAt: hours(people[11]!.enrolledAt, 2) } });
  const completedThinkingMemory = await createLineage(people[12]!, hours(people[12]!.enrolledAt, 1));
  await prisma.thinkingSession.create({ data: { workspaceId: people[12]!.workspaceId, userId: people[12]!.userId, memoryItemId: completedThinkingMemory.id, status: "COMPLETED", createdAt: hours(people[12]!.enrolledAt, 2), completedAt: hours(people[12]!.enrolledAt, 3) } });
  const teachBackMemory = await createLineage(people[13]!, hours(people[13]!.enrolledAt, 1));
  await prisma.teachBackAttempt.create({ data: { id: randomUUID(), workspaceId: people[13]!.workspaceId, userId: people[13]!.userId, memoryItemId: teachBackMemory.id, content: "synthetic", status: "PENDING_ASSESSMENT", createdAt: hours(people[13]!.enrolledAt, 2) } });
  const assessedTeachBackMemory = await createLineage(people[14]!, hours(people[14]!.enrolledAt, 1));
  await prisma.teachBackAttempt.create({ data: { id: randomUUID(), workspaceId: people[14]!.workspaceId, userId: people[14]!.userId, memoryItemId: assessedTeachBackMemory.id, content: "synthetic", status: "ASSESSED", createdAt: hours(people[14]!.enrolledAt, 2), assessedAt: hours(people[14]!.enrolledAt, 3) } });
  await prisma.betaFeedback.create({ data: { participantId: people[0]!.id, workspaceId: people[0]!.workspaceId, category: "QUALITY", dimension: "PODCAST_NATURALNESS", rating: 4, entityType: "PODCAST_AUDIO_REVISION", entityId: "cmphase17audio0000000000001", createdAt: hours(people[0]!.enrolledAt, 32) } });
  await prisma.betaFeedback.create({ data: { participantId: people[0]!.id, workspaceId: people[0]!.workspaceId, category: "QUALITY", dimension: "PODCAST_VALUE", rating: 5, entityType: "PODCAST_AUDIO_REVISION", entityId: "cmphase17audio0000000000001", createdAt: hours(people[0]!.enrolledAt, 32) } });
  await prisma.betaFeedback.create({ data: { participantId: people[8]!.id, workspaceId: people[8]!.workspaceId, category: "QUALITY", dimension: "PODCAST_VALUE", rating: 1, entityType: "PODCAST_AUDIO_REVISION", entityId: "cmphase17audio0000000000004", createdAt: hours(people[8]!.enrolledAt, 13) } });
  return { asOf, participantCount: people.length, people };
}
