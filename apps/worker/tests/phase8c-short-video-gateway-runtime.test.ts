/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { buildBookContextForIntelligence, materializeChunkSet, processBookAnalysisRun, requestBookAnalysis, type AnalysisProvider } from "@ai-cognitive/book-intelligence";
import { configureShortVideoStyle, createShortVideoProject, processShortVideoGenerationRun, requestShortVideoGeneration } from "@ai-cognitive/short-video-generation";
import { parseKeyring, ProviderGatewayRepository } from "@ai-cognitive/provider-gateway";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { createBookAnalysisQueue, dispatchBookAnalysisWithQueue } from "../src/book-analysis.js";
import { createShortVideoGenerationQueue, dispatchShortVideoGenerationWithQueue } from "../src/short-video-generation.js";
import { startWorkerRuntime } from "../src/runtime.js";
import { createBookProductionGatewayRuntime, createShortVideoProductionGatewayRuntime } from "../src/provider-gateway-runtime.js";
import { createE2EWorkerIsolation } from "./helpers/e2e-worker-isolation.js";
import { DeterministicGatewayRetrievalEmbeddingProvider } from "../../../packages/book-intelligence/tests/helpers/book-analysis-embedding-gateway.js";

const environment = readEnvironment();
const storage = new S3CompatibleStorageProvider({ endpoint: environment.S3_ENDPOINT, publicEndpoint: environment.S3_PUBLIC_ENDPOINT, region: environment.S3_REGION, bucket: environment.S3_BUCKET, accessKey: environment.S3_ACCESS_KEY, secretKey: environment.S3_SECRET_KEY, forcePathStyle: environment.S3_FORCE_PATH_STYLE });
const keyring = JSON.stringify({ activeVersion: "v1", keys: { v1: Buffer.alloc(32, 7).toString("base64") } });
const manifest = JSON.stringify({ providers: [
  { providerKey: "deepseek", displayName: "Script fixture", protocol: "TEST", adapterVersion: "checkpoint6", models: [{ modelId: "short-video-script", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }] },
  { providerKey: "deterministic-test", displayName: "Embedding fixture", protocol: "TEST", adapterVersion: "checkpoint6", models: [{ modelId: "deterministic-vector-v1", families: ["EMBEDDING"], confidence: "VERIFIED", embeddingDimensions: 4, embeddingPurposes: ["DOCUMENT", "QUERY"] }] },
  { providerKey: "fixture-b", displayName: "Embedding route B fixture", protocol: "TEST", adapterVersion: "checkpoint6", models: [{ modelId: "fixture-b-model", families: ["EMBEDDING"], confidence: "VERIFIED", embeddingDimensions: 4, embeddingPurposes: ["QUERY"] }] },
  { providerKey: "openai", displayName: "Speech fixture", protocol: "TEST", adapterVersion: "checkpoint6", models: [{ modelId: "short-video-tts", families: ["SPEECH"], confidence: "VERIFIED", speechFormats: ["wav"], languages: ["zh-CN"] }] },
] });
const controls = { circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async (key: string) => ({ key, token: "checkpoint6" }), release: async () => true }, validateEndpoint: async () => undefined };
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function wav() { const samples = 20_000, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer); bytes.set(new TextEncoder().encode("RIFF")); view.setUint32(4, bytes.length - 8, true); bytes.set(new TextEncoder().encode("WAVEfmt "), 8); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, samples * 2, true); for (let index = 0; index < samples; index++) view.setInt16(44 + index * 2, Math.sin(index / 11) * 3000, true); return bytes; }
class Analysis implements AnalysisProvider { async generateStructured(request: any): Promise<any> { if (request.stage !== "CHUNK") return { summary: "bounded intelligence", memory: request.stage === "BOOK" ? [{ type: "SUMMARY", content: "Grounded claims require evidence." }] : undefined }; const blocks = await prisma.sourceBlock.findMany({ where: { id: { in: request.sourceBlockIds } }, orderBy: { ordinal: "asc" }, take: 2 }); return { summary: request.content.slice(0, 100), memory: [{ type: "QUOTE", content: request.content.slice(0, 100), evidence: blocks.map(block => ({ sourceBlockId: block.id, startOffset: 0, endOffset: Math.min(20, block.text.length), quoteText: block.text.slice(0, 20) })) }, { type: "CLAIM", content: "Claims require grounded evaluation." }] }; } }

