/** Explicit, separately approved editorial revision and speech-only acceptance. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prisma } from "../../packages/db/src/index.js";
import { createEditedPodcastScriptRevision, prepareSpokenText, requestPodcastAudioGeneration, processPodcastAudioGenerationRun } from "../../packages/podcast-generation/src/index.js";
import { createPodcastAudioProductionGatewayRuntime } from "../../apps/worker/src/provider-gateway-runtime.js";
import { S3CompatibleStorageProvider } from "../../packages/storage/src/index.js";
import { createEditorialSpeechBudget } from "./chapter-budget.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function runChapterEditorial(root: string) {
  const output = join(root, "paid-flashx-attempt-v1");
  const bytes = await readFile(join(output, "proposed-editorial-script.private.json"));
  if (sha(bytes) !== "199604959fa178f8e23130f0661ed19f90f08cc7570b874c4cae4049ddfffa82") throw Error("CHAPTER_EDITORIAL_PROPOSAL_CHANGED");
  const proposal = JSON.parse(bytes.toString("utf8")) as { parentRevisionId: string; episodeId: string; edits: Array<{ utteranceId: string; text: string; evidenceMemoryIds: string[] }> };
  const identity = JSON.parse(await readFile(join(root, "podcast-product-preparation.private.json"), "utf8")) as { workspaceId: string; userId: string; episodeId: string; sourceDocumentId: string; extractionId: string; hostIds: string[] };
  if (proposal.episodeId !== identity.episodeId || sha(await readFile(join(root, "pg1342-chapter-01.private.epub"))) !== "41fef531a3e6347cfcd0a6f3b15208173fbe9efbe6fb7952933227af16f8e776") throw Error("CHAPTER_EDITORIAL_SOURCE_CHANGED");
  await prisma.currentDocumentExtraction.findFirstOrThrow({ where: { workspaceId: identity.workspaceId, sourceDocumentId: identity.sourceDocumentId, extractionId: identity.extractionId } });
  const parent = await prisma.currentPodcastScript.findFirstOrThrow({ where: { episodeId: identity.episodeId, workspaceId: identity.workspaceId, revisionId: proposal.parentRevisionId }, include: { revision: true } });
  const snapshot = parent.revision.scriptSnapshot as { utterances: Array<{ id: string; speakerHostId: string }> };
  if (snapshot.utterances.length !== 5 || proposal.edits.some((edit, i) => edit.utteranceId !== snapshot.utterances[i]?.id || snapshot.utterances[i]?.speakerHostId !== identity.hostIds[i % 2])) throw Error("CHAPTER_EDITORIAL_SPEAKERS_CHANGED");
  const config = JSON.parse(await readFile(join(root, "chapter-air-source-configuration.private.json"), "utf8")) as { audioConfigId: string; hostVoiceProfileIds: Record<string, string> };
  for (const [i, hostId] of identity.hostIds.entries()) await prisma.podcastVoiceProfile.findFirstOrThrow({ where: { id: config.hostVoiceProfileIds[hostId], workspaceId: identity.workspaceId, provider: "zhipu", model: "glm-tts", providerVoiceId: i === 0 ? "tongtong" : "xiaochen", speakingRate: 1, pitch: 0 } });
  const turns = proposal.edits.map((edit, i) => ({ text: prepareSpokenText(edit.text).spokenText, voice: i % 2 === 0 ? "tongtong" : "xiaochen" }));
  // Exclusive authorization is opened before a revision, Job or runtime is created.
  const budget = await createEditorialSpeechBudget(output, process.env.CHAPTER_BUDGET_AUTHORIZATION, turns);
  const runtime = createPodcastAudioProductionGatewayRuntime(process.env, { adapterResolver: budget.adapterResolver, maxAttempts: 1, timeoutMs: 50000 });
  const storage = new S3CompatibleStorageProvider({ endpoint: process.env.S3_ENDPOINT!, region: process.env.S3_REGION!, bucket: process.env.S3_BUCKET!, accessKey: process.env.S3_ACCESS_KEY!, secretKey: process.env.S3_SECRET_KEY!, forcePathStyle: true });
  const evidence: Record<string, unknown> = { source: "USER_EDIT", parentRevisionId: parent.revisionId, sourceDocumentId: identity.sourceDocumentId, extractionId: identity.extractionId, textModelCalls: 0, embeddingCalls: 0, publicationAuthorized: false };
  try {
    const edited = await createEditedPodcastScriptRevision({ workspaceId: identity.workspaceId, userId: identity.userId }, { episodeId: identity.episodeId, expectedRevisionId: parent.revisionId, edits: proposal.edits });
    evidence.revisionId = edited.revision.id;
    await writeFile(join(output, "chapter-editorial-script.private.json"), JSON.stringify(edited.revision, null, 2), { flag: "wx" });
    const requested = await requestPodcastAudioGeneration({ workspaceId: identity.workspaceId, userId: identity.userId }, { episodeId: identity.episodeId, scriptRevisionId: edited.revision.id, audioConfigId: config.audioConfigId, provider: "zhipu", model: "glm-tts", pipelineVersion: "phase9-web-v1", speechPreparationVersion: "phase9-web-v1", assemblyVersion: "phase9-web-v1", normalizationVersion: "edge-trim-preserve-pauses-v2", hostVoiceProfileIds: config.hostVoiceProfileIds, outboxTopic: "private.chapter.editorial.audio" });
    evidence.audioRunId = requested.run.id;
    const rendered = await processPodcastAudioGenerationRun(requested.run.id, { providerForRun: runtime.createSpeechProviderForRun, storage });
    evidence.audioStatus = rendered.status;
    if (rendered.status !== "SUCCEEDED") throw Error("CHAPTER_EDITORIAL_AUDIO_NOT_SUCCEEDED");
    const artifact = await prisma.episodeAudioArtifact.findUniqueOrThrow({ where: { audioGenerationRunId_kind: { audioGenerationRunId: rendered.id, kind: "NORMALIZED" } } });
    const audio = await storage.getObjectBytes(artifact.storageKey);
    if (sha(audio) !== artifact.sha256) throw Error("CHAPTER_EDITORIAL_STORAGE_SHA_MISMATCH");
    await writeFile(join(output, "chapter-editorial-podcast.private.wav"), audio, { flag: "wx" });
    evidence.artifact = artifact;
  } catch (error) {
    evidence.errorCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "CHAPTER_EDITORIAL_EXECUTION_FAILED";
    throw error;
  } finally {
    await budget.stop();
    await writeFile(join(output, "chapter-editorial-execution.private.json"), JSON.stringify(evidence, null, 2));
    await runtime.close(); storage.close();
  }
}
