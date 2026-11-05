import { createHash, randomUUID } from "node:crypto";
import {
  createBookRevision,
  createBookRevisionPublicationService,
  materializeBookRevisionEmbedding,
  materializeBookRevisionModelReview,
  prepareBookRevisionEmbedding,
  prepareBookRevisionModelReview,
  previewBookRevision,
  readPublishedBookRevision,
  retrieveBookKnowledge,
  retrieveBookKnowledgeForIntelligence,
  reviewBookRevision,
} from "@ai-cognitive/book-intelligence";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { resolveBookProductExecution } from "../../../packages/book-intelligence/src/product-execution";
import { cognitionDetail, listCognitions, updateCognitionUserState } from "../lib/cognitions";
import { teachBackAttemptDetail } from "../lib/teach-back";
import { findCrossBookCognitionConnections } from "../lib/cognition-associations";
import { createBookAnalysisEmbeddingGatewayFixture } from "../../../packages/book-intelligence/tests/helpers/book-analysis-embedding-gateway";
import { embeddingIdentityWithHash } from "../../../packages/book-intelligence/src/embeddings";
import { builtInProviderCatalog, canonicalTextInputHash, stableHash, workspaceRoutesWithBookDefaults } from "@ai-cognitive/provider-gateway";
import { createProductionProviderGateway, ProviderExecutionRepository, ProviderGatewayRepository, ProviderRegistry, WorkspaceMembershipExecutionAuthorizer, testCipher, type ProviderAdapter } from "@ai-cognitive/provider-gateway";

async function fixture(existing?: { workspace: { id: string }; userA: { id: string }; userB: { id: string } }) {
  const suffix = randomUUID();
  const userA = existing?.userA ?? await prisma.user.create({ data: { email: `${suffix}-a@phase10.test` } });
  const userB = existing?.userB ?? await prisma.user.create({ data: { email: `${suffix}-b@phase10.test` } });
  const workspace = existing?.workspace ?? await prisma.workspace.create({ data: { name: `phase10-${suffix}` } });
  if (!existing) await prisma.workspaceMember.createMany({ data: [{ workspaceId: workspace.id, userId: userA.id, role: "OWNER" }, { workspaceId: workspace.id, userId: userB.id, role: "VIEWER" }] });
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

/** Publication fixtures must satisfy the same immutable source/tree/vector
 * rules as production; a synthetically SUCCEEDED run is not enough. */
async function sealPublicationBase(
  data: Awaited<ReturnType<typeof fixture>>,
  base: Awaited<ReturnType<typeof createRun>>,
  identity?: { hash: string; provider: string; model: string; embeddingVersion: string; dimensions: number },
) {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const identityHash = identity?.hash ?? "phase10-fixture-embedding";
  const dimensions = identity?.dimensions ?? 4;
  const analysisIdentityHash = sha(JSON.stringify([
    base.chunkSet.id, base.run.pipelineVersion, base.run.promptVersion,
    base.run.provider, base.run.model, base.run.modelVersion ?? "",
  ]));
  await prisma.bookAnalysisRun.update({ where: { id: base.run.id }, data: { analysisIdentityHash } });
  await prisma.job.update({ where: { id: base.run.jobId }, data: { result: { embeddingIdentityHash: identityHash } } });
  await prisma.analysisArtifact.update({ where: { id: base.artifact.id }, data: {
    summary: "Evidence-grounded fixture book", structuredOutput: { summary: "Evidence-grounded fixture book" },
  } });
  const chunks = await prisma.documentChunk.findMany({ where: { chunkSetId: base.chunkSet.id } });
  if (!chunks.length) throw new Error("PHASE10_PUBLICATION_SOURCE_CHUNK_MISSING");
  for (const chunk of chunks) {
    await prisma.documentChunk.update({ where: { id: chunk.id }, data: { contentHash: sha(chunk.content) } });
    await prisma.analysisArtifact.create({ data: {
      analysisRunId: base.run.id, workspaceId: data.workspace.id,
      chunkSetId: base.chunkSet.id, extractionId: data.extraction.id,
      scope: "CHUNK", ordinal: chunk.ordinal, chunkId: chunk.id,
      parentId: base.artifact.id, summary: "Evidence-backed fixture chunk",
      structuredOutput: { summary: "Evidence-backed fixture chunk" },
    } });
    await prisma.documentChunkEmbedding.create({ data: {
      chunkId: chunk.id, workspaceId: data.workspace.id, extractionId: data.extraction.id,
      provider: identity?.provider ?? "fixture", model: identity?.model ?? "fixture",
      embeddingVersion: identity?.embeddingVersion ?? "fixture-v1",
      embeddingIdentityHash: identityHash, dimensions,
      vector: Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0),
    } });
  }
  const memories = await prisma.bookMemoryItem.findMany({ where: { analysisRunId: base.run.id } });
  for (const item of memories) {
    await prisma.bookMemoryItem.update({ where: { id: item.id }, data: { contentHash: sha(item.content) } });
  }
}

