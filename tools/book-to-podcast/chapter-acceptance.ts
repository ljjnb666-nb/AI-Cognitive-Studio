/** Explicit operator for one real, privately ingested Chapter I. `prepare`
 * configures existing services without external calls. `run` requires a new
 * budget grant; it never resumes or retries an earlier execution. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runChapterEditorial } from "./chapter-editorial.js";
import { prisma } from "../../packages/db/src/index.js";
import { ProviderGatewayRepository, resolveCredentialKeyring } from "../../packages/provider-gateway/src/index.js";
import { resolveBookAnalysisVersions, resolveBookProductExecution, requestBookAnalysisForUser, processBookAnalysisRun } from "../../packages/book-intelligence/src/index.js";
import { createVoiceProfile, createEpisodeAudioConfig, requestPodcastGeneration, processPodcastGenerationRun, requestPodcastAudioGeneration, processPodcastAudioGenerationRun } from "../../packages/podcast-generation/src/index.js";
import { createBookProductionGatewayRuntime, createPodcastProductionGatewayRuntime, createPodcastAudioProductionGatewayRuntime } from "../../apps/worker/src/provider-gateway-runtime.js";
import { S3CompatibleStorageProvider } from "../../packages/storage/src/index.js";
import { chapterLimits, paidChapterLimits, resilientChapterLimits, createChapterBudget, maximumPricedCny, maximumPaidPricedCny, maximumResilientPricedCny, maximumAirPricedCny, airScriptLimits, citableChapterLimits, citableAirScriptLimits, maximumCitablePricedCny, sourceChapterLimits, sourceAirScriptLimits, maximumSourcePricedCny } from "./chapter-budget.js";

const hash = (s: Uint8Array) => createHash("sha256").update(s).digest("hex");
async function main() {
  const root = process.env.BOOK_PODCAST_PRIVATE_ROOT, mode = process.argv[2];
  if (root && mode === "run-editorial") return runChapterEditorial(root);
  if (!root || !["prepare", "prepare-paid", "prepare-resilient", "prepare-air", "prepare-air-citable", "prepare-air-source", "run"].includes(mode ?? "")) throw Error("CHAPTER_MODE_REQUIRED");
  const sourceResume = mode === "prepare-air-source" || process.env.CHAPTER_BUDGET_AUTHORIZATION === "CHAPTER_I_AIR_SOURCE_V6_ONCE_CUMULATIVE_8.00_CNY";
  const citableResume = mode === "prepare-air-citable" || process.env.CHAPTER_BUDGET_AUTHORIZATION === "CHAPTER_I_AIR_CITABLE_V5_ONCE_CUMULATIVE_6.50_CNY";
  const airResume = process.env.CHAPTER_BUDGET_AUTHORIZATION === "CHAPTER_I_AIR_EVIDENCE_V4_ONCE_SAME_5.50_CNY";
  const air = sourceResume || citableResume || airResume || mode === "prepare-air" || process.env.CHAPTER_BUDGET_AUTHORIZATION === "CHAPTER_I_AIR_SCRIPT_ONCE_SAME_5.50_CNY";
  const dataResume = air || process.env.CHAPTER_BUDGET_AUTHORIZATION === "CHAPTER_I_FLASHX_DATA_V3_ONCE_SAME_5.50_CNY";
  const jsonResume = dataResume || process.env.CHAPTER_BUDGET_AUTHORIZATION === "CHAPTER_I_FLASHX_JSON_V2_ONCE_SAME_5.50_CNY";
  const boundedRetry = jsonResume || mode === "prepare-resilient" || process.env.CHAPTER_BUDGET_AUTHORIZATION === "CHAPTER_I_FLASHX_BOUNDED_RETRY_5.50_CNY_ONCE";
  const podcastPromptVersion = sourceResume ? "phase9-web-source-v6" : citableResume ? "phase9-web-citable-v5" : airResume ? "phase9-web-evidence-v4" : dataResume ? "phase9-web-data-v3" : jsonResume ? "phase9-web-json-v2" : "phase9-web-v1";
  const paidResumeLater = process.env.CHAPTER_BUDGET_AUTHORIZATION === "CHAPTER_I_FLASHX_RESUME_SECOND_TIMEOUT_ONCE_SAME_3.00_CNY";
  const paidResume = (boundedRetry && mode === "run") || paidResumeLater || process.env.CHAPTER_BUDGET_AUTHORIZATION === "CHAPTER_I_FLASHX_RESUME_TIMEOUT_ONCE_SAME_3.00_CNY";
  const paid = boundedRetry || mode === "prepare-paid" || paidResume || process.env.CHAPTER_BUDGET_AUTHORIZATION === "CHAPTER_I_FLASHX_3.00_CNY_ONCE";
  if (paid) process.env.BOOK_ANALYSIS_PROMPT_VERSION = "chapter-source-evidence-v2";
  const textModel = paid ? "glm-4.7-flashx" : "glm-4.7-flash";
  const podcastModel = air ? "glm-4.5-air" : textModel;
  const outputRoot = paid ? join(root, "paid-flashx-attempt-v1") : root;
  const identity = JSON.parse(await readFile(join(root, "podcast-product-preparation.private.json"), "utf8")) as { workspaceId: string; userId: string; episodeId: string; projectId: string; sourceDocumentId: string; extractionId: string; hostIds: string[] };
  const ctx = { workspaceId: identity.workspaceId, userId: identity.userId };
  if (hash(await readFile(join(root, "pg1342-chapter-01.private.epub"))) !== "41fef531a3e6347cfcd0a6f3b15208173fbe9efbe6fb7952933227af16f8e776") throw Error("CHAPTER_SOURCE_SHA_MISMATCH");
  const current = await prisma.currentDocumentExtraction.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId, sourceDocumentId: identity.sourceDocumentId, extractionId: identity.extractionId } });
  if (current.extractionId !== identity.extractionId) throw Error("CHAPTER_EXTRACTION_CHANGED");
  const configurationPath = join(root, sourceResume ? "chapter-air-source-configuration.private.json" : citableResume ? "chapter-air-citable-configuration.private.json" : air ? "chapter-air-configuration.private.json" : boundedRetry ? "chapter-resilient-configuration.private.json" : paid ? "chapter-paid-configuration.private.json" : "chapter-configuration.private.json");
  const limits = sourceResume ? sourceChapterLimits : citableResume ? citableChapterLimits : boundedRetry ? resilientChapterLimits : paid ? paidChapterLimits : chapterLimits;
  const maximum = sourceResume ? maximumSourcePricedCny : citableResume ? maximumCitablePricedCny : air ? maximumAirPricedCny : boundedRetry ? maximumResilientPricedCny : paid ? maximumPaidPricedCny : maximumPricedCny;
  const gatewayMaxAttempts = boundedRetry ? 2 : 1, timeoutMs = boundedRetry ? 50_000 : 90_000;
  if (mode === "prepare" || mode === "prepare-paid" || mode === "prepare-resilient" || mode === "prepare-air" || mode === "prepare-air-citable" || mode === "prepare-air-source") {
    const cipher = resolveCredentialKeyring(process.env); if (!cipher) throw Error("CREDENTIAL_VAULT_REQUIRED");
    const store = new ProviderGatewayRepository(prisma, cipher);
    const original = await prisma.providerRouteBinding.findUniqueOrThrow({ where: { workspaceId_routeSlot: { workspaceId: ctx.workspaceId, routeSlot: "PDF_VISUAL_STRUCTURE" } }, include: { connection: { include: { credentialVersions: { where: { status: "ACTIVE" }, orderBy: { credentialVersion: "desc" }, take: 1 } } } } });
    const credential = original.connection.credentialVersions[0];
    if (!credential || original.connection.providerKey !== "zhipu" || original.connection.status !== "ACTIVE") throw Error("ZHIPU_CREDENTIAL_REQUIRED");
    await store.setRoute(ctx, { routeSlot: "BOOK_CHUNK_ANALYSIS", connectionId: original.connectionId, modelId: textModel });
    for (const routeSlot of ["BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "PODCAST_SCRIPT"] as const) await store.setRoute(ctx, { routeSlot, connectionId: original.connectionId, modelId: routeSlot === "PODCAST_SCRIPT" ? podcastModel : textModel });
    let embedding = await prisma.providerConnection.findFirst({ where: { workspaceId: ctx.workspaceId, providerKey: "zhipu", protocol: "OPENAI_EMBEDDINGS", displayName: "Chapter I native embedding", status: "ACTIVE" } });
    if (!embedding) embedding = (await store.createConnectionWithCredential(ctx, { providerKey: "zhipu", protocol: "OPENAI_EMBEDDINGS", displayName: "Chapter I native embedding", endpoint: "https://open.bigmodel.cn/api/paas/v4/embeddings", secret: cipher.decrypt(credential, { workspaceId: ctx.workspaceId, connectionId: original.connectionId, credentialVersionId: credential.id, providerKey: "zhipu" }) })).connection;
    await store.setRoute(ctx, { routeSlot: "EMBEDDING", connectionId: embedding.id, modelId: "embedding-3", configuration: { embeddingDimensions: 1024 } });
    const hostVoiceProfileIds: Record<string, string> = {};
    for (const [i, hostId] of identity.hostIds.entries()) {
      const providerVoiceId = i === 0 ? "tongtong" : "xiaochen";
      let voice = await prisma.podcastVoiceProfile.findFirst({ where: { workspaceId: ctx.workspaceId, podcastProjectId: identity.projectId, provider: "zhipu", providerVoiceId, model: "glm-tts", speakingRate: 1, pitch: 0 } });
      if (!voice) voice = await createVoiceProfile(ctx, { podcastProjectId: identity.projectId, displayName: providerVoiceId, language: "zh-CN", provider: "zhipu", providerVoiceId, voiceVersion: "1", model: "glm-tts", speakingRate: 1, pitch: 0 });
      hostVoiceProfileIds[hostId] = voice.id;
    }
    let audioConfig = await prisma.podcastEpisodeAudioConfig.findFirst({ where: { episodeId: identity.episodeId }, orderBy: { version: "desc" } });
    if (!audioConfig) audioConfig = await createEpisodeAudioConfig(ctx, { episodeId: identity.episodeId, outputFormat: "wav", sampleRate: 24000, channels: 1, defaultPauseMs: 300, speakingRateMultiplier: 1 });
    const routePlan = await resolveBookProductExecution(ctx.workspaceId);
    await writeFile(configurationPath, JSON.stringify({ ...identity, hostVoiceProfileIds, audioConfigId: audioConfig.id, routePlan, podcastModel, limits, ...(air ? { airScriptLimits: sourceResume ? sourceAirScriptLimits : citableResume ? citableAirScriptLimits : airScriptLimits } : {}), maximumPricedCny: maximum, gatewayMaxAttempts, timeoutMs, qualityFailurePolicy: "STOP", expectedCnyRange: paid ? [0.15, 0.40] : [0.10, 0.20], humanAuditionAcceptance: "可以，沿用当前音色与语速", externalCalls: 0, approvedForPaidExecution: false, publicationAuthorized: false }, null, 2));
    console.log(JSON.stringify({ prepared: true, textModel, podcastModel, externalCalls: 0, maximumPricedCny: maximum })); return;
  }
  // No queued work, runtime or remote request is created before this guard.
  const budget = await createChapterBudget(outputRoot, process.env.CHAPTER_BUDGET_AUTHORIZATION);
  if (paidResume) await writeFile(join(outputRoot, sourceResume ? "chapter-execution.ninth-attempt.private.json" : citableResume ? "chapter-execution.eighth-attempt.private.json" : airResume ? "chapter-execution.seventh-attempt.private.json" : air ? "chapter-execution.sixth-attempt.private.json" : dataResume ? "chapter-execution.fifth-attempt.private.json" : jsonResume ? "chapter-execution.fourth-attempt.private.json" : boundedRetry ? "chapter-execution.third-attempt.private.json" : paidResumeLater ? "chapter-execution.second-attempt.private.json" : "chapter-execution.first-attempt.private.json"), await readFile(join(outputRoot, "chapter-execution.private.json")), { flag: "wx" });
  if (process.env.CHAPTER_BUDGET_AUTHORIZATION === "CHAPTER_I_RESUME_429_ONCE_SAME_0.50_CNY") await writeFile(join(root, "chapter-execution.first-attempt.private.json"), await readFile(join(root, "chapter-execution.private.json")), { flag: "wx" });
  const config = JSON.parse(await readFile(configurationPath, "utf8")) as { audioConfigId: string; hostVoiceProfileIds: Record<string, string> };
  const options = { adapterResolver: budget.adapterResolver, maxAttempts: gatewayMaxAttempts, timeoutMs };
  const book = createBookProductionGatewayRuntime(process.env, options), podcast = createPodcastProductionGatewayRuntime(process.env, options), audio = createPodcastAudioProductionGatewayRuntime(process.env, options);
  const storage = new S3CompatibleStorageProvider({ endpoint: process.env.S3_ENDPOINT!, region: process.env.S3_REGION!, bucket: process.env.S3_BUCKET!, accessKey: process.env.S3_ACCESS_KEY!, secretKey: process.env.S3_SECRET_KEY!, forcePathStyle: true });
  const evidence: Record<string, unknown> = { sourceDocumentId: identity.sourceDocumentId, extractionId: identity.extractionId, promptVersion: resolveBookAnalysisVersions().promptVersion, gatewayMaxAttempts, timeoutMs, qualityFailurePolicy: "STOP", publicationAuthorized: false };
  try {
    const execution = await resolveBookProductExecution(ctx.workspaceId);
    if (execution.provider !== "zhipu" || execution.model !== textModel) throw Error("CHAPTER_ROUTE_CHANGED");
    const requested = await requestBookAnalysisForUser(ctx, { sourceDocumentId: identity.sourceDocumentId, ...resolveBookAnalysisVersions(), provider: execution.provider, model: execution.model, routePlan: execution.routePlan, outboxTopic: "private.chapter.acceptance.book" });
    evidence.bookRunId = requested.run.id;
    const analyzed = await processBookAnalysisRun(requested.run.id, { analysisProviderForRun: book.createAnalysisProvider, embeddingGatewayForRun: book.createEmbeddingGatewayForRun }, requested.run.dispatchGeneration);
    evidence.bookStatus = analyzed.status;
    if (analyzed.status !== "SUCCEEDED") throw Error("CHAPTER_BOOK_NOT_SUCCEEDED");
    const generated = await requestPodcastGeneration(ctx, { episodeId: identity.episodeId, pipelineVersion: "phase9-web-v1", promptVersion: podcastPromptVersion, provider: "zhipu", model: podcastModel, outboxTopic: "private.chapter.acceptance.script" });
    evidence.podcastRunId = generated.run.id;
    const script = await processPodcastGenerationRun(generated.run.id, { providerForRun: podcast.createProviderForRun, embeddingProviderForRun: podcast.createEmbeddingProviderForRun, qualityFailurePolicy: "STOP" });
    evidence.podcastStatus = script.status;
    if (script.status !== "SUCCEEDED") throw Error("CHAPTER_SCRIPT_NOT_SUCCEEDED");
    const revision = await prisma.currentPodcastScript.findFirstOrThrow({ where: { episodeId: identity.episodeId, workspaceId: ctx.workspaceId }, include: { revision: true } });
    await writeFile(join(outputRoot, "chapter-script.private.json"), JSON.stringify(revision.revision, null, 2));
    const synthesized = await requestPodcastAudioGeneration(ctx, { episodeId: identity.episodeId, scriptRevisionId: revision.revision.id, audioConfigId: config.audioConfigId, provider: "zhipu", model: "glm-tts", pipelineVersion: "phase9-web-v1", speechPreparationVersion: "phase9-web-v1", assemblyVersion: "phase9-web-v1", normalizationVersion: "phase9-web-v1", hostVoiceProfileIds: config.hostVoiceProfileIds, outboxTopic: "private.chapter.acceptance.audio" });
    evidence.audioRunId = synthesized.run.id;
    const rendered = await processPodcastAudioGenerationRun(synthesized.run.id, { providerForRun: audio.createSpeechProviderForRun, storage });
    evidence.audioStatus = rendered.status;
    if (rendered.status !== "SUCCEEDED") throw Error("CHAPTER_AUDIO_NOT_SUCCEEDED");
    const artifact = await prisma.episodeAudioArtifact.findUniqueOrThrow({ where: { audioGenerationRunId_kind: { audioGenerationRunId: rendered.id, kind: "NORMALIZED" } } });
    const bytes = await storage.getObjectBytes(artifact.storageKey);
    if (hash(bytes) !== artifact.sha256) throw Error("CHAPTER_AUDIO_STORAGE_SHA_MISMATCH");
    await writeFile(join(outputRoot, "chapter-podcast.private.wav"), bytes);
    evidence.artifact = artifact;
  } catch (error) {
    evidence.errorCode = error instanceof Error && "code" in error ? String(error.code) : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "CHAPTER_EXECUTION_FAILED";
    await budget.stop(); throw error;
  } finally {
    await writeFile(join(outputRoot, "chapter-execution.private.json"), JSON.stringify(evidence, null, 2));
    await Promise.allSettled([book.close(), podcast.close(), audio.close()]); storage.close();
  }
}
main().catch(error => { console.error(error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "CHAPTER_EXECUTION_STOPPED_RECONCILIATION_REQUIRED"); process.exitCode = 1; }).finally(() => prisma.$disconnect());
