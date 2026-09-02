import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { parseProviderModelManifest, ProviderGatewayRepository, testCipher, validateRouteManifestSelection } from "@ai-cognitive/provider-gateway";
import { assessmentSchema, createOrAssessTeachBackAttempt, deriveMasteryState, listMasteryCognitions, recoverPendingTeachBackAttempt, rubricForCognitionType, setTeachBackGatewayRuntimeForTests, teachBackAttemptDetail, validateTeachBackAssessment, type Criterion } from "../lib/teach-back";
import { getPersonalCognitionCorpus, getPersonalCognitionOverview, getPersonalWeakPoints, getRecommendedReviews, reconcilePersonalCognitionReviewState, recordManualCognitionReview } from "../lib/personalized-cognition";
import { findCrossBookCognitionConnections } from "../lib/cognition-associations";

process.env.PROVIDER_GATEWAY_MODEL_MANIFEST = JSON.stringify({ providers: [{ providerKey: "phase12-fixture", displayName: "Phase 12 Fixture", protocol: "TEST", adapterVersion: "phase12", models: [{ modelId: "phase12-assessment", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }] }] });

const rubric = rubricForCognitionType("SUMMARY");
const valid: { criteria: Criterion[]; feedback: string; nextPrompt: string } = { criteria: rubric.map((key) => ({ key, status: "MET", rationale: "简洁理由", evidenceRefs: [] })), feedback: "反馈", nextPrompt: "再说明其中的关系。" };
describe("Phase 12 Teach Back deterministic assessment", () => {
  it("derives mastery without a provider score", () => { expect(deriveMasteryState(rubric, valid.criteria)).toBe("DEMONSTRATED"); expect(deriveMasteryState(rubric, [{ ...valid.criteria[0], status: "NOT_MET" }, ...valid.criteria.slice(1)])).toBe("NEEDS_REVIEW"); expect(deriveMasteryState(rubric, [{ ...valid.criteria[0], status: "PARTIAL" }, ...valid.criteria.slice(1)])).toBe("DEVELOPING"); });
  it("rejects missing, duplicate, unknown, invalid, empty, oversized, score, and invented-evidence fields", () => { for (const value of [{ ...valid, criteria: valid.criteria.slice(1) }, { ...valid, criteria: [valid.criteria[0], valid.criteria[0], valid.criteria[2]] }, { ...valid, criteria: [{ ...valid.criteria[0], key: "UNKNOWN" }, ...valid.criteria.slice(1)] }, { ...valid, criteria: [{ ...valid.criteria[0], status: "INVALID" }, ...valid.criteria.slice(1)] }, { ...valid, criteria: [{ ...valid.criteria[0], rationale: "" }, ...valid.criteria.slice(1)] }, { ...valid, feedback: "" }, { ...valid, score: 92 }, { ...valid, feedback: "x".repeat(2001) }, { ...valid, nextPrompt: "x".repeat(601) }, { ...valid, criteria: [{ ...valid.criteria[0], evidenceRefs: ["E9"] }, ...valid.criteria.slice(1)] }]) expect(() => validateTeachBackAssessment(value, rubric, ["E1"])).toThrow("TEACH_BACK_ASSESSMENT_INVALID"); });
  it("uses a valid zero-evidence schema without an empty enum", () => { const schema = assessmentSchema(rubric, []); const refs = (schema.properties.criteria.items.properties.evidenceRefs as { items: Record<string, unknown>; maxItems: number }); expect(refs.maxItems).toBe(0); expect(refs.items).toEqual({ type: "string" }); expect(refs.items).not.toHaveProperty("enum"); });
  it("requires strict JSON schema for the real Teach Back route selection", () => { for (const structuredOutput of [undefined, "UNSUPPORTED", "PROMPT_ONLY", "JSON_MODE"] as const) { const manifest = parseProviderModelManifest(JSON.stringify({ providers: [{ providerKey: "fixture", displayName: "Fixture", protocol: "TEST", adapterVersion: "test", models: [{ modelId: "assessment", families: ["TEXT_GENERATION"], confidence: "VERIFIED", ...(structuredOutput ? { structuredOutput } : {}) }] }] })); expect(() => validateRouteManifestSelection(manifest, { routeSlot: "TEACH_BACK_ASSESSMENT", providerKey: "fixture", protocol: "TEST", modelId: "assessment" })).toThrow("strict JSON schema"); } const strict = parseProviderModelManifest(JSON.stringify({ providers: [{ providerKey: "fixture", displayName: "Fixture", protocol: "TEST", adapterVersion: "test", models: [{ modelId: "assessment", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }] }] })); expect(validateRouteManifestSelection(strict, { routeSlot: "TEACH_BACK_ASSESSMENT", providerKey: "fixture", protocol: "TEST", modelId: "assessment" }).structuredOutput).toBe("STRICT_JSON_SCHEMA"); });
});