/** Deterministic, zero-cost full Gateway text invocation and encrypted receipt. */
async function verifiedModelReview(
  actor: { workspaceId: string; userId: string },
  revision: { id: string; revisionHash: string },
  opts: { verdict?: "PASS" | "BLOCKED"; requestId?: string; corruptCitation?: boolean; legacySnapshot?: boolean; sameModel?: boolean } = {},
) {
  const requestId = opts.requestId ?? randomUUID();
  const reviewerProvider = opts.sameModel ? "fixture" : "deterministic-test";
  const cipher = testCipher();
  const store = new ProviderGatewayRepository(prisma, cipher);
  const connection = await store.createConnection(actor, {
    providerKey: reviewerProvider, protocol: "TEST", displayName: "phase10 reviewer " + requestId,
    endpoint: "https://semantic-review.fixture.test/v1",
  });
  await store.rotateCredential(actor, connection.id, "phase10-fixture-secret");
  const capability = {
    modelId: opts.sameModel ? "fixture" : "semantic-review-fixture-v1", families: ["TEXT_GENERATION"] as const,
    confidence: "VERIFIED" as const, structuredOutput: "JSON_MODE" as const,
  };
  await store.setRoute(actor, { routeSlot: opts.legacySnapshot ? "BOOK_SYNTHESIS" : "BOOK_SEMANTIC_REVIEW", connectionId: connection.id, modelId: capability.modelId });
  const registry = new ProviderRegistry();
  registry.register({ providerKey: reviewerProvider, displayName: "deterministic reviewer",
    protocol: "TEST", adapterVersion: "phase10-review-v1", models: [capability] });
  const previousManifest = process.env.PROVIDER_GATEWAY_MODEL_MANIFEST;
  let prepared: Awaited<ReturnType<typeof prepareBookRevisionModelReview>>;
  try {
    process.env.PROVIDER_GATEWAY_MODEL_MANIFEST = JSON.stringify({providers:[...builtInProviderCatalog.providers,
      {providerKey:reviewerProvider,displayName:"隔离审校模型",protocol:"TEST",adapterVersion:"phase10-review-v1",models:[capability]}]});
    prepared = await prepareBookRevisionModelReview(actor, revision.id, revision.revisionHash, requestId);
  } finally {
    if (previousManifest === undefined) delete process.env.PROVIDER_GATEWAY_MODEL_MANIFEST;
    else process.env.PROVIDER_GATEWAY_MODEL_MANIFEST = previousManifest;
  }
  if (opts.legacySnapshot) {
    const identity = stableHash({ workspaceId: actor.workspaceId, revisionId: revision.id,
      revisionHash: revision.revisionHash, requestId, evidenceBundleHash: prepared.evidenceBundleHash,
      rubricVersion: prepared.request.promptVersion });
    prepared.request.routeSlot = "BOOK_SYNTHESIS";
    prepared.request.correlationId = "book-semantic-review:" + identity.slice(0,16);
    prepared.request.idempotencyKey = "book-semantic-review-v1:" + identity;
    // Reconstruct the entire legacy BOOK_SYNTHESIS request, not just its slot.
    // Historical Gateway fingerprints include output token cap and the exact
    // serialized request, so retaining the new 6144 cap would falsely fail
    // old authenticated receipts after a budget-only schema evolution.
    const legacyText = { ...prepared.request.text!,
      generation: { ...prepared.request.text!.generation, maxOutputTokens: 3800 } };
    prepared.request.text = legacyText;
    prepared.request.inputHash = canonicalTextInputHash(legacyText);
    prepared.request.budget = { maxInputTokens: 28000, maxOutputTokens: 3800, maxAttempts: 1 };
    prepared.request.estimates = {
      inputTokens: Math.ceil(legacyText.messages[0]!.content.length / 2), outputTokens: 3800,
    };
  }
  const adapter: ProviderAdapter = { execute: async ({ request }) => {
    const body = JSON.parse(request.text!.messages[0]!.content) as {
      revisionHash: string; rubricVersion: string; claims: Array<{
        id: string; evidence: Array<{ sourceBlockId: string; startOffset: number; endOffset: number }>;
      }>;
    };
    const verdict = opts.verdict ?? "PASS";
    return { response: {
      type: "STRUCTURED", finishReason: "STOP", providerModel: capability.modelId,
      structured: {
        schemaVersion: 1, revisionHash: body.revisionHash,
        evidenceBundleHash: prepared.evidenceBundleHash,
        rubricVersion: body.rubricVersion, verdict,
        notes: verdict === "PASS" ? "Fixture claims checked against provided source" : "Evidence is insufficient",
        checks: body.claims.map(claim => ({
          claimId: claim.id, status: verdict === "PASS" ? "SUPPORTED" : "UNSUPPORTED",
          reason: "Compared against provided excerpt",
          citations: verdict === "PASS"
            ? [{
              sourceBlockId: opts.corruptCitation ? "forged-evidence" : claim.evidence[0]!.sourceBlockId,
              startOffset: claim.evidence[0]!.startOffset, endOffset: claim.evidence[0]!.endOffset,
            }] : [],
        })),
      },
    } };
  } };
  const repository = new ProviderExecutionRepository(prisma, cipher);
  const gateway = createProductionProviderGateway(
    registry, { resolveWorkspaceRoute: input => store.resolveWorkspaceRoute(input) },
    { resolve: async () => undefined }, () => adapter,
    { authorize: (principal, req) => new WorkspaceMembershipExecutionAuthorizer(prisma)
        .authorizeExecution(principal, req.workspaceId),
      assertRouteUsable: async () => undefined, validateEndpoint: async () => undefined,
      assertBudget: () => undefined, repository,
      circuit: { admit: async () => undefined, recordSuccess: async () => undefined,
        recordRetryableFailure: async () => undefined },
      rate: { admit: async () => undefined },
      concurrency: { acquire: async key => ({ key, token: "phase10-review-fixture" }),
        release: async () => true },
      maxAttempts: 1,
    },
  );
  const outcome = await gateway.execute(prepared.request, { userId: actor.userId });
  if (outcome.status !== "SUCCEEDED" || !outcome.invocationId || !outcome.snapshot)
    throw new Error("MODEL_REVIEW_GATEWAY_FIXTURE_FAILED");
  const receipt = { revisionId: revision.id, revisionHash: revision.revisionHash,
    requestId, invocationId: outcome.invocationId, snapshotId: outcome.snapshot.id };
  await materializeBookRevisionModelReview(repository, actor, receipt);
  return { receipt, repository };
}