describe("Phase 8C Short Video Gateway worker autonomy", () => it("runs the real worker with no injected Short Video providers", async () => {
  const suffix = randomUUID(), isolation = createE2EWorkerIsolation("phase8c-short-video"), user = await prisma.user.create({ data: { email: `${suffix}@checkpoint6.test` } }), workspace = await prisma.workspace.create({ data: { name: suffix } });
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "book.md" } }), blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: `checkpoint6/${suffix}` } }), document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: blob.storageKey } }), ingestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: (await prisma.job.create({ data: { workspaceId: workspace.id, userId: user.id, type: "source.ingest", payload: {} } })).id, parserVersion: "checkpoint6", normalizationVersion: "checkpoint6", status: "SUCCEEDED" } }), extraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "checkpoint6", parserVersion: "checkpoint6", normalizationVersion: "checkpoint6" } });
  for (const [ordinal, text] of ["# Evidence", ...Array.from({ length: 3 }, (_, index) => `Section ${index + 1}: A grounded quote explains why evidence matters and preserves provenance.`)].entries()) await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal, kind: ordinal === 0 ? "HEADING" : "PARAGRAPH", text, contentHash: `${suffix}-${ordinal}` } });
  await prisma.currentDocumentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id } });
  const store = new ProviderGatewayRepository(prisma, parseKeyring(keyring)!);
  const context = { workspaceId: workspace.id, userId: user.id };
  const embeddingConnection = await store.createConnection(context, { providerKey: "deterministic-test", protocol: "TEST", displayName: `${suffix}-embedding` }); await store.rotateCredential(context, embeddingConnection.id, "test-embedding-secret"); await store.setRoute(context, { routeSlot: "EMBEDDING", connectionId: embeddingConnection.id, modelId: "deterministic-vector-v1", configuration: { embeddingDimensions: 4 } });
  const scriptConnection = await store.createConnection(context, { providerKey: "deepseek", protocol: "TEST", displayName: `${suffix}-script` }); await store.rotateCredential(context, scriptConnection.id, "test-script-secret"); await store.setRoute(context, { routeSlot: "SHORT_VIDEO_SCRIPT", connectionId: scriptConnection.id, modelId: "short-video-script", configuration: { modelVersion: "v1" } });
  const speechConnection = await store.createConnection(context, { providerKey: "openai", protocol: "TEST", displayName: `${suffix}-speech` }); await store.rotateCredential(context, speechConnection.id, "test-speech-secret"); await store.setRoute(context, { routeSlot: "SHORT_VIDEO_TTS", connectionId: speechConnection.id, modelId: "short-video-tts", configuration: { modelVersion: "v1", providerVoiceId: "fixture-voice", voiceVersion: "1", speakingRate: 1, pitch: 0, outputFormat: "wav" } });
  let textCalls = 0, embeddingCalls = 0, speechCalls = 0;
  const failedGatewayRuns = new Set<string>();
  const gatewaySource = { ...process.env, BOOK_ANALYSIS_PROVIDER: "fixture-book", SHORT_VIDEO_GENERATION_PROVIDER: "deepseek", PROVIDER_GATEWAY_KEYRING: keyring, PROVIDER_GATEWAY_MODEL_MANIFEST: manifest };
  const retrievalEmbeddings = new DeterministicGatewayRetrievalEmbeddingProvider();
  const overrides = { ...controls, adapterResolver: () => ({ execute: async ({ request }: any) => {
    if (failedGatewayRuns.has(String(request.correlationId))) throw new Error("CHECKPOINT6_GATEWAY_REGENERATION_FAILURE");
    if (request.embedding) { embeddingCalls++; return { response: { vectors: await retrievalEmbeddings.embed({ texts: request.embedding.texts }), dimensions: 4 }, usage: { embeddingInputTokens: request.embedding.texts.length } }; }
    if (request.speech) { speechCalls++; return { response: { bytes: wav(), mediaType: "audio/wav", format: "wav", sampleRate: 8_000, channels: 1, durationMs: 2500 }, usage: { speechInputCharacters: request.speech.text.length } }; }
    textCalls++;
    if (String(request.idempotencyKey).includes("short-video-plan")) return { response: { type: "STRUCTURED", structured: { centralQuestion: "How does evidence change judgement?", viewerAssumption: "Answers arrive quickly.", coreInsight: "Evidence first.", cognitiveShift: "Verify before deciding.", hook: "Change the question.", supportingIdeas: ["evidence"], evidenceStrategy: "grounded", ending: "Ask for evidence.", targetDurationSeconds: 15, tone: "grounded" } }, usage: { inputTokens: 1, outputTokens: 1 } };
    const rawEvidence = request.text.messages[0].content ? JSON.parse(request.text.messages[0].content).context.flatMap((item: any) => item.evidence ?? []).slice(0, 2).reverse() : [];
    const evidence = rawEvidence.map((item: any) => ({ sourceBlockId: String(item.sourceBlockId), startOffset: Number(item.startOffset), endOffset: Number(item.endOffset), ...(typeof item.quoteText === "string" ? { quoteText: item.quoteText } : {}), ...(typeof item.quoteHash === "string" ? { quoteHash: item.quoteHash } : {}) }));
    return { response: { type: "STRUCTURED", structured: { scenes: ["HOOK", "QUESTION", "EVIDENCE", "CONCEPT", "REFRAME", "ENDING"].map((sceneType, index) => ({ ordinal: index + 1, sceneType, targetDurationMs: 2500, narrationText: `Grounded scene ${index + 1} requires evidence.`, visualIntent: "editorial", primaryText: `Evidence ${index + 1}`, secondaryText: "grounded", keywords: ["evidence"], layoutTemplate: ["QUESTION_CARD", "CONTRAST", "EVIDENCE_CARD", "CONCEPT_CARD", "CLAIM_CARD", "ENDING_CARD"][index], motionPreset: "REVEAL", transitionIntent: "FADE", evidence: sceneType === "EVIDENCE" ? evidence : [] })) } }, usage: { inputTokens: 1, outputTokens: 1 } };
  } }) };
  const bookGateway = createBookProductionGatewayRuntime(gatewaySource, overrides);
  const runtime = await startWorkerRuntime(environment, { source: gatewaySource, bookDependencies: { analysisProvider: new Analysis(), embeddingProvider: retrievalEmbeddings, embeddingGateway: { gateway: bookGateway.gateway, repository: bookGateway.repository, userId: user.id } }, bookProductionGatewayOverrides: overrides, dispatchIntervalMs: 60_000, bullmqPrefix: isolation.bullmqPrefix, outboxTopics: isolation.topics });
  const bookQueue = createBookAnalysisQueue(environment, { prefix: isolation.bullmqPrefix }), shortVideoQueue = createShortVideoGenerationQueue(environment, { prefix: isolation.bullmqPrefix });
  try {
    await Promise.all([runtime.bookWorker!.waitUntilReady(), runtime.shortVideoWorker!.waitUntilReady()]);
    await materializeChunkSet({ workspaceId: workspace.id, sourceDocumentId: document.id, configuration: { targetSize: 120, hardMax: 240 } });
    const book = await requestBookAnalysis({ workspaceId: workspace.id, sourceDocumentId: document.id, pipelineVersion: "checkpoint6", promptVersion: "checkpoint6", provider: "fixture-book", model: "fixture", modelVersion: "1", outboxTopic: isolation.topics.bookAnalysis }); await dispatchBookAnalysisWithQueue(bookQueue, { topic: isolation.topics.bookAnalysis }); await expect.poll(async () => (await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: book.run.id } })).status, { timeout: 30_000 }).toBe("SUCCEEDED");
    const project = await createShortVideoProject(context, { name: "Evidence", sourceDocumentIds: [document.id] }), style = await configureShortVideoStyle(context, project.id, { targetDurationSeconds: 15 });
    const requested = await requestShortVideoGeneration(context, { shortVideoProjectId: project.id, styleProfileId: style.id, provider: "deepseek", model: "short-video-script", modelVersion: "v1", pipelineVersion: "checkpoint6", promptVersion: "p1", retrievalVersion: "r1", scenePlannerVersion: "s1", captionVersion: "c1", audioVersion: "a1", renderVersion: "render", outboxTopic: isolation.topics.shortVideo });
    const production = createShortVideoProductionGatewayRuntime(gatewaySource, overrides);
    try { const embedding = await production.createEmbeddingProviderForRun({ workspaceId: workspace.id, shortVideoGenerationRunId: requested.run.id }); await embedding.embed({ texts: ["Create a grounded short video about Evidence"], model: "deterministic-vector-v1", correlationId: requested.run.id, operationKey: `short-video-query:${requested.run.id}:CONTEXT_RETRIEVAL:${document.id}` }); } finally { await production.close(); }
    await dispatchShortVideoGenerationWithQueue(shortVideoQueue, { topic: isolation.topics.shortVideo }); await expect.poll(async () => (await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: requested.run.id } })).status, { timeout: 90_000 }).toBe("SUCCEEDED");
    const [run, plan, scenes, narration, audio, render, evaluation, current, textReceipts, embeddingReceipts, speechReceipts] = await Promise.all([prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: requested.run.id } }), prisma.shortVideoPlan.findUniqueOrThrow({ where: { shortVideoGenerationRunId_workspaceId: { shortVideoGenerationRunId: requested.run.id, workspaceId: workspace.id } } }), prisma.shortVideoScene.count({ where: { shortVideoGenerationRunId: requested.run.id } }), prisma.shortVideoNarration.count({ where: { shortVideoGenerationRunId: requested.run.id } }), prisma.shortVideoAudioArtifact.findMany({ where: { shortVideoGenerationRunId: requested.run.id } }), prisma.shortVideoRenderArtifact.findUniqueOrThrow({ where: { shortVideoGenerationRunId: requested.run.id } }), prisma.shortVideoEvaluationRun.findFirstOrThrow({ where: { shortVideoGenerationRunId: requested.run.id } }), prisma.currentShortVideo.findUniqueOrThrow({ where: { shortVideoProjectId: project.id } }), prisma.providerTextResult.findMany({ where: { workspaceId: workspace.id } }), prisma.providerEmbeddingResult.findMany({ where: { workspaceId: workspace.id } }), prisma.providerSpeechResult.findMany({ where: { workspaceId: workspace.id } })]);
    expect([run.stage, plan.id.length > 0, scenes, narration, audio.length, current.revisionId.length > 0, evaluation.status, textCalls, embeddingCalls, speechCalls]).toEqual(["COMPLETED", true, 6, 6, 6, true, "SUCCEEDED", 2, 4, 6]);
    expect((await Promise.all(audio.map(async item => Boolean(item.narrationId) && item.unitOrdinal === 0 && sha(await storage.getObjectBytes(item.storageKey)) === item.sha256))).every(Boolean)).toBe(true);
    expect([sha(await storage.getObjectBytes(render.storageKey)), textReceipts.every(item => item.consumedAt && item.purgedAt && !item.ciphertext), embeddingReceipts.length > 0, speechReceipts.every(item => item.consumedAt && item.purgedAt && !item.ciphertext)]).toEqual([render.sha256, true, true, true]);
    // A consumed Scene receipt must bind the complete evidence lineage even when
    // the quote coordinates remain unchanged.  Move its generation source and
    // evidence together through valid rows, then replay the real Scene stage.
    const lineageRun = await requestShortVideoGeneration(context, { shortVideoProjectId: project.id, styleProfileId: style.id, provider: "deepseek", model: "short-video-script", modelVersion: "v1", pipelineVersion: "checkpoint6-lineage-receipt", promptVersion: "p1", retrievalVersion: "r1", scenePlannerVersion: "s1", captionVersion: "c1", audioVersion: "a1", renderVersion: "render", outboxTopic: isolation.topics.shortVideo });
    const lineageRuntime = createShortVideoProductionGatewayRuntime(gatewaySource, overrides);
    try {
      await expect(processShortVideoGenerationRun(lineageRun.run.id, { providerForRun: lineageRuntime.createTextProviderForRun, embeddingProviderForRun: lineageRuntime.createEmbeddingProviderForRun, ttsForRun: lineageRuntime.createSpeechProviderForRun, storage, faultInjector: point => { if (point === "afterScenesPersist") throw new Error("LINEAGE_RECEIPT_COMMITTED"); } })).rejects.toThrow("LINEAGE_RECEIPT_COMMITTED");
      const [generationSource, committedEvidence] = await Promise.all([prisma.shortVideoGenerationSource.findFirstOrThrow({ where: { shortVideoGenerationRunId: lineageRun.run.id } }), prisma.shortVideoNarrationEvidence.findMany({ where: { shortVideoGenerationRunId: lineageRun.run.id } })]);
      expect(committedEvidence.length).toBeGreaterThanOrEqual(2);
      const alternateAnalysis = await requestBookAnalysis({ workspaceId: workspace.id, sourceDocumentId: document.id, pipelineVersion: "checkpoint6-lineage-alternate", promptVersion: "checkpoint6-lineage-alternate", provider: "fixture-book", model: "fixture", modelVersion: "1", outboxTopic: isolation.topics.bookAnalysis });
      await prisma.shortVideoNarrationEvidence.deleteMany({ where: { shortVideoGenerationRunId: lineageRun.run.id } });
      await prisma.shortVideoGenerationSource.update({ where: { id: generationSource.id }, data: { analysisRunId: alternateAnalysis.run.id } });
      await prisma.shortVideoNarrationEvidence.createMany({ data: committedEvidence.map(item => ({ shortVideoGenerationRunId: item.shortVideoGenerationRunId, sceneId: item.sceneId, narrationId: item.narrationId, workspaceId: item.workspaceId, sourceDocumentId: item.sourceDocumentId, extractionId: item.extractionId, chunkSetId: item.chunkSetId, analysisRunId: alternateAnalysis.run.id, sourceBlockId: item.sourceBlockId, startOffset: item.startOffset, endOffset: item.endOffset, quoteText: item.quoteText, quoteHash: item.quoteHash })) });
      const lineageBaseline = [textCalls, embeddingCalls, speechCalls];
      await prisma.shortVideoGenerationRun.update({ where: { id: lineageRun.run.id }, data: { status: "RUNNING", stage: "SCENE_PLANNING", errorCode: null, executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null, completedAt: null } });
      await expect(processShortVideoGenerationRun(lineageRun.run.id, { provider: await lineageRuntime.createTextProviderForRun({ workspaceId: workspace.id, shortVideoGenerationRunId: lineageRun.run.id, provider: "deepseek", model: "short-video-script" }), embeddingProvider: retrievalEmbeddings, tts: await lineageRuntime.createSpeechProviderForRun({ workspaceId: workspace.id, shortVideoGenerationRunId: lineageRun.run.id }), storage })).rejects.toThrow("SHORT_VIDEO_TEXT_RECONCILIATION_REQUIRED");
      expect([textCalls, embeddingCalls, speechCalls]).toEqual(lineageBaseline);
    } finally { await lineageRuntime.close(); }
    // A second actual document/BookAnalysisRun proves every retrieval source is
    // pinned to one compatible, consumed vector-space identity before a query.
    const secondSuffix = randomUUID(), secondSource = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: `second-${secondSuffix}.md` } }), secondBlob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: secondSuffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: `checkpoint6/${secondSuffix}` } }), secondDocument = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: secondSource.id, sourceBlobId: secondBlob.id, version: 1, sha256: secondSuffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: secondBlob.storageKey } }), secondIngestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: secondDocument.id, jobId: (await prisma.job.create({ data: { workspaceId: workspace.id, userId: user.id, type: "source.ingest", payload: {} } })).id, parserVersion: "checkpoint6", normalizationVersion: "checkpoint6", status: "SUCCEEDED" } }), secondExtraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: secondDocument.id, ingestionRunId: secondIngestion.id, status: "SUCCEEDED", parserName: "checkpoint6", parserVersion: "checkpoint6", normalizationVersion: "checkpoint6" } });
    await prisma.sourceBlock.createMany({ data: ["# Independent evidence", "A second grounded source keeps retrieval provenance distinct.", "It must share the authoritative embedding identity."].map((text, ordinal) => ({ extractionId: secondExtraction.id, ordinal, kind: ordinal === 0 ? "HEADING" : "PARAGRAPH", text, contentHash: `${secondSuffix}-${ordinal}` })) });
    await prisma.currentDocumentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: secondDocument.id, extractionId: secondExtraction.id } });
    await materializeChunkSet({ workspaceId: workspace.id, sourceDocumentId: secondDocument.id, configuration: { targetSize: 80, hardMax: 160 } });
    const secondBook = await requestBookAnalysis({ workspaceId: workspace.id, sourceDocumentId: secondDocument.id, pipelineVersion: "checkpoint6-second", promptVersion: "checkpoint6", provider: "fixture-book", model: "fixture", modelVersion: "1", outboxTopic: isolation.topics.bookAnalysis });
    await processBookAnalysisRun(secondBook.run.id, { analysisProvider: new Analysis(), embeddingProvider: retrievalEmbeddings, embeddingGateway: { gateway: bookGateway.gateway, repository: bookGateway.repository, userId: user.id } });
    const multiProject = await createShortVideoProject(context, { name: "Multi-source identity", sourceDocumentIds: [document.id, secondDocument.id] }), multiStyle = await configureShortVideoStyle(context, multiProject.id, { targetDurationSeconds: 15 }), multiRun = await requestShortVideoGeneration(context, { shortVideoProjectId: multiProject.id, styleProfileId: multiStyle.id, provider: "deepseek", model: "short-video-script", modelVersion: "v1", pipelineVersion: "checkpoint6-retrieval", promptVersion: "p1", retrievalVersion: "r1", scenePlannerVersion: "s1", captionVersion: "c1", audioVersion: "a1", renderVersion: "render", outboxTopic: isolation.topics.shortVideo });
    const retrievalRuntime = createShortVideoProductionGatewayRuntime(gatewaySource, overrides);
    try {
      const gatewayEmbedding = await retrievalRuntime.createEmbeddingProviderForRun({ workspaceId: workspace.id, shortVideoGenerationRunId: multiRun.run.id });
      expect(gatewayEmbedding.identity).toMatchObject({ provider: "deterministic-test", model: "deterministic-vector-v1", embeddingVersion: "gateway", dimensions: 4 });
      const multiSources = await prisma.shortVideoGenerationSource.findMany({ where: { shortVideoGenerationRunId: multiRun.run.id }, orderBy: { sourceDocumentId: "asc" } }), firstSource = multiSources.find(item => item.sourceDocumentId === document.id)!, secondGenerationSource = multiSources.find(item => item.sourceDocumentId === secondDocument.id)!;
      const common = { workspaceId: workspace.id, sourceDocumentId: firstSource.sourceDocumentId, extractionId: firstSource.extractionId, chunkSetId: firstSource.chunkSetId, analysisRunId: firstSource.analysisRunId, task: "short video gateway retrieval parity", tokenBudget: 800 };
      const directContext = await buildBookContextForIntelligence({ ...common, embeddingProvider: retrievalEmbeddings });
      const routedContext = await buildBookContextForIntelligence({ ...common, embeddingProvider: gatewayEmbedding, operationKey: `short-video-query:${multiRun.run.id}:PARITY:${document.id}` });
      expect([routedContext.items.map(item => item.memoryItemId), routedContext.items.map(item => item.score), routedContext.estimatedTokens, routedContext.provenance]).toEqual([directContext.items.map(item => item.memoryItemId), directContext.items.map(item => item.score), directContext.estimatedTokens, directContext.provenance]);
      const query = await gatewayEmbedding.embed({ texts: ["Pinned route A query"], model: gatewayEmbedding.identity.model, correlationId: multiRun.run.id, operationKey: `short-video-query:${multiRun.run.id}:PINNED` }), beforeRouteChange = embeddingCalls;
      const routeB = await store.createConnection(context, { providerKey: "fixture-b", protocol: "TEST", displayName: `${secondSuffix}-route-b` }); await store.rotateCredential(context, routeB.id, "fixture-b-secret"); await store.setRoute(context, { routeSlot: "EMBEDDING", connectionId: routeB.id, modelId: "fixture-b-model", configuration: { embeddingDimensions: 4 } });
      const pinned = await retrievalRuntime.createEmbeddingProviderForRun({ workspaceId: workspace.id, shortVideoGenerationRunId: multiRun.run.id });
      expect(await pinned.embed({ texts: ["Pinned route A query"], model: pinned.identity.model, correlationId: multiRun.run.id, operationKey: `short-video-query:${multiRun.run.id}:PINNED` })).toEqual(query);
      await expect(pinned.embed({ texts: ["New B route query"], model: pinned.identity.model, correlationId: multiRun.run.id, operationKey: `short-video-query:${multiRun.run.id}:NEW` })).rejects.toThrow("SHORT_VIDEO_RETRIEVAL_EMBEDDING_ROUTE_IDENTITY_GAP");
      await expect(pinned.embed({ texts: ["Conflicting query"], model: pinned.identity.model, correlationId: multiRun.run.id, operationKey: `short-video-query:${multiRun.run.id}:PINNED` })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(embeddingCalls).toBe(beforeRouteChange);
      const secondInvocation = await prisma.providerInvocation.findUniqueOrThrow({ where: { workspaceId_idempotencyKey: { workspaceId: workspace.id, idempotencyKey: `book-analysis-embeddings:${secondGenerationSource.analysisRunId}` } }, include: { snapshot: true } });
      await prisma.providerEmbeddingResult.update({ where: { invocationId: secondInvocation.id }, data: { dimensions: 3 } }); await prisma.providerExecutionSnapshot.update({ where: { id: secondInvocation.snapshotId }, data: { capability: { ...(secondInvocation.snapshot.capability as Record<string, unknown>), embeddingDimensions: 3 }, configuration: {} } });
      await expect(retrievalRuntime.createEmbeddingProviderForRun({ workspaceId: workspace.id, shortVideoGenerationRunId: multiRun.run.id })).rejects.toThrow("SHORT_VIDEO_RETRIEVAL_SOURCE_EMBEDDING_INCOMPATIBLE");
      await prisma.providerEmbeddingResult.delete({ where: { invocationId: secondInvocation.id } });
      await expect(retrievalRuntime.createEmbeddingProviderForRun({ workspaceId: workspace.id, shortVideoGenerationRunId: multiRun.run.id })).rejects.toThrow("SHORT_VIDEO_RETRIEVAL_EMBEDDING_IDENTITY_MISSING");
      expect(embeddingCalls).toBe(beforeRouteChange);
      await store.setRoute(context, { routeSlot: "EMBEDDING", connectionId: embeddingConnection.id, modelId: "deterministic-vector-v1", configuration: { embeddingDimensions: 4 } });
    } finally { await retrievalRuntime.close(); }
    // A owns the real lease and receives a durable Gateway plan receipt, then
    // pauses before receipt consumption.  B reclaims the expired DB lease.
    const staleText = await requestShortVideoGeneration(context, { shortVideoProjectId: project.id, styleProfileId: style.id, provider: "deepseek", model: "short-video-script", modelVersion: "v1", pipelineVersion: "checkpoint6-stale-text", promptVersion: "p1", retrievalVersion: "r1", scenePlannerVersion: "s1", captionVersion: "c1", audioVersion: "a1", renderVersion: "render", outboxTopic: isolation.topics.shortVideo });
    const staleTextRuntime = createShortVideoProductionGatewayRuntime(gatewaySource, overrides); let textArrived!: () => void, releaseText!: () => void; const textArrivedGate = new Promise<void>(resolve => { textArrived = resolve; }), releaseTextGate = new Promise<void>(resolve => { releaseText = resolve; });
    const staleTextProviderForRun = async (input: any) => { const provider = await staleTextRuntime.createTextProviderForRun(input); return { identity: provider.identity, plan: async (request: any) => { const output = await provider.plan(request); textArrived(); await releaseTextGate; return output; }, scenes: provider.scenes.bind(provider), consumeTextResult: (provider as any).consumeTextResult.bind(provider), verifyConsumedTextResult: (provider as any).verifyConsumedTextResult.bind(provider) }; };
    try {
      const beforeTextRaceCalls = textCalls, beforeTextRacePlans = await prisma.shortVideoPlan.count({ where: { shortVideoGenerationRunId: staleText.run.id } }), beforeTextRaceRevisions = await prisma.shortVideoRevision.count({ where: { generationRunId: staleText.run.id } });
      const workerA = processShortVideoGenerationRun(staleText.run.id, { providerForRun: staleTextProviderForRun, embeddingProviderForRun: staleTextRuntime.createEmbeddingProviderForRun, ttsForRun: staleTextRuntime.createSpeechProviderForRun, storage, heartbeatIntervalMs: 60_000 });
      await textArrivedGate;
      const textOperation = `short-video-plan:${staleText.run.id}`, textInvocation = await prisma.providerInvocation.findUniqueOrThrow({ where: { workspaceId_idempotencyKey: { workspaceId: workspace.id, idempotencyKey: textOperation } }, include: { textResult: true } });
      expect([textCalls - beforeTextRaceCalls, textInvocation.textResult?.consumedAt, textInvocation.textResult?.purgedAt, Boolean(textInvocation.textResult?.ciphertext), await prisma.shortVideoPlan.count({ where: { shortVideoGenerationRunId: staleText.run.id } })]).toEqual([1, null, null, true, beforeTextRacePlans]);
      await prisma.$executeRaw`UPDATE "ShortVideoGenerationRun" SET "executionLeaseUntil"=NOW()-INTERVAL '1 second' WHERE "id"=${staleText.run.id}`;
      const workerB = processShortVideoGenerationRun(staleText.run.id, { providerForRun: staleTextRuntime.createTextProviderForRun, embeddingProviderForRun: staleTextRuntime.createEmbeddingProviderForRun, ttsForRun: staleTextRuntime.createSpeechProviderForRun, storage, faultInjector: point => { if (point === "afterPlanPersist") throw new Error("STALE_TEXT_B_STOP"); } });
      await expect(workerB).rejects.toThrow("STALE_TEXT_B_STOP");
      const afterB = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: staleText.run.id } }); expect(afterB.executionClaimToken).toBeNull();
      const afterBPlans = await prisma.shortVideoPlan.count({ where: { shortVideoGenerationRunId: staleText.run.id } }); releaseText(); await expect(workerA).rejects.toThrow("SHORT_VIDEO_OWNERSHIP_LOST");
      const afterA = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: staleText.run.id } }), afterAJob = await prisma.job.findUniqueOrThrow({ where: { id: staleText.run.jobId } }), afterAReceipt = await prisma.providerTextResult.findUniqueOrThrow({ where: { invocationId: textInvocation.id } });
      expect([textCalls - beforeTextRaceCalls, afterBPlans, await prisma.shortVideoRevision.count({ where: { generationRunId: staleText.run.id } }) - beforeTextRaceRevisions, afterAReceipt.consumedAt !== null, afterAReceipt.purgedAt !== null, afterA.status, afterAJob.status]).toEqual([1, beforeTextRacePlans + 1, 0, true, true, "FAILED", "FAILED"]);
    } finally { await staleTextRuntime.close(); }
    const staleSpeech = await requestShortVideoGeneration(context, { shortVideoProjectId: project.id, styleProfileId: style.id, provider: "deepseek", model: "short-video-script", modelVersion: "v1", pipelineVersion: "checkpoint6-stale-speech", promptVersion: "p1", retrievalVersion: "r1", scenePlannerVersion: "s1", captionVersion: "c1", audioVersion: "a1", renderVersion: "render", outboxTopic: isolation.topics.shortVideo });
    const staleSpeechRuntime = createShortVideoProductionGatewayRuntime(gatewaySource, overrides);
    try {
      await expect(processShortVideoGenerationRun(staleSpeech.run.id, { providerForRun: staleSpeechRuntime.createTextProviderForRun, embeddingProviderForRun: staleSpeechRuntime.createEmbeddingProviderForRun, ttsForRun: staleSpeechRuntime.createSpeechProviderForRun, storage, faultInjector: point => { if (point === "afterScenesPersist") throw new Error("STALE_SPEECH_PREPARED"); } })).rejects.toThrow("STALE_SPEECH_PREPARED");
      const preparedScenes = await prisma.shortVideoScene.findMany({ where: { shortVideoGenerationRunId: staleSpeech.run.id }, orderBy: { ordinal: "asc" } }); await prisma.shortVideoScene.deleteMany({ where: { id: { in: preparedScenes.slice(1).map(item => item.id) } } });
      await prisma.shortVideoGenerationRun.update({ where: { id: staleSpeech.run.id }, data: { status: "RUNNING", stage: "NARRATION_SYNTHESIS", executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null, completedAt: null, errorCode: null } });
      let speechArrived!: () => void, releaseSpeech!: () => void, bArtifact!: () => void, releaseB!: () => void; const speechArrivedGate = new Promise<void>(resolve => { speechArrived = resolve; }), releaseSpeechGate = new Promise<void>(resolve => { releaseSpeech = resolve; }), bArtifactGate = new Promise<void>(resolve => { bArtifact = resolve; }), releaseBGate = new Promise<void>(resolve => { releaseB = resolve; });
      const staleTtsForRun = async (input: any) => { const tts = await staleSpeechRuntime.createSpeechProviderForRun(input); return { identity: tts.identity, synthesize: async (request: any) => { const output = await tts.synthesize(request); speechArrived(); await releaseSpeechGate; return output; }, consumeSpeechResult: (tts as any).consumeSpeechResult.bind(tts), verifyConsumedSpeechResult: (tts as any).verifyConsumedSpeechResult.bind(tts) }; };
      const beforeSpeechRace = speechCalls, workerA = processShortVideoGenerationRun(staleSpeech.run.id, { providerForRun: staleSpeechRuntime.createTextProviderForRun, embeddingProviderForRun: staleSpeechRuntime.createEmbeddingProviderForRun, ttsForRun: staleTtsForRun, storage, heartbeatIntervalMs: 60_000 }); await speechArrivedGate;
      const narration = await prisma.shortVideoNarration.findFirstOrThrow({ where: { shortVideoGenerationRunId: staleSpeech.run.id } }), speechOperation = `short-video-tts:${staleSpeech.run.id}:${narration.id}:0`, speechInvocation = await prisma.providerInvocation.findUniqueOrThrow({ where: { workspaceId_idempotencyKey: { workspaceId: workspace.id, idempotencyKey: speechOperation } }, include: { speechResult: true } });
      expect([speechCalls - beforeSpeechRace, speechInvocation.speechResult?.consumedAt, speechInvocation.speechResult?.purgedAt, Boolean(speechInvocation.speechResult?.ciphertext), await prisma.shortVideoAudioArtifact.count({ where: { shortVideoGenerationRunId: staleSpeech.run.id } })]).toEqual([1, null, null, true, 0]);
      await prisma.$executeRaw`UPDATE "ShortVideoGenerationRun" SET "executionLeaseUntil"=NOW()-INTERVAL '1 second' WHERE "id"=${staleSpeech.run.id}`;
      const workerB = processShortVideoGenerationRun(staleSpeech.run.id, { providerForRun: staleSpeechRuntime.createTextProviderForRun, embeddingProviderForRun: staleSpeechRuntime.createEmbeddingProviderForRun, ttsForRun: staleSpeechRuntime.createSpeechProviderForRun, storage, faultInjector: async point => { if (point === "afterNarrationArtifactPersist") { bArtifact(); await releaseBGate; throw new Error("STALE_SPEECH_B_STOP"); } } }); await bArtifactGate;
      const bOwned = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: staleSpeech.run.id } }); expect([bOwned.executionClaimToken !== null, bOwned.executionLeaseUntil! > new Date(), bOwned.executionClaimToken]).toEqual([true, true, expect.any(String)]);
      const afterBArtifact = await prisma.shortVideoAudioArtifact.count({ where: { shortVideoGenerationRunId: staleSpeech.run.id } }); releaseSpeech(); await expect(workerA).rejects.toThrow("SHORT_VIDEO_OWNERSHIP_LOST");
      expect([speechCalls - beforeSpeechRace, await prisma.shortVideoAudioArtifact.count({ where: { shortVideoGenerationRunId: staleSpeech.run.id } }), await prisma.shortVideoRevision.count({ where: { generationRunId: staleSpeech.run.id } })]).toEqual([1, afterBArtifact, 0]); releaseB(); await expect(workerB).rejects.toThrow("STALE_SPEECH_B_STOP");
      const finalSpeechReceipt = await prisma.providerSpeechResult.findUniqueOrThrow({ where: { invocationId: speechInvocation.id } }); const finalArtifact = await prisma.shortVideoAudioArtifact.findFirstOrThrow({ where: { shortVideoGenerationRunId: staleSpeech.run.id } }); expect([finalSpeechReceipt.consumedAt !== null, finalSpeechReceipt.purgedAt !== null, finalSpeechReceipt.ciphertext, finalSpeechReceipt.iv, finalSpeechReceipt.authTag, sha(await storage.getObjectBytes(finalArtifact.storageKey)) === finalArtifact.sha256]).toEqual([true, true, null, null, null, true]);
    } finally { await staleSpeechRuntime.close(); }
    // The worker above proves zero-injection autonomy.  This second run keeps the
    // same real PostgreSQL/MinIO/Gateway factories but pauses at each durable
    // handoff boundary, proving recovery reuses the encrypted receipt.
    const crashRun = await requestShortVideoGeneration(context, { shortVideoProjectId: project.id, styleProfileId: style.id, provider: "deepseek", model: "short-video-script", modelVersion: "v1", pipelineVersion: "checkpoint6-crash", promptVersion: "p2", retrievalVersion: "r1", scenePlannerVersion: "s1", captionVersion: "c1", audioVersion: "a1", renderVersion: "render", outboxTopic: isolation.topics.shortVideo });
    const crashRuntime = createShortVideoProductionGatewayRuntime(gatewaySource, overrides);
    const resetExecution = () => prisma.shortVideoGenerationRun.update({ where: { id: crashRun.run.id }, data: { status: "RUNNING", errorCode: null, executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null, completedAt: null } });
    const direct = (faultInjector?: any, providerForRun?: any, ttsForRun?: any) => processShortVideoGenerationRun(crashRun.run.id, { providerForRun: providerForRun ?? crashRuntime.createTextProviderForRun, embeddingProviderForRun: crashRuntime.createEmbeddingProviderForRun, ttsForRun: ttsForRun ?? crashRuntime.createSpeechProviderForRun, storage, faultInjector });
    try {
      const beforePlanCalls = textCalls;
      const crashingPlan = async (input: any) => { const provider = await crashRuntime.createTextProviderForRun(input); return { identity: provider.identity, plan: async (request: any) => { await provider.plan(request); throw new Error("CRASH_AFTER_PLAN_RECEIPT"); }, scenes: provider.scenes.bind(provider), consumeTextResult: (provider as any).consumeTextResult.bind(provider), verifyConsumedTextResult: (provider as any).verifyConsumedTextResult.bind(provider) }; };
      await expect(direct(undefined, crashingPlan)).rejects.toThrow("CRASH_AFTER_PLAN_RECEIPT");
      const planReceipt = await prisma.providerTextResult.findFirstOrThrow({ where: { workspaceId: workspace.id, invocation: { idempotencyKey: `short-video-plan:${crashRun.run.id}` } } });
      expect([textCalls - beforePlanCalls, planReceipt.consumedAt, planReceipt.purgedAt, planReceipt.ciphertext !== null, await prisma.shortVideoPlan.count({ where: { shortVideoGenerationRunId: crashRun.run.id } })]).toEqual([1, null, null, true, 0]);
      await resetExecution();
      await expect(direct((point: string) => { if (point === "afterPlanPersist") throw new Error("CRASH_AFTER_PLAN_CONSUME"); })).rejects.toThrow("CRASH_AFTER_PLAN_CONSUME");
      expect([textCalls - beforePlanCalls, (await prisma.providerTextResult.findUniqueOrThrow({ where: { invocationId: planReceipt.invocationId } })).ciphertext, await prisma.shortVideoPlan.count({ where: { shortVideoGenerationRunId: crashRun.run.id } })]).toEqual([1, null, 1]);
      const planInvocation = await prisma.providerInvocation.findUniqueOrThrow({ where: { id: planReceipt.invocationId }, include: { attempts: true } });
      await resetExecution();
      const stopPlanAfterNaturalAdvance = async (input: any) => { const provider = await crashRuntime.createTextProviderForRun(input); return { identity: provider.identity, plan: provider.plan.bind(provider), scenes: async () => { throw new Error("STOP_AFTER_PLAN_REPLAY"); }, consumeTextResult: (provider as any).consumeTextResult.bind(provider), verifyConsumedTextResult: (provider as any).verifyConsumedTextResult.bind(provider) }; };
      await expect(direct(undefined, stopPlanAfterNaturalAdvance)).rejects.toThrow("STOP_AFTER_PLAN_REPLAY");
      const planReplay = await prisma.providerInvocation.findUniqueOrThrow({ where: { id: planReceipt.invocationId }, include: { attempts: true, textResult: true } }), afterPlanReplay = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: crashRun.run.id } });
      expect([planReplay.id, planReplay.attempts.length, planReplay.textResult?.consumedAt !== null, planReplay.textResult?.purgedAt !== null, await prisma.shortVideoPlan.count({ where: { shortVideoGenerationRunId: crashRun.run.id } }), afterPlanReplay.stage]).toEqual([planInvocation.id, planInvocation.attempts.length, true, true, 1, "SCENE_PLANNING"]);
      const crashingScenes = async (input: any) => { const provider = await crashRuntime.createTextProviderForRun(input); return { identity: provider.identity, plan: provider.plan.bind(provider), scenes: async (request: any) => { await provider.scenes(request); throw new Error("CRASH_AFTER_SCENE_RECEIPT"); }, consumeTextResult: (provider as any).consumeTextResult.bind(provider), verifyConsumedTextResult: (provider as any).verifyConsumedTextResult.bind(provider) }; };
      await expect(direct(undefined, crashingScenes)).rejects.toThrow("CRASH_AFTER_SCENE_RECEIPT");
      const sceneReceipt = await prisma.providerTextResult.findFirstOrThrow({ where: { workspaceId: workspace.id, invocation: { idempotencyKey: `short-video-scenes:${crashRun.run.id}` } } });
      expect([sceneReceipt.consumedAt, sceneReceipt.purgedAt, sceneReceipt.ciphertext !== null, await prisma.shortVideoScene.count({ where: { shortVideoGenerationRunId: crashRun.run.id } })]).toEqual([null, null, true, 0]);
      await resetExecution();
      await expect(direct((point: string) => { if (point === "afterScenesPersist") throw new Error("CRASH_AFTER_SCENE_CONSUME"); })).rejects.toThrow("CRASH_AFTER_SCENE_CONSUME");
      expect([(await prisma.providerTextResult.findUniqueOrThrow({ where: { invocationId: sceneReceipt.invocationId } })).ciphertext, await prisma.shortVideoScene.count({ where: { shortVideoGenerationRunId: crashRun.run.id } }), await prisma.shortVideoNarration.count({ where: { shortVideoGenerationRunId: crashRun.run.id } }), await prisma.shortVideoNarrationEvidence.count({ where: { shortVideoGenerationRunId: crashRun.run.id } })]).toEqual([null, 6, 6, 2]);
      const sceneInvocation = await prisma.providerInvocation.findUniqueOrThrow({ where: { id: sceneReceipt.invocationId }, include: { attempts: true } });
      await resetExecution();
      const stopSceneAfterNaturalAdvance = async (input: any) => { const provider = await crashRuntime.createSpeechProviderForRun(input); return { identity: provider.identity, synthesize: async () => { throw new Error("STOP_AFTER_SCENE_REPLAY"); }, consumeSpeechResult: (provider as any).consumeSpeechResult.bind(provider), verifyConsumedSpeechResult: (provider as any).verifyConsumedSpeechResult.bind(provider) }; };
      await expect(direct(undefined, undefined, stopSceneAfterNaturalAdvance)).rejects.toThrow("STOP_AFTER_SCENE_REPLAY");
      const sceneReplay = await prisma.providerInvocation.findUniqueOrThrow({ where: { id: sceneReceipt.invocationId }, include: { attempts: true, textResult: true } }), afterSceneReplay = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: crashRun.run.id } });
      expect([sceneReplay.id, sceneReplay.attempts.length, sceneReplay.textResult?.consumedAt !== null, sceneReplay.textResult?.purgedAt !== null, await prisma.shortVideoScene.count({ where: { shortVideoGenerationRunId: crashRun.run.id } }), await prisma.shortVideoNarration.count({ where: { shortVideoGenerationRunId: crashRun.run.id } }), await prisma.shortVideoNarrationEvidence.count({ where: { shortVideoGenerationRunId: crashRun.run.id } }), afterSceneReplay.stage]).toEqual([sceneInvocation.id, sceneInvocation.attempts.length, true, true, 6, 6, 2, "NARRATION_SYNTHESIS"]);
      const beforeSpeechCalls = speechCalls;
      const crashingSpeech = async (input: any) => { const provider = await crashRuntime.createSpeechProviderForRun(input); return { identity: provider.identity, synthesize: async (request: any) => { await provider.synthesize(request); throw new Error("CRASH_AFTER_SPEECH_RECEIPT"); }, consumeSpeechResult: (provider as any).consumeSpeechResult.bind(provider), verifyConsumedSpeechResult: (provider as any).verifyConsumedSpeechResult.bind(provider) }; };
      await expect(direct(undefined, undefined, crashingSpeech)).rejects.toThrow("CRASH_AFTER_SPEECH_RECEIPT");
      const speechReceipt = await prisma.providerSpeechResult.findFirstOrThrow({ where: { workspaceId: workspace.id, invocation: { idempotencyKey: { startsWith: `short-video-tts:${crashRun.run.id}:` } } } });
      expect([speechCalls - beforeSpeechCalls, speechReceipt.consumedAt, speechReceipt.purgedAt, speechReceipt.ciphertext !== null, await prisma.shortVideoAudioArtifact.count({ where: { shortVideoGenerationRunId: crashRun.run.id } })]).toEqual([1, null, null, true, 0]);
      await resetExecution();
      await expect(direct((point: string) => { if (point === "afterNarrationObjectUpload") throw new Error("CRASH_AFTER_S3_BEFORE_SPEECH_CONSUME"); })).rejects.toThrow("CRASH_AFTER_S3_BEFORE_SPEECH_CONSUME");
      expect([speechCalls - beforeSpeechCalls, (await prisma.providerSpeechResult.findUniqueOrThrow({ where: { invocationId: speechReceipt.invocationId } })).ciphertext !== null, await prisma.shortVideoAudioArtifact.count({ where: { shortVideoGenerationRunId: crashRun.run.id } })]).toEqual([1, true, 0]);
      await resetExecution();
      await expect(direct((point: string) => { if (point === "afterNarrationArtifactPersist") throw new Error("CRASH_AFTER_SPEECH_CONSUME"); })).rejects.toThrow("CRASH_AFTER_SPEECH_CONSUME");
      expect([speechCalls - beforeSpeechCalls, (await prisma.providerSpeechResult.findUniqueOrThrow({ where: { invocationId: speechReceipt.invocationId } })).ciphertext, await prisma.shortVideoAudioArtifact.count({ where: { shortVideoGenerationRunId: crashRun.run.id } })]).toEqual([1, null, 1]);
      const committedArtifact = await prisma.shortVideoAudioArtifact.findFirstOrThrow({ where: { shortVideoGenerationRunId: crashRun.run.id } }), speechInvocation = await prisma.providerInvocation.findUniqueOrThrow({ where: { id: speechReceipt.invocationId }, include: { attempts: true, snapshot: true, speechResult: true } });
      await resetExecution();
      const stopAfterCommittedSpeechReplay = async (input: any) => { const provider = await crashRuntime.createSpeechProviderForRun(input); return { identity: provider.identity, synthesize: async () => { throw new Error("STOP_AFTER_COMMITTED_SPEECH_REPLAY"); }, consumeSpeechResult: (provider as any).consumeSpeechResult.bind(provider), verifyConsumedSpeechResult: (provider as any).verifyConsumedSpeechResult.bind(provider) }; };
      await expect(direct(undefined, undefined, stopAfterCommittedSpeechReplay)).rejects.toThrow("STOP_AFTER_COMMITTED_SPEECH_REPLAY");
      const speechReplay = await prisma.providerInvocation.findUniqueOrThrow({ where: { id: speechReceipt.invocationId }, include: { attempts: true, snapshot: true, speechResult: true } }), replayArtifact = await prisma.shortVideoAudioArtifact.findUniqueOrThrow({ where: { id: committedArtifact.id } });
      expect([speechReplay.id, speechReplay.attempts.length, speechReplay.snapshot.id, speechReplay.speechResult?.consumedAt !== null, speechReplay.speechResult?.purgedAt !== null, await prisma.shortVideoAudioArtifact.count({ where: { shortVideoGenerationRunId: crashRun.run.id } }), replayArtifact.id, sha(await storage.getObjectBytes(replayArtifact.storageKey)) === replayArtifact.sha256]).toEqual([speechInvocation.id, speechInvocation.attempts.length, speechInvocation.snapshot.id, true, true, 1, committedArtifact.id, true]);
    } finally { await crashRuntime.close(); }
    const paidBaseline = [textCalls, embeddingCalls, speechCalls];
    const principalRuntime = createShortVideoProductionGatewayRuntime(gatewaySource, overrides), principalInput = { workspaceId: workspace.id, shortVideoGenerationRunId: requested.run.id, provider: "deepseek", model: "short-video-script" }, principalJob = await prisma.job.findUniqueOrThrow({ where: { id: requested.run.jobId } });
    try {
      await prisma.job.update({ where: { id: principalJob.id }, data: { userId: null } });
      await expect(principalRuntime.createTextProviderForRun(principalInput)).rejects.toThrow("SHORT_VIDEO_DURABLE_PRINCIPAL_MISSING");
      await prisma.job.update({ where: { id: principalJob.id }, data: { userId: user.id } });
      await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } } });
      await expect(principalRuntime.createTextProviderForRun(principalInput)).rejects.toThrow("SHORT_VIDEO_DURABLE_PRINCIPAL_MISSING");
      await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
      const alternateWorkspace = await prisma.workspace.create({ data: { name: `${suffix}-mismatch` } });
      await prisma.job.update({ where: { id: principalJob.id }, data: { workspaceId: alternateWorkspace.id } });
      await expect(principalRuntime.createTextProviderForRun(principalInput)).rejects.toThrow("SHORT_VIDEO_DURABLE_PRINCIPAL_WORKSPACE_MISMATCH");
      await prisma.job.update({ where: { id: principalJob.id }, data: { workspaceId: workspace.id } });
      await prisma.workspace.delete({ where: { id: alternateWorkspace.id } });
      expect([textCalls, embeddingCalls, speechCalls]).toEqual(paidBaseline);
    } finally { await principalRuntime.close(); }
    const beforeRedelivery = await prisma.job.findUniqueOrThrow({ where: { id: requested.run.jobId } });
    const redelivery = await shortVideoQueue.add("checkpoint6-terminal-redelivery", { shortVideoGenerationRunId: requested.run.id });
    await expect.poll(async () => redelivery.getState(), { timeout: 15_000 }).toBe("completed");
    const afterRedelivery = await prisma.job.findUniqueOrThrow({ where: { id: requested.run.jobId } }), terminalRun = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: requested.run.id } }), terminalCurrent = await prisma.currentShortVideo.findUniqueOrThrow({ where: { shortVideoProjectId: project.id } });
    expect([terminalRun.status, terminalRun.stage, afterRedelivery.attemptCount, terminalCurrent.revisionId, textCalls, embeddingCalls, speechCalls]).toEqual(["SUCCEEDED", "COMPLETED", beforeRedelivery.attemptCount, current.revisionId, ...paidBaseline]);
    const originalAudio = audio[0]!;
    await prisma.shortVideoAudioArtifact.update({ where: { id: originalAudio.id }, data: { sizeBytes: originalAudio.sizeBytes + 1 } });
    await prisma.shortVideoGenerationRun.update({ where: { id: requested.run.id }, data: { status: "RUNNING", stage: "NARRATION_SYNTHESIS", executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null, completedAt: null } });
    const artifactReconciliation = await shortVideoQueue.add("checkpoint6-speech-artifact-reconciliation", { shortVideoGenerationRunId: requested.run.id });
    await expect.poll(async () => artifactReconciliation.getState(), { timeout: 15_000 }).toBe("failed");
    const artifactReconciled = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: requested.run.id } });
    expect([artifactReconciled.status, artifactReconciled.errorCode, textCalls, embeddingCalls, speechCalls]).toEqual(["FAILED", "SHORT_VIDEO_SPEECH_RECONCILIATION_REQUIRED", ...paidBaseline]);
    await prisma.shortVideoAudioArtifact.update({ where: { id: originalAudio.id }, data: { sizeBytes: originalAudio.sizeBytes } });
    const regeneration = await requestShortVideoGeneration(context, { shortVideoProjectId: project.id, styleProfileId: style.id, provider: "deepseek", model: "short-video-script", modelVersion: "v1", pipelineVersion: "checkpoint6-regeneration", promptVersion: "p3", retrievalVersion: "r1", scenePlannerVersion: "s1", captionVersion: "c1", audioVersion: "a1", renderVersion: "render", outboxTopic: isolation.topics.shortVideo });
    failedGatewayRuns.add(regeneration.run.id);
    const regenerationRuntime = createShortVideoProductionGatewayRuntime(gatewaySource, overrides);
    try { await expect(processShortVideoGenerationRun(regeneration.run.id, { providerForRun: regenerationRuntime.createTextProviderForRun, embeddingProviderForRun: regenerationRuntime.createEmbeddingProviderForRun, ttsForRun: regenerationRuntime.createSpeechProviderForRun, storage })).rejects.toThrow("Provider execution failed"); } finally { await regenerationRuntime.close(); }
    const failedRegeneration = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: regeneration.run.id } }), failedJob = await prisma.job.findUniqueOrThrow({ where: { id: regeneration.run.jobId } }), preservedCurrent = await prisma.currentShortVideo.findUniqueOrThrow({ where: { shortVideoProjectId: project.id } });
    expect([failedRegeneration.status, failedJob.status, await prisma.shortVideoRevision.count({ where: { generationRunId: regeneration.run.id } }), preservedCurrent.revisionId]).toEqual(["FAILED", "FAILED", 0, current.revisionId]);
    const reconciliationBaseline = [textCalls, embeddingCalls, speechCalls];
    await prisma.shortVideoPlan.update({ where: { id: plan.id }, data: { centralQuestion: "tampered authoritative plan" } });
    await prisma.shortVideoGenerationRun.update({ where: { id: requested.run.id }, data: { status: "RUNNING", stage: "VIDEO_PLANNING", executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null, completedAt: null } });
    const reconciliation = await shortVideoQueue.add("checkpoint6-plan-reconciliation", { shortVideoGenerationRunId: requested.run.id });
    await expect.poll(async () => reconciliation.getState(), { timeout: 15_000 }).toBe("failed");
    const reconciled = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: requested.run.id } });
    expect([reconciled.status, reconciled.errorCode, textCalls, embeddingCalls, speechCalls]).toEqual(["FAILED", "SHORT_VIDEO_TEXT_RECONCILIATION_REQUIRED", ...reconciliationBaseline]);
    await storage.putObject({ key: originalAudio.storageKey, body: new Uint8Array([1, 2, 3]), contentType: originalAudio.mediaType });
    await prisma.shortVideoGenerationRun.update({ where: { id: requested.run.id }, data: { status: "RUNNING", stage: "NARRATION_SYNTHESIS", executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null, completedAt: null } });
    const speechReconciliation = await shortVideoQueue.add("checkpoint6-speech-object-reconciliation", { shortVideoGenerationRunId: requested.run.id });
    await expect.poll(async () => speechReconciliation.getState(), { timeout: 15_000 }).toBe("failed");
    const speechReconciled = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: requested.run.id } });
    expect([speechReconciled.status, speechReconciled.errorCode, textCalls, embeddingCalls, speechCalls]).toEqual(["FAILED", "SHORT_VIDEO_SPEECH_RECONCILIATION_REQUIRED", ...reconciliationBaseline]);
  } finally {
    await Promise.all([bookQueue.close(), shortVideoQueue.close()]);
    await runtime.close("test");
    await bookGateway.close();
    // Reconciliation fixtures can retain ProviderInvocation rows through RESTRICT
    // relations.  Remove only this test workspace's gateway graph before its
    // ordinary workspace cascade; never clean a shared Redis or database namespace.
    await prisma.providerEmbeddingResult.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.providerTextResult.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.providerSpeechResult.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.providerUsageEvent.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.providerInvocation.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.providerRouteBinding.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.providerCredentialVersion.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.providerConnection.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.providerAuditEvent.deleteMany({ where: { workspaceId: workspace.id } });
    const fixtureRunIds = (await prisma.shortVideoGenerationRun.findMany({ where: { workspaceId: workspace.id }, select: { id: true } })).map(item => item.id);
    await prisma.currentShortVideo.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.shortVideoRevision.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.shortVideoEvaluationResult.deleteMany({ where: { evaluationRun: { shortVideoGenerationRunId: { in: fixtureRunIds } } } });
    await prisma.shortVideoEvaluationRun.deleteMany({ where: { shortVideoGenerationRunId: { in: fixtureRunIds } } });
    await prisma.shortVideoRenderArtifact.deleteMany({ where: { shortVideoGenerationRunId: { in: fixtureRunIds } } });
    await prisma.shortVideoAudioArtifact.deleteMany({ where: { shortVideoGenerationRunId: { in: fixtureRunIds } } });
    await prisma.shortVideoVisualAsset.deleteMany({ where: { shortVideoGenerationRunId: { in: fixtureRunIds } } });
    await prisma.shortVideoCaptionCue.deleteMany({ where: { shortVideoGenerationRunId: { in: fixtureRunIds } } });
    await prisma.shortVideoNarrationEvidence.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.shortVideoNarration.deleteMany({ where: { shortVideoGenerationRunId: { in: fixtureRunIds } } });
    await prisma.shortVideoScene.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.shortVideoPlan.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.shortVideoSpeechExecutionPin.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.shortVideoGenerationSource.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.shortVideoGenerationRun.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.currentBookIntelligence.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.bookAnalysisRun.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.chunkSet.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.job.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.shortVideoProjectSource.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.shortVideoProject.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.source.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
}, 120_000));
afterAll(() => prisma.$disconnect());