describe("Better Auth production-build contract", () => {
  it("creates a password account with the release environment", async () => {
    const { auth } = await import("../lib/auth");
    const response = await auth.handler(new Request("http://localhost:3001/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3001" }, body: JSON.stringify({ name: "Phase Twelve Auth", email: `phase12-auth-${Date.now()}@ai-cognitive-studio.test`, password: "Phase12Password!" }) }));
    expect(response.status, await response.text()).toBe(200);
  });
});

async function fixture() {
  const suffix = randomUUID();
  const userA = await prisma.user.create({ data: { email: `${suffix}-a@phase12.test` } });
  const userB = await prisma.user.create({ data: { email: `${suffix}-b@phase12.test` } });
  const workspace = await prisma.workspace.create({ data: { name: `phase12-${suffix}` } });
  const userC = await prisma.user.create({ data: { email: `${suffix}-c@phase12.test` } });
  const workspaceC = await prisma.workspace.create({ data: { name: `phase12-c-${suffix}` } });
  await prisma.workspaceMember.createMany({ data: [{ workspaceId: workspace.id, userId: userA.id, role: "OWNER" }, { workspaceId: workspace.id, userId: userB.id, role: "VIEWER" }] });
  await prisma.workspaceMember.create({ data: { workspaceId: workspaceC.id, userId: userC.id, role: "OWNER" } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "Phase 12 evidence" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: suffix, sizeBytes: 1, mediaType: "text/plain", storageKey: suffix } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/plain", storageKey: suffix } });
  const ingestJob = await prisma.job.create({ data: { workspaceId: workspace.id, type: "source.ingest", payload: {} } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: ingestJob.id, parserVersion: "test", normalizationVersion: "test", status: "SUCCEEDED" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } });
  await prisma.currentDocumentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id } });
  const block = await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal: 0, kind: "PARAGRAPH", text: "Verifiable evidence anchors a claim.", contentHash: suffix } });
  async function cognition(label: string, evidence = true, separateDocument = false) {
    let targetDocument = document, targetExtraction = extraction, targetBlock = block;
    if (separateDocument) {
      const nextSource = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: `Phase 12 ${label}` } });
      const nextBlob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: `${suffix}-${label}`, sizeBytes: 1, mediaType: "text/plain", storageKey: `${suffix}-${label}` } });
      targetDocument = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: nextSource.id, sourceBlobId: nextBlob.id, version: 1, sha256: `${suffix}-${label}`, sizeBytes: 1, mediaType: "text/plain", storageKey: nextBlob.storageKey } });
      const nextJob = await prisma.job.create({ data: { workspaceId: workspace.id, type: "source.ingest", payload: {} } });
      const nextIngestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: targetDocument.id, jobId: nextJob.id, parserVersion: "test", normalizationVersion: "test", status: "SUCCEEDED" } });
      targetExtraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: targetDocument.id, ingestionRunId: nextIngestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } });
      targetBlock = await prisma.sourceBlock.create({ data: { extractionId: targetExtraction.id, ordinal: 0, kind: "PARAGRAPH", text: `Evidence ${label}`, contentHash: `${suffix}-${label}` } });
      await prisma.currentDocumentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: targetDocument.id, extractionId: targetExtraction.id } });
    }
    const job = await prisma.job.create({ data: { workspaceId: workspace.id, type: "book.analysis", payload: {} } });
    const chunk = await prisma.chunkSet.create({ data: { workspaceId: workspace.id, sourceDocumentId: targetDocument.id, extractionId: targetExtraction.id, chunkingVersion: label, configuration: {}, configurationHash: `${suffix}-${label}`, status: "SUCCEEDED" } });
    const run = await prisma.bookAnalysisRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: targetDocument.id, extractionId: targetExtraction.id, chunkSetId: chunk.id, jobId: job.id, pipelineVersion: "test", promptVersion: label, provider: "fixture", model: "fixture", modelVersionKey: "fixture", idempotencyKey: `${suffix}-${label}`, analysisIdentityHash: `${suffix}-${label}`, status: "SUCCEEDED", analysisStage: "COMPLETED", completedAt: new Date() } });
    const artifact = await prisma.analysisArtifact.create({ data: { workspaceId: workspace.id, analysisRunId: run.id, chunkSetId: chunk.id, extractionId: targetExtraction.id, scope: "BOOK", ordinal: 0, structuredOutput: {} } });
    const item = await prisma.bookMemoryItem.create({ data: { workspaceId: workspace.id, sourceDocumentId: targetDocument.id, extractionId: targetExtraction.id, analysisRunId: run.id, sourceArtifactId: artifact.id, type: "SUMMARY", ordinal: 0, content: `Cognition ${label}`, contentHash: `${suffix}-${label}`, memoryKey: `${run.id}:0` } });
    if (evidence) await prisma.bookMemoryEvidence.create({ data: { workspaceId: workspace.id, analysisRunId: run.id, extractionId: targetExtraction.id, memoryItemId: item.id, sourceBlockId: targetBlock.id, startOffset: 0, endOffset: targetBlock.text.length } });
    await prisma.currentBookIntelligence.upsert({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: targetDocument.id, workspaceId: workspace.id } }, create: { workspaceId: workspace.id, sourceDocumentId: targetDocument.id, extractionId: targetExtraction.id, chunkSetId: chunk.id, analysisRunId: run.id }, update: { extractionId: targetExtraction.id, chunkSetId: chunk.id, analysisRunId: run.id } });
    return { item, chunk, run, document: targetDocument };
  }
  const first = await cognition("first", false);
  const providerStore = new ProviderGatewayRepository(prisma, testCipher());
  const connection = await providerStore.createConnection({ workspaceId: workspace.id, userId: userA.id }, { providerKey: "phase12-fixture", protocol: "TEST", displayName: "Phase 12 fixture", endpoint: "https://example.com" });
  await providerStore.rotateCredential({ workspaceId: workspace.id, userId: userA.id }, connection.id, "fixture-secret");
  await providerStore.setRoute({ workspaceId: workspace.id, userId: userA.id }, { routeSlot: "TEACH_BACK_ASSESSMENT", connectionId: connection.id, modelId: "phase12-assessment" });
  return { workspace, userA, userB, workspaceC, userC, providerStore, document, first, cognition };
}