afterAll(() => prisma.$disconnect());

describe("Phase 10 cognition product read model", () => {
  it("仅用有效 MiniMax 凭据补齐新任务缺省文本槽，保留显式选择", async () => {
    const data = await fixture();
    const actor = { workspaceId: data.workspace.id, userId: data.userA.id };
    const store = new ProviderGatewayRepository(prisma, testCipher());
    const connection = await store.createConnection(actor, {
      providerKey: "minimax", protocol: "OPENAI_COMPATIBLE", displayName: "MiniMax fixture",
      endpoint: "https://api.minimax.io/v1/chat/completions",
    });
    expect(await workspaceRoutesWithBookDefaults(actor.workspaceId)).toEqual([]);
    const request = { workspaceId: actor.workspaceId, routeSlot: "BOOK_SYNTHESIS" as const,
      correlationId: "default", idempotencyKey: "default", inputHash: "a".repeat(64),
      capability: { family: "TEXT_GENERATION" as const } };
    await expect(store.resolveWorkspaceRoute(request)).rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE" });
    await store.rotateCredential(actor, connection.id, "synthetic-only-fixture-credential");
    await expect(store.resolveWorkspaceRoute(request)).rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE" });
    const routes = await workspaceRoutesWithBookDefaults(actor.workspaceId);
    expect(routes.map(route => [route.routeSlot, route.modelId])).toEqual([
      ["BOOK_CHUNK_ANALYSIS", "MiniMax-M3"], ["BOOK_REDUCTION_ANALYSIS", "MiniMax-M3"],
      ["BOOK_SYNTHESIS", "MiniMax-M3"],
    ]);
    expect(await prisma.providerRouteBinding.count({ where: { workspaceId: actor.workspaceId } })).toBe(0);
    await store.setRoute(actor, { routeSlot: "BOOK_CHUNK_ANALYSIS", connectionId: connection.id, modelId: "explicit-model" });
    const selected = await workspaceRoutesWithBookDefaults(actor.workspaceId);
    expect(selected.find(route => route.routeSlot === "BOOK_CHUNK_ANALYSIS")?.modelId).toBe("explicit-model");
    expect(selected.some(route => route.routeSlot === "EMBEDDING" || route.routeSlot === "BOOK_SEMANTIC_REVIEW")).toBe(false);
    await store.setConnectionEnabled(actor, connection.id, false);
    await expect(store.resolveWorkspaceRoute({ ...request, routeSlot: "BOOK_CHUNK_ANALYSIS" })).rejects.toMatchObject({ code: "CONNECTION_DISABLED" });
    await expect(store.resolveWorkspaceRoute(request)).rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE" });
  });
  it("新任务冻结 M3 路由，后续用户切换模型不改写原计划", async () => {
    const data = await fixture();
    const actor = { workspaceId: data.workspace.id, userId: data.userA.id };
    const store = new ProviderGatewayRepository(prisma, testCipher());
    await expect(resolveBookProductExecution(actor.workspaceId)).rejects.toThrow("MINIMAX_BOOK_CONFIGURATION_REQUIRED");
    const m3 = await store.createConnection(actor, { providerKey: "minimax", protocol: "OPENAI_COMPATIBLE",
      displayName: "默认文本", endpoint: "https://api.minimax.cn/v1/chat/completions" });
    const glm = await store.createConnection(actor, { providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE",
      displayName: "用户选择", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions" });
    await store.rotateCredential(actor,m3.id,"synthetic-m3-only");
    await store.rotateCredential(actor,glm.id,"synthetic-glm-only");
    const vector = await store.createConnection(actor, { providerKey: "zhipu", protocol: "OPENAI_EMBEDDINGS",
      displayName: "独立向量服务", endpoint: "https://open.bigmodel.cn/api/paas/v4/embeddings" });
    await store.rotateCredential(actor,vector.id,"synthetic-vector-only");
    await store.setRoute(actor,{routeSlot:"EMBEDDING",connectionId:vector.id,modelId:"embedding-3"});
    const plan = await resolveBookProductExecution(actor.workspaceId);
    expect(plan.routePlan.routes.BOOK_CHUNK_ANALYSIS).toMatchObject({providerKey:"minimax",modelId:"MiniMax-M3",structuredOutput:"JSON_MODE"});
    const frozen = JSON.stringify(plan);
    await store.setRoute(actor,{routeSlot:"BOOK_CHUNK_ANALYSIS",connectionId:glm.id,modelId:"glm-4.7-flash"});
    const next = await resolveBookProductExecution(actor.workspaceId);
    expect(next.routePlan.routes.BOOK_CHUNK_ANALYSIS).toMatchObject({providerKey:"zhipu",modelId:"glm-4.7-flash"});
    expect(next.routePlan.routes.BOOK_SYNTHESIS.modelId).toBe("MiniMax-M3");
    expect(JSON.stringify(plan)).toBe(frozen);
    expect(await prisma.bookAnalysisRun.count({where:{workspaceId:actor.workspaceId}})).toBe(0);
  });
  it("rejects unauthorized, interrupted, and stale publication commands without changing the journal", async () => {
    const data = await fixture();
    const base = await createRun(data, "publication-guards");
    await makeCurrent(data, base);
    const actor = { workspaceId: data.workspace.id, userId: data.userA.id };
    const span = { sourceBlockId: data.block.id, startOffset: 0, endOffset: 14 };
    const chunk = await prisma.documentChunk.create({ data: {
      workspaceId: actor.workspaceId, chunkSetId: base.chunkSet.id, extractionId: data.extraction.id,
      structureVersion: "test", ordinal: 0, content: data.block.text, contentHash: data.suffix,
      characterCount: data.block.text.length, tokenEstimate: 10,
    } });
    await prisma.chunkSourceSpan.create({ data: { ...span, endOffset: data.block.text.length, chunkId: chunk.id, extractionId: data.extraction.id, ordinal: 0 } });
    await sealPublicationBase(data, base);
    const patch = { reason: "Fixture", archiveSha256: "a".repeat(64),
      summary: { text: "Revised summary", evidence: [span] }, memories: [] };
    await expect(createBookRevision(actor, base.run.id, {
      ...patch, summary: { ...patch.summary, evidence: [{ ...span, endOffset: 999 }] },
    })).rejects.toThrow("BOOK_REVISION_EVIDENCE_INVALID");
    const foreign = await fixture();
    await expect(createBookRevision({ workspaceId: foreign.workspace.id, userId: foreign.userA.id }, base.run.id, patch))
      .rejects.toThrow("BOOK_REVISION_BASE_NOT_AVAILABLE");
    const { revision } = await createBookRevision(actor, base.run.id, patch);
    const command = { analysisRunId: base.run.id, expectedPublicationId: null, action: "PUBLISH",
      revisionId: revision.id, revisionHash: revision.revisionHash, requestId: "publish" } as const;
    const publish = createBookRevisionPublicationService({ assertConsumersReady: async () => {} });
    const interrupted = createBookRevisionPublicationService({ assertConsumersReady: async () => {
      throw new Error("FIXTURE_CONSUMER_INTERRUPTED");
    } });
    const failAtCommit = (requestId: string) => createBookRevisionPublicationService({
      assertConsumersReady: async (tx, { analysisRunId }) => {
        await tx.$executeRaw`CREATE TEMP TABLE revision_commit_probe (run_id text, request_id text) ON COMMIT DROP`;
        await tx.$executeRaw`
          CREATE FUNCTION pg_temp.reject_revision_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM "BookRevisionPublication"
              WHERE "analysisRunId" = NEW.run_id AND "requestId" = NEW.request_id
            ) THEN
              RAISE EXCEPTION 'FIXTURE_JOURNAL_WRITE_NOT_OBSERVED';
            END IF;
            RAISE EXCEPTION 'FIXTURE_COMMIT_REJECTED_AFTER_JOURNAL_WRITE';
          END;
          $$
        `;
        await tx.$executeRaw`
          CREATE CONSTRAINT TRIGGER revision_commit_failure
          AFTER INSERT ON revision_commit_probe DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_revision_commit()
        `;
        await tx.$executeRaw`INSERT INTO revision_commit_probe VALUES (${analysisRunId}, ${requestId})`;
      },
    });
    await expect(publish({ ...actor, userId: data.userB.id }, command)).rejects.toThrow("BOOK_REVISION_FORBIDDEN");
    await reviewBookRevision(actor, revision.id, revision.revisionHash, {
      verdict: "BLOCKED", notes: "The excerpt exists but does not support the claim.", evidenceSha256: "b".repeat(64),
    });
    await expect(publish(actor, command)).rejects.toThrow("BOOK_REVISION_REVIEW_REQUIRED");
    await reviewBookRevision(actor, revision.id, revision.revisionHash, {
      verdict: "PASS", notes: "Fixture approval", evidenceSha256: "c".repeat(64),
    });
    await expect(publish(actor, command)).rejects.toThrow("BOOK_REVISION_MODEL_REVIEW_REQUIRED");
    const model = await verifiedModelReview(actor, revision, { legacySnapshot: true });
    await materializeBookRevisionModelReview(model.repository, actor, model.receipt);
    // A valid, independently attested PASS still cannot override bad CHUNK provenance.
    const unchangedChunk = await prisma.documentChunk.findFirstOrThrow({ where: { chunkSetId: base.chunkSet.id } });
    await prisma.documentChunk.update({ where: { id: unchangedChunk.id }, data: { contentHash: "0".repeat(64) } });
    try {
      await expect(publish(actor, command)).rejects.toThrow("BOOK_REVISION_STRUCTURE_REVIEW_REQUIRED");
      expect(await prisma.bookRevisionPublication.count({ where: { analysisRunId: base.run.id } })).toBe(0);
    } finally {
      await prisma.documentChunk.update({ where: { id: unchangedChunk.id }, data: { contentHash: unchangedChunk.contentHash } });
    }
    await prisma.bookIntelligenceRevision.update({ where: { id: revision.id }, data: {
      patch: { ...patch, summary: { ...patch.summary, text: "Tampered content" } },
    } });
    await expect(publish(actor, command)).rejects.toThrow("BOOK_REVISION_CONTENT_CHANGED");
    await prisma.bookIntelligenceRevision.update({ where: { id: revision.id }, data: { patch } });
    await expect(interrupted(actor, command)).rejects.toThrow("FIXTURE_CONSUMER_INTERRUPTED");
    await expect(failAtCommit(command.requestId)(actor, command)).rejects.toThrow("FIXTURE_COMMIT_REJECTED_AFTER_JOURNAL_WRITE");
    expect(await prisma.bookRevisionPublication.count({ where: { analysisRunId: base.run.id } })).toBe(0);
    const outcomes = await Promise.allSettled([
      publish(actor, command), publish(actor, { ...command, requestId: "racing-publish" }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(outcome => outcome.status === "rejected");
    expect(rejected?.reason).toMatchObject({ message: "BOOK_REVISION_PUBLICATION_CONFLICT" });
    const event = await prisma.bookRevisionPublication.findFirstOrThrow({ where: { analysisRunId: base.run.id } });
    expect(await publish(actor, { ...command, requestId: event.requestId })).toMatchObject({ id: event.id });
    const rollback = { analysisRunId: base.run.id, expectedPublicationId: event.id, action: "ROLLBACK",
      revisionId: null, revisionHash: null, requestId: "rollback" } as const;
    await expect(interrupted(actor, rollback)).rejects.toThrow("FIXTURE_CONSUMER_INTERRUPTED");
    await expect(failAtCommit(rollback.requestId)(actor, rollback)).rejects.toThrow("FIXTURE_COMMIT_REJECTED_AFTER_JOURNAL_WRITE");
    expect((await readPublishedBookRevision(actor, data.document.id)).publicationId).toBe(event.id);
    // A rollback to the unmodified baseline is revocation: it must remain
    // available even if the published source has since become inconsistent.
    const incidentChunk = await prisma.documentChunk.findFirstOrThrow({ where: { chunkSetId: base.chunkSet.id } });
    await prisma.documentChunk.update({ where: { id: incidentChunk.id }, data: { contentHash: "0".repeat(64) } });
    const rolledBack = await publish(actor, rollback).finally(async () => {
      await prisma.documentChunk.update({ where: { id: incidentChunk.id }, data: { contentHash: incidentChunk.contentHash } });
    });
    const restarted = createBookRevisionPublicationService({ assertConsumersReady: async () => {} });
    expect(await restarted(actor, rollback)).toMatchObject({ id: rolledBack.id });
    const republished = await restarted(actor, { ...command, expectedPublicationId: rolledBack.id, requestId: "republish" });
    expect(republished).toMatchObject({ previousId: rolledBack.id, sequence: 3 });
  });

  it("rejects invalid model citations and a genuine BLOCKED receipt without publication", async () => {
    const data = await fixture();
    const base = await createRun(data, "semantic-negative");
    await makeCurrent(data, base);
    const actor = { workspaceId: data.workspace.id, userId: data.userA.id };
    const span = { sourceBlockId: data.block.id, startOffset: 0, endOffset: 14 };
    const chunk = await prisma.documentChunk.create({ data: {
      workspaceId: actor.workspaceId, chunkSetId: base.chunkSet.id,
      extractionId: data.extraction.id, structureVersion: "test", ordinal: 0,
      content: data.block.text, contentHash: data.suffix,
      characterCount: data.block.text.length, tokenEstimate: 10,
    } });
    await prisma.chunkSourceSpan.create({ data: {
      ...span, endOffset: data.block.text.length, chunkId: chunk.id,
      extractionId: data.extraction.id, ordinal: 0,
    } });
    await sealPublicationBase(data, base);
    const { revision } = await createBookRevision(actor, base.run.id, {
      reason: "Fixture negative semantic checks", archiveSha256: "a".repeat(64),
      summary: { text: "Unverified summary", evidence: [span] }, memories: [],
    });
    const publish = createBookRevisionPublicationService({ assertConsumersReady: async () => {} });
    const command = { analysisRunId: base.run.id, expectedPublicationId: null,
      action: "PUBLISH", revisionId: revision.id, revisionHash: revision.revisionHash,
      requestId: randomUUID() } as const;
    await expect(verifiedModelReview(actor, revision, { sameModel: true }))
      .rejects.toThrow("BOOK_MODEL_REVIEW_NOT_INDEPENDENT");
    await expect(verifiedModelReview(actor, revision, { corruptCitation: true }))
      .rejects.toThrow("BOOK_MODEL_REVIEW_CITATION_INVALID");
    expect(await prisma.bookIntelligenceRevisionReview.count({ where: { revisionId: revision.id } })).toBe(0);
    await verifiedModelReview(actor, revision, { verdict: "BLOCKED" });
    await expect(publish(actor, command)).rejects.toThrow("BOOK_REVISION_REVIEW_REQUIRED");
    expect(await prisma.bookRevisionPublication.count({ where: { analysisRunId: base.run.id } })).toBe(0);
  });

  it("keeps the publication bound to its review until the journal rolls back", async () => {
    const data = await fixture();
    const base = await createRun(data, "revision");
    await makeCurrent(data, base);
    const item = await memory(data, base, 0, "Original cognition", "CLAIM", true);
    const actor = { workspaceId: data.workspace.id, userId: data.userA.id };
    const gatewayFixture = await createBookAnalysisEmbeddingGatewayFixture(actor);
    const embedding = embeddingIdentityWithHash(gatewayFixture.retrievalEmbeddings.identity);
    await prisma.bookMemoryItem.update({ where: { id: item.id }, data: {
      contentHash: createHash("sha256").update(item.content).digest("hex"),
    } });
    await prisma.job.update({ where: { id: base.run.jobId }, data: { result: { embeddingIdentityHash: embedding.hash } } });
    await prisma.bookMemoryEmbedding.create({ data: {
      memoryItemId: item.id, analysisRunId: base.run.id, workspaceId: actor.workspaceId,
      extractionId: data.extraction.id, provider: embedding.provider, model: embedding.model,
      embeddingVersion: embedding.embeddingVersion, embeddingIdentityHash: embedding.hash, dimensions: embedding.dimensions,
      vector: [-1, 0, 0, 0],
    } });
    const chunk = await prisma.documentChunk.create({ data: {
      workspaceId: actor.workspaceId, chunkSetId: base.chunkSet.id, extractionId: data.extraction.id,
      structureVersion: "test", ordinal: 0, content: data.block.text, contentHash: data.suffix,
      characterCount: data.block.text.length, tokenEstimate: 10,
    } });
    const span = { sourceBlockId: data.block.id, startOffset: 0, endOffset: 14 };
    await prisma.chunkSourceSpan.create({ data: { ...span, endOffset: data.block.text.length, chunkId: chunk.id, extractionId: data.extraction.id, ordinal: 0 } });
    await sealPublicationBase(data, base, embedding);
    const { revision } = await createBookRevision(actor, base.run.id, {
      reason: "Fixture revision", archiveSha256: "a".repeat(64),
      summary: { text: "Revised summary", evidence: [span] },
      memories: [{ id: item.id, text: "Revised cognition", addEvidence: [{ ...span, startOffset: 14, endOffset: 24 }] }],
    });
    await reviewBookRevision(actor, revision.id, revision.revisionHash, {
      verdict: "PASS", notes: "Legacy editorial approval", evidenceSha256: "b".repeat(64),
    });
    const publish = createBookRevisionPublicationService({ assertConsumersReady: async () => {} });
    const command = {
      analysisRunId: base.run.id, expectedPublicationId: null, action: "PUBLISH", requestId: "publish",
      revisionId: revision.id, revisionHash: revision.revisionHash,
    } as const;
    await expect(publish(actor, command)).rejects.toThrow("BOOK_REVISION_VECTOR_NOT_READY");
    const prepared = await prepareBookRevisionEmbedding(actor, revision.id, revision.revisionHash, item.id);
    const { gateway, repository } = gatewayFixture.embeddingGateway;
    const result = await gateway.execute(prepared.request, { userId: actor.userId });
    if (result.status !== "SUCCEEDED") throw new Error(`Fixture embedding failed: ${result.status}`);
    const materialization = { revisionId: revision.id, revisionHash: revision.revisionHash, memoryItemId: item.id,
      invocationId: result.invocationId!, snapshotId: result.snapshot!.id };
    await materializeBookRevisionEmbedding(repository, actor, materialization);
    await materializeBookRevisionEmbedding(repository, actor, materialization);
    expect(gatewayFixture.remoteCallCount()).toBe(1);
    const { revision: successor } = await createBookRevision(actor, base.run.id, {
      reason: "Fixture successor", archiveSha256: "a".repeat(64),
      summary: { text: "Another revised summary", evidence: [span] },
      memories: [{ id: item.id, text: "Revised cognition", addEvidence: [{ ...span, startOffset: 14, endOffset: 24 }] }],
    });
    const successorPreview = await previewBookRevision(actor, successor.id, successor.revisionHash);
    expect(successorPreview.memories[0]?.vectorState).toBe("REFRESHED");
    expect(gatewayFixture.remoteCallCount()).toBe(1);
    const other = await fixture(data);
    const otherRun = await createRun(other, "cross-book");
    const related = await memory(other, otherRun, 0, "A related cognition");
    await makeCurrent(other, otherRun);
    const [relatedVector] = await gatewayFixture.retrievalEmbeddings.embed({ texts: ["Revised cognition"] });
    await prisma.bookMemoryEmbedding.create({ data: {
      memoryItemId: related.id, analysisRunId: otherRun.run.id, workspaceId: actor.workspaceId,
      extractionId: other.extraction.id, provider: embedding.provider, model: embedding.model,
      embeddingVersion: embedding.embeddingVersion, embeddingIdentityHash: embedding.hash, dimensions: embedding.dimensions,
      vector: relatedVector!,
    } });
    expect(await findCrossBookCognitionConnections(actor, related.id)).toEqual([]);
    await expect(publish(actor, command)).rejects.toThrow("BOOK_REVISION_MODEL_REVIEW_REQUIRED");
    const model = await verifiedModelReview(actor, revision);
    const review = (await previewBookRevision(actor, revision.id, revision.revisionHash)).review!;
    const event = await publish(actor, command);
    expect(await findCrossBookCognitionConnections(actor, related.id)).toMatchObject([
      { id: item.id, content: "Revised cognition", semantics: "SEMANTICALLY_RELATED" },
    ]);
    expect(await findCrossBookCognitionConnections(actor, item.id)).toMatchObject([{ id: related.id }]);
    const query = { workspaceId: actor.workspaceId, sourceDocumentId: data.document.id, query: "fixture", limit: 1,
      embeddingProvider: { identity: gatewayFixture.retrievalEmbeddings.identity, embed: async () => [[1, 0, 0, 0]] } };
    expect((await retrieveBookKnowledge(query))[0]).toMatchObject({ content: "Revised cognition", publicationId: event.id });
    expect((await retrieveBookKnowledge(query))[0]?.score).toBeGreaterThan(0);
    await reviewBookRevision(actor, revision.id, revision.revisionHash, {
      verdict: "BLOCKED", notes: "Later independent review", evidenceSha256: "c".repeat(64),
    });
    expect((await readPublishedBookRevision(actor, data.document.id)).revision?.review?.id).toBe(review.id);
    // Historical release identity remains independently verifiable after the
    // reviewer leaves. Other authorized workspace members retain read access;
    // the departed reviewer cannot issue new reads or model review requests.
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: actor } });
    try {
      const viewer = { workspaceId: actor.workspaceId, userId: data.userB.id };
      expect((await readPublishedBookRevision(viewer, data.document.id)).revision?.review?.id).toBe(review.id);
      await expect(readPublishedBookRevision(actor, data.document.id)).rejects.toThrow("BOOK_REVISION_FORBIDDEN");
      await expect(prepareBookRevisionModelReview(actor, revision.id, revision.revisionHash, "revoked-review"))
        .rejects.toThrow("BOOK_REVISION_FORBIDDEN");
    } finally {
      await prisma.workspaceMember.create({ data: { ...actor, role: "OWNER" } });
    }
    expect((await listCognitions(actor)).items.find(row => row.id === item.id)?.content).toBe("Revised cognition");
    expect((await cognitionDetail(actor, item.id))?.evidence).toHaveLength(2);
    const attempt = await prisma.teachBackAttempt.create({ data: {
      id: randomUUID(), ...actor, memoryItemId: item.id, content: "Fixture explanation", bookPublicationId: event.id,
    } });
    expect(await teachBackAttemptDetail(actor, attempt.id)).toMatchObject({ historical: false, bookPublicationId: event.id });
    let enterEmbedding!: () => void;
    const entered = new Promise<void>(resolve => { enterEmbedding = resolve; });
    let resumeEmbedding!: () => void;
    const resume = new Promise<void>(resolve => { resumeEmbedding = resolve; });
    const inFlight = retrieveBookKnowledge({
      ...query, embeddingProvider: { ...query.embeddingProvider, embed: async () => {
        enterEmbedding();
        await resume;
        return [[1, 0, 0, 0]];
      } },
    });
    try {
      await Promise.race([entered, inFlight]);
      await publish(actor, {
        analysisRunId: base.run.id, expectedPublicationId: event.id, action: "ROLLBACK", requestId: "rollback",
        revisionId: null, revisionHash: null,
      });
    } finally {
      resumeEmbedding();
    }
    expect((await inFlight)[0]).toMatchObject({ content: "Revised cognition", publicationId: event.id });
    expect(await findCrossBookCognitionConnections(actor, related.id)).toEqual([]);
    expect((await readPublishedBookRevision(actor, data.document.id)).revision).toBeNull();
    expect((await retrieveBookKnowledge(query))[0]).toMatchObject({ content: item.content, score: -1 });
    expect((await retrieveBookKnowledgeForIntelligence({
      ...query, analysisRunId: base.run.id, extractionId: data.extraction.id,
      chunkSetId: base.chunkSet.id, bookPublicationId: event.id,
    }))[0]).toMatchObject({ content: "Revised cognition", publicationId: event.id });
    expect(await teachBackAttemptDetail(actor, attempt.id)).toMatchObject({
      historical: true, bookPublicationId: event.id, sourceGrounding: "VERIFIABLE",
      memoryItem: { content: "Revised cognition" },
      evidence: expect.arrayContaining([{ excerpt: data.block.text.slice(14, 24), blockOrdinal: 0 }]),
    });
  });

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
    expect(detail?.evidence).toEqual([{ id: expect.any(String), excerpt: data.block.text.slice(0, 14), blockOrdinal: 0, startOffset: 0, endOffset: 14 }]);
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