function validStructured() { return { criteria: rubric.map((key) => ({ key, status: "MET", rationale: "Grounded assessment", evidenceRefs: [] })), feedback: "Clear explanation", nextPrompt: null }; }
function installGateway(options: { fail?: boolean; inProgress?: boolean } = {}) {
  const prompts: string[] = []; let failures = options.fail ? 1 : 0;
  setTeachBackGatewayRuntimeForTests(() => ({
    gateway: { execute: async (request: { text: { messages: Array<{ content: string }> } }) => { prompts.push(request.text.messages[0]!.content); if (failures-- > 0) throw new Error("fixture failure"); if (options.inProgress) return { status: "IN_PROGRESS", invocationId: randomUUID() }; return { status: "SUCCEEDED", invocationId: randomUUID(), snapshot: { id: randomUUID() }, response: { type: "STRUCTURED", structured: validStructured() } }; } } as never,
    repository: { consumeTextResult: async (_input: unknown, callback: (context: { tx: typeof prisma }) => Promise<void>) => callback({ tx: prisma }) } as never,
  }));
  return prompts;
}
afterEach(() => setTeachBackGatewayRuntimeForTests(undefined));
afterAll(() => prisma.$disconnect());

describe("Phase 12 real database service gates", () => {
  it("keeps Phase 13 personal review state user-scoped, idempotent, and mastery-authoritative", async () => {
    const data = await fixture(), identity = { workspaceId: data.workspace.id, userId: data.userA.id }, memoryItemId = data.first.item.id;
    await prisma.userCognitionState.create({ data: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId, state: "SAVED" } });
    const assessedAt = new Date("2026-09-01T00:00:00.000Z"), attemptId = randomUUID();
    await prisma.teachBackAttempt.create({ data: { id: attemptId, workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId, content: "Persisted assessed explanation", status: "ASSESSED", assessedAt } });
    await prisma.teachBackAssessment.create({ data: { workspaceId: identity.workspaceId, attemptId, masteryState: "NEEDS_REVIEW", rubric: [{ key: "COVERAGE", status: "NOT_MET", rationale: "Missing context", evidenceRefs: [] }], feedback: "Review", nextPrompt: null } });
    const eventId = randomUUID();
    await expect(recordManualCognitionReview(identity, { memoryItemId, eventId })).resolves.toEqual({ idempotent: false, eventId });
    await expect(recordManualCognitionReview(identity, { memoryItemId, eventId })).resolves.toEqual({ idempotent: true, eventId });
    expect(await prisma.userCognitionReviewEvent.count({ where: { id: eventId } })).toBe(1);
    const concurrentEventId = randomUUID();
    await Promise.all([recordManualCognitionReview(identity, { memoryItemId, eventId: concurrentEventId }), recordManualCognitionReview(identity, { memoryItemId, eventId: concurrentEventId })]);
    expect(await prisma.userCognitionReviewEvent.count({ where: { id: concurrentEventId } })).toBe(1);
    expect(await prisma.userCognitionReviewState.findUniqueOrThrow({ where: { workspaceId_userId_memoryItemId: { ...identity, memoryItemId } } })).toMatchObject({ reviewCount: 2, lastMasteryState: "NEEDS_REVIEW", scheduleVersion: "phase13-v1" });
    await prisma.userCognitionReviewState.update({ where: { workspaceId_userId_memoryItemId: { ...identity, memoryItemId } }, data: { lastMasteryState: "DEMONSTRATED" } });
    await reconcilePersonalCognitionReviewState(identity, memoryItemId);
    expect(await prisma.userCognitionReviewState.findUniqueOrThrow({ where: { workspaceId_userId_memoryItemId: { ...identity, memoryItemId } } })).toMatchObject({ lastMasteryState: "NEEDS_REVIEW", lastMasteryAssessedAt: assessedAt });
    await expect(getPersonalCognitionOverview(identity)).resolves.toMatchObject({ total: 1, needsReview: 1 });
    await expect(getPersonalWeakPoints(identity)).resolves.toMatchObject({ criteria: [{ criterionKey: "COVERAGE", notMetCount: 1, partialCount: 0, affectedCognitionCount: 1 }] });
    await expect(recordManualCognitionReview({ workspaceId: data.workspace.id, userId: data.userB.id }, { memoryItemId, eventId: randomUUID() })).rejects.toThrow("COGNITION_NOT_FOUND");
    await prisma.userCognitionState.update({ where: { workspaceId_userId_memoryItemId: { ...identity, memoryItemId } }, data: { state: "ARCHIVED" } });
    await expect(recordManualCognitionReview(identity, { memoryItemId, eventId: randomUUID() })).rejects.toThrow("COGNITION_NOT_FOUND");
  });
  it("builds the active personal corpus from saved, thinking-only, and Teach Back-only interactions", async () => {
    const data = await fixture(), identity = { workspaceId: data.workspace.id, userId: data.userA.id };
    const thinkingOnly = await data.cognition("thinking-only", false, true), teachBackOnly = await data.cognition("teachback-only", false, true), untouched = await data.cognition("untouched", false, true);
    await prisma.userCognitionState.create({ data: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: data.first.item.id, state: "SAVED" } });
    await prisma.thinkingSession.create({ data: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: thinkingOnly.item.id } });
    await prisma.teachBackAttempt.create({ data: { id: randomUUID(), workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: teachBackOnly.item.id, content: "Pending attempts are still a meaningful interaction." } });
    expect((await getPersonalCognitionCorpus(identity)).items.map(item => item.id).sort()).toEqual([data.first.item.id, thinkingOnly.item.id, teachBackOnly.item.id].sort());
    expect((await getPersonalCognitionCorpus({ workspaceId: identity.workspaceId, userId: data.userB.id })).items.map(item => item.id)).toEqual([]);
    await prisma.userCognitionState.update({ where: { workspaceId_userId_memoryItemId: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: data.first.item.id } }, data: { state: "ARCHIVED" } });
    expect((await getPersonalCognitionCorpus(identity)).items.map(item => item.id).sort()).toEqual([thinkingOnly.item.id, teachBackOnly.item.id].sort());
    expect((await getPersonalCognitionCorpus(identity)).items.map(item => item.id)).not.toContain(untouched.item.id);
  });
  it("orders due recommendations by mastery and uses deterministic reason codes", async () => {
    const data = await fixture(), identity = { workspaceId: data.workspace.id, userId: data.userA.id }, past = new Date("2020-01-01T00:00:00.000Z");
    const developing = await data.cognition("developing", false, true), unassessed = await data.cognition("unassessed", false, true), demonstrated = await data.cognition("demonstrated", false, true);
    const rows: Array<[typeof data.first, "NEEDS_REVIEW" | "DEVELOPING" | "DEMONSTRATED"]> = [[data.first, "NEEDS_REVIEW"], [developing, "DEVELOPING"], [demonstrated, "DEMONSTRATED"]];
    for (const [item, masteryState] of rows) { const attemptId = randomUUID(); await prisma.userCognitionState.create({ data: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: item.item.id, state: "SAVED" } }); await prisma.teachBackAttempt.create({ data: { id: attemptId, workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: item.item.id, content: masteryState, status: "ASSESSED", assessedAt: past } }); await prisma.teachBackAssessment.create({ data: { workspaceId: identity.workspaceId, attemptId, masteryState, rubric: [], feedback: "fixture", nextPrompt: null } }); await prisma.userCognitionReviewState.create({ data: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: item.item.id, lastMasteryState: masteryState, lastMasteryAssessedAt: past, lastReviewedAt: past, nextReviewAt: past } }); }
    await prisma.userCognitionState.create({ data: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: unassessed.item.id, state: "SAVED" } });
    await prisma.userCognitionReviewState.create({ data: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: unassessed.item.id, lastReviewedAt: past, nextReviewAt: past } });
    const recommendations = await getRecommendedReviews(identity, 4);
    expect(recommendations.map(item => item.id)).toEqual([data.first.item.id, developing.item.id, unassessed.item.id, demonstrated.item.id]);
    expect(recommendations.map(item => item.reason)).toEqual(["WEAK_MASTERY", "DEVELOPING_MASTERY", "UNASSESSED", "MAINTAIN_MASTERY"]);
  });
  it("diversifies the default recommendation queue across source documents", async () => {
    const data = await fixture(), identity = { workspaceId: data.workspace.id, userId: data.userA.id }, past = new Date("2020-01-01T00:00:00.000Z");
    const sameBook = await Promise.all([1, 2, 3].map(ordinal => prisma.bookMemoryItem.create({ data: { workspaceId: identity.workspaceId, sourceDocumentId: data.first.document.id, extractionId: data.first.run.extractionId, analysisRunId: data.first.run.id, sourceArtifactId: data.first.item.sourceArtifactId, type: "SUMMARY", ordinal, content: `Same book ${ordinal}`, contentHash: `${randomUUID()}-${ordinal}`, memoryKey: `${data.first.run.id}:phase13:${ordinal}` } })));
    const otherBooks = await Promise.all(["diverse-a", "diverse-b", "diverse-c"].map(label => data.cognition(label, false, true)));
    const items = [data.first.item, ...sameBook, ...otherBooks.map(value => value.item)];
    for (const item of items) { await prisma.userCognitionState.create({ data: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: item.id, state: "SAVED" } }); await prisma.userCognitionReviewState.create({ data: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: item.id, lastReviewedAt: past, nextReviewAt: past } }); }
    const queue = await getRecommendedReviews(identity, 5), perSource = new Map<string, number>();
    for (const item of queue) perSource.set(item.sourceDocumentId, (perSource.get(item.sourceDocumentId) ?? 0) + 1);
    expect(queue).toHaveLength(5); expect(Math.max(...perSource.values())).toBeLessThanOrEqual(2);
  });
  it("tolerates malformed legacy rubrics without losing the personal weak-point read", async () => {
    const data = await fixture(), identity = { workspaceId: data.workspace.id, userId: data.userA.id }, attemptId = randomUUID();
    await prisma.userCognitionState.create({ data: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: data.first.item.id, state: "SAVED" } });
    await prisma.teachBackAttempt.create({ data: { id: attemptId, workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: data.first.item.id, content: "Legacy rubric fixture", status: "ASSESSED", assessedAt: new Date() } });
    await prisma.teachBackAssessment.create({ data: { workspaceId: identity.workspaceId, attemptId, masteryState: "DEVELOPING", rubric: { legacy: true }, feedback: "fixture", nextPrompt: null } });
    await expect(getPersonalWeakPoints(identity)).resolves.toMatchObject({ weak: [expect.objectContaining({ id: data.first.item.id, masteryState: "DEVELOPING" })], criteria: [] });
  });
  it("keeps personalization reads available with no Provider route configured", async () => {
    const data = await fixture(), identity = { workspaceId: data.workspace.id, userId: data.userA.id };
    await prisma.providerRouteBinding.deleteMany({ where: { workspaceId: identity.workspaceId } });
    await prisma.userCognitionState.create({ data: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: data.first.item.id, state: "SAVED" } });
    await expect(getPersonalCognitionOverview(identity)).resolves.toMatchObject({ total: 1, unassessed: 1 });
    await expect(getPersonalWeakPoints(identity)).resolves.toMatchObject({ unassessed: [expect.objectContaining({ id: data.first.item.id })] });
    await expect(getRecommendedReviews(identity)).resolves.toEqual([expect.objectContaining({ id: data.first.item.id })]);
    await expect(findCrossBookCognitionConnections(identity, data.first.item.id)).resolves.toEqual([]);
  });
  it("keeps cross-book associations current-lineage gated and rejects incompatible embeddings", async () => {
    const data = await fixture(), identity = { workspaceId: data.workspace.id, userId: data.userA.id };
    const other = await data.cognition("cross-book", false, true), rejected = await data.cognition("rejected", false, true);
    await prisma.bookMemoryEmbedding.createMany({ data: [
      { workspaceId: identity.workspaceId, memoryItemId: data.first.item.id, analysisRunId: data.first.run.id, extractionId: data.first.run.extractionId, provider: "fixture", model: "embedding", modelVersion: "v1", embeddingVersion: "v1", embeddingIdentityHash: `phase13-source-${randomUUID()}`, dimensions: 3, vector: [1, 0, 0] },
      { workspaceId: identity.workspaceId, memoryItemId: other.item.id, analysisRunId: other.run.id, extractionId: other.run.extractionId, provider: "fixture", model: "embedding", modelVersion: "v1", embeddingVersion: "v1", embeddingIdentityHash: `phase13-other-${randomUUID()}`, dimensions: 3, vector: [0.9, 0.1, 0] },
      { workspaceId: identity.workspaceId, memoryItemId: other.item.id, analysisRunId: other.run.id, extractionId: other.run.extractionId, provider: "fixture", model: "different", modelVersion: "v1", embeddingVersion: "v1", embeddingIdentityHash: `phase13-incompatible-${randomUUID()}`, dimensions: 3, vector: [1, 0, 0] },
      { workspaceId: identity.workspaceId, memoryItemId: rejected.item.id, analysisRunId: rejected.run.id, extractionId: rejected.run.extractionId, provider: "fixture", model: "embedding", modelVersion: "v1", embeddingVersion: "v1", embeddingIdentityHash: `phase13-low-${randomUUID()}`, dimensions: 3, vector: [0, 1, 0] },
      { workspaceId: identity.workspaceId, memoryItemId: rejected.item.id, analysisRunId: rejected.run.id, extractionId: rejected.run.extractionId, provider: "fixture", model: "embedding", modelVersion: "v1", embeddingVersion: "v1", embeddingIdentityHash: `phase13-zero-${randomUUID()}`, dimensions: 3, vector: [0, 0, 0] },
      { workspaceId: identity.workspaceId, memoryItemId: rejected.item.id, analysisRunId: rejected.run.id, extractionId: rejected.run.extractionId, provider: "fixture", model: "embedding", modelVersion: "v1", embeddingVersion: "v1", embeddingIdentityHash: `phase13-malformed-${randomUUID()}`, dimensions: 3, vector: { invalid: true } },
    ] });
    await expect(findCrossBookCognitionConnections(identity, data.first.item.id)).resolves.toEqual([expect.objectContaining({ id: other.item.id, semantics: "SEMANTICALLY_RELATED" })]);
    await prisma.currentBookIntelligence.delete({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: other.document.id, workspaceId: identity.workspaceId } } });
    await expect(findCrossBookCognitionConnections(identity, data.first.item.id)).resolves.toEqual([]);
  });
  it("uses the zero-evidence prompt/schema path, persists source grounding, and recovers concurrent retries", async () => {
    const data = await fixture(); const identity = { workspaceId: data.workspace.id, userId: data.userA.id }; const prompts = installGateway({ fail: true }); const attemptId = randomUUID();
    await expect(createOrAssessTeachBackAttempt(identity, { memoryItemId: data.first.item.id, attemptId, content: "I can explain the cognition without inventing a source." })).rejects.toThrow("TEACH_BACK_PROVIDER_FAILED");
    await Promise.all([createOrAssessTeachBackAttempt(identity, { memoryItemId: data.first.item.id, attemptId, content: "I can explain the cognition without inventing a source." }), createOrAssessTeachBackAttempt(identity, { memoryItemId: data.first.item.id, attemptId, content: "I can explain the cognition without inventing a source." })]);
    expect(prompts.at(-1)).toContain("暂无可验证来源证据");
    const detail = await teachBackAttemptDetail(identity, attemptId); expect(detail?.sourceGrounding).toBe("NO_VERIFIABLE_EVIDENCE"); expect(await prisma.teachBackAssessment.count({ where: { attemptId } })).toBe(1);
    expect(await prisma.userCognitionReviewState.findUniqueOrThrow({ where: { workspaceId_userId_memoryItemId: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: data.first.item.id } } })).toMatchObject({ reviewCount: 0, lastMasteryState: "DEMONSTRATED", scheduleVersion: "phase13-v1" });
    await expect(teachBackAttemptDetail({ workspaceId: data.workspace.id, userId: data.userB.id }, attemptId)).resolves.toBeNull();
    const crossWorkspace = { workspaceId: data.workspaceC.id, userId: data.userC.id }, replay = { memoryItemId: data.first.item.id, attemptId, content: "I can explain the cognition without inventing a source." };
    await expect(createOrAssessTeachBackAttempt(crossWorkspace, replay)).rejects.toThrow("COGNITION_NOT_CURRENT");
    await expect(createOrAssessTeachBackAttempt({ workspaceId: data.workspace.id, userId: data.userB.id }, replay)).rejects.toThrow("TEACH_BACK_ATTEMPT_NOT_FOUND");
    const cConnection = await data.providerStore.createConnection(crossWorkspace, { providerKey: "phase12-fixture", protocol: "TEST", displayName: "Cross workspace fixture", endpoint: "https://example.com" });
    await data.providerStore.rotateCredential(crossWorkspace, cConnection.id, "fixture-secret"); await data.providerStore.setRoute(crossWorkspace, { routeSlot: "TEACH_BACK_ASSESSMENT", connectionId: cConnection.id, modelId: "phase12-assessment" });
    await expect(createOrAssessTeachBackAttempt(crossWorkspace, replay)).rejects.toThrow("COGNITION_NOT_CURRENT");
  });

  it("excludes regenerated historical lineage from mastery and refuses new assessment transfer", async () => {
    const data = await fixture(); const identity = { workspaceId: data.workspace.id, userId: data.userA.id }; installGateway();
    for (let index = 0; index < 26; index += 1) await data.cognition(`page-${index}`, false, true);
    const replacement = await data.cognition("replacement", false);
    const firstPage = await listMasteryCognitions(identity), repeatedFirstPage = await listMasteryCognitions(identity); expect(firstPage.items).toHaveLength(24); expect(firstPage.items.map(item => item.id)).toEqual(repeatedFirstPage.items.map(item => item.id)); expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await listMasteryCognitions(identity, { cursor: firstPage.nextCursor, pageSize: 50 }); expect(secondPage.items).toHaveLength(3); expect(new Set([...firstPage.items, ...secondPage.items].map(item => item.id)).size).toBe(27); expect(firstPage.items.some(item => item.id === data.first.item.id)).toBe(false); expect([...firstPage.items, ...secondPage.items].some(item => item.id === replacement.item.id)).toBe(true);
    const old = data.first.item; await expect(createOrAssessTeachBackAttempt(identity, { memoryItemId: old.id, attemptId: randomUUID(), content: "Old lineage cannot receive a new assessment." })).rejects.toThrow("COGNITION_NOT_CURRENT");
  });
  it("recovers only the owner's pending current attempt with its immutable content", async () => { const data = await fixture(); const owner = { workspaceId: data.workspace.id, userId: data.userA.id }, attemptId = randomUUID(), content = "Reload must retry this exact explanation."; installGateway({ inProgress: true }); await expect(createOrAssessTeachBackAttempt(owner, { memoryItemId: data.first.item.id, attemptId, content })).resolves.toMatchObject({ id: attemptId, pending: true }); await expect(recoverPendingTeachBackAttempt(owner, data.first.item.id)).resolves.toEqual({ id: attemptId, content }); await expect(recoverPendingTeachBackAttempt({ workspaceId: data.workspace.id, userId: data.userB.id }, data.first.item.id)).resolves.toBeNull(); await expect(recoverPendingTeachBackAttempt({ workspaceId: data.workspaceC.id, userId: data.userC.id }, data.first.item.id)).resolves.toBeNull(); });
});
