import { createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { evaluatePodcastScriptData, type EvaluationUtterance } from "./evaluation.js";

export const PODCAST_GENERATION_JOB = "podcast.generation";
export const PODCAST_GENERATION_TOPIC = "podcast.generation.requested";
export type TrustedRequestContext = { workspaceId: string; userId: string };
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
async function assertMembership(context: TrustedRequestContext) { if (!await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: context } })) throw new Error("WORKSPACE_ACCESS_DENIED"); }
const defaultHosts = [
  { ordinal: 1, displayName: "林川", role: "analytical explainer", speakingStyle: "model-building with layered explanations", knowledgeStyle: "conceptual synthesis", temperament: "calm and curious", skepticism: 4, humor: 3, verbosity: 7, questionStyle: "rhetorical framing", disagreementStyle: "clarifies definitions before disagreeing", preferredSentenceLength: "medium-long", fillerPreference: "rare reflective pauses" },
  { ordinal: 2, displayName: "阿简", role: "practical skeptic", speakingStyle: "short concrete challenges and reactions", knowledgeStyle: "tests ideas against real situations", temperament: "direct and warm", skepticism: 8, humor: 5, verbosity: 3, questionStyle: "pointed practical questions", disagreementStyle: "scope and practicality challenges", preferredSentenceLength: "short", fillerPreference: "occasional concise reactions" },
];

export async function createPodcastProject(context: TrustedRequestContext, input: { name: string; description?: string; sourceDocumentIds: string[] }) {
  await assertMembership(context);
  if (!input.sourceDocumentIds.length) throw new Error("PODCAST_PROJECT_SOURCE_REQUIRED");
  const documents = await prisma.sourceDocument.findMany({ where: { workspaceId: context.workspaceId, id: { in: input.sourceDocumentIds } } });
  if (documents.length !== new Set(input.sourceDocumentIds).size) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  return prisma.$transaction(async (tx) => {
    const project = await tx.podcastProject.create({ data: { workspaceId: context.workspaceId, name: input.name, description: input.description } });
    await tx.podcastProjectSource.createMany({ data: documents.map((document) => ({ podcastProjectId: project.id, workspaceId: context.workspaceId, sourceDocumentId: document.id })) });
    await tx.podcastStyleProfile.create({ data: { workspaceId: context.workspaceId, podcastProjectId: project.id, version: 1 } });
    await tx.podcastHost.createMany({ data: defaultHosts.map((host) => ({ ...host, workspaceId: context.workspaceId, podcastProjectId: project.id, configurationVersion: 1, personaVersion: 1 })) });
    return tx.podcastProject.findUniqueOrThrow({ where: { id: project.id }, include: { sources: true, styleProfiles: true, hosts: true } });
  });
}

export type StyleInput = Partial<{ language: string; tone: string; depth: number; pace: number; hostCount: number; targetDurationMinutes: number; targetAudience: string; formality: number; humorLevel: number; debateLevel: number; storytellingLevel: number; interruptionLevel: number; disagreementLevel: number; technicalDepth: number; summaryDensity: number; exampleDensity: number }>;
export async function configureStyle(context: TrustedRequestContext, podcastProjectId: string, input: StyleInput) {
  await assertMembership(context);
  const project = await prisma.podcastProject.findFirstOrThrow({ where: { id: podcastProjectId, workspaceId: context.workspaceId }, include: { styleProfiles: { orderBy: { version: "desc" }, take: 1 } } });
  const previous = project.styleProfiles[0];
  const base = previous ? { language: previous.language, tone: previous.tone, depth: previous.depth, pace: previous.pace, hostCount: previous.hostCount, targetDurationMinutes: previous.targetDurationMinutes, targetAudience: previous.targetAudience, formality: previous.formality, humorLevel: previous.humorLevel, debateLevel: previous.debateLevel, storytellingLevel: previous.storytellingLevel, interruptionLevel: previous.interruptionLevel, disagreementLevel: previous.disagreementLevel, technicalDepth: previous.technicalDepth, summaryDensity: previous.summaryDensity, exampleDensity: previous.exampleDensity } : {};
  return prisma.podcastStyleProfile.create({ data: { ...base, ...input, workspaceId: context.workspaceId, podcastProjectId, version: (previous?.version ?? 0) + 1 } });
}

export type HostInput = Omit<(typeof defaultHosts)[number], "ordinal"> & { ordinal: number; personaVersion?: number };
export async function configureHosts(context: TrustedRequestContext, podcastProjectId: string, hosts: HostInput[]) {
  await assertMembership(context);
  if (hosts.length < 2 || new Set(hosts.map((host) => host.ordinal)).size !== hosts.length) throw new Error("PODCAST_HOST_CONFIGURATION_INVALID");
  await prisma.podcastProject.findFirstOrThrow({ where: { id: podcastProjectId, workspaceId: context.workspaceId } });
  const latest = await prisma.podcastHost.aggregate({ where: { podcastProjectId, workspaceId: context.workspaceId }, _max: { configurationVersion: true } });
  const configurationVersion = (latest._max.configurationVersion ?? 0) + 1;
  await prisma.podcastHost.createMany({ data: hosts.map((host) => ({ ...host, workspaceId: context.workspaceId, podcastProjectId, configurationVersion, personaVersion: host.personaVersion ?? 1 })) });
  return prisma.podcastHost.findMany({ where: { podcastProjectId, workspaceId: context.workspaceId, configurationVersion }, orderBy: { ordinal: "asc" } });
}

export async function createEpisode(context: TrustedRequestContext, input: { podcastProjectId: string; title: string; description?: string; styleProfileId?: string; language?: string; targetDurationMinutes?: number }) {
  await assertMembership(context);
  const project = await prisma.podcastProject.findFirstOrThrow({ where: { id: input.podcastProjectId, workspaceId: context.workspaceId }, include: { styleProfiles: { orderBy: { version: "desc" }, take: 1 } } });
  const style = input.styleProfileId ? await prisma.podcastStyleProfile.findFirstOrThrow({ where: { id: input.styleProfileId, podcastProjectId: project.id, workspaceId: context.workspaceId } }) : project.styleProfiles[0];
  if (!style) throw new Error("PODCAST_STYLE_REQUIRED");
  return prisma.podcastEpisode.create({ data: { workspaceId: context.workspaceId, podcastProjectId: project.id, styleProfileId: style.id, title: input.title, description: input.description, language: input.language ?? style.language, targetDurationMinutes: input.targetDurationMinutes ?? style.targetDurationMinutes } });
}

export async function requestPodcastGeneration(context: TrustedRequestContext, input: { episodeId: string; pipelineVersion: string; promptVersion: string; provider: string; model: string; modelVersion?: string; correlationId?: string }) {
  await assertMembership(context);
  const episode = await prisma.podcastEpisode.findFirstOrThrow({ where: { id: input.episodeId, workspaceId: context.workspaceId }, include: { project: { include: { sources: true } }, styleProfile: true } });
  const latestHosts = await prisma.podcastHost.aggregate({ where: { podcastProjectId: episode.podcastProjectId, workspaceId: context.workspaceId }, _max: { configurationVersion: true } });
  const hostConfigurationVersion = latestHosts._max.configurationVersion;
  if (!hostConfigurationVersion) throw new Error("PODCAST_HOSTS_REQUIRED");
  const hosts = await prisma.podcastHost.findMany({ where: { podcastProjectId: episode.podcastProjectId, workspaceId: context.workspaceId, configurationVersion: hostConfigurationVersion }, orderBy: { ordinal: "asc" } });
  if (hosts.length !== episode.styleProfile.hostCount) throw new Error("PODCAST_HOST_COUNT_MISMATCH");
  const sourceIds = episode.project.sources.map((source) => source.sourceDocumentId).sort();
  const current = await prisma.currentBookIntelligence.findMany({ where: { workspaceId: context.workspaceId, sourceDocumentId: { in: sourceIds } } });
  if (current.length !== sourceIds.length) throw new Error("CURRENT_BOOK_INTELLIGENCE_REQUIRED");
  const sourceIdentity = current.map((item) => [item.sourceDocumentId, item.extractionId, item.chunkSetId, item.analysisRunId]).sort(([a], [b]) => String(a).localeCompare(String(b)));
  const hostConfigurationHash = sha256(stable(hosts.map((host) => ({ id: host.id, personaVersion: host.personaVersion, configurationVersion: host.configurationVersion, role: host.role, speakingStyle: host.speakingStyle, temperament: host.temperament, skepticism: host.skepticism, verbosity: host.verbosity, questionStyle: host.questionStyle, disagreementStyle: host.disagreementStyle }))));
  const modelVersionKey = input.modelVersion ?? "";
  const generationIdentityHash = sha256(stable([episode.id, sourceIdentity, episode.styleProfile.id, episode.styleProfile.version, hostConfigurationHash, input.pipelineVersion, input.promptVersion, input.provider, input.model, modelVersionKey]));
  const idempotencyKey = `podcast:${generationIdentityHash}`;
  const existing = await prisma.podcastGenerationRun.findUnique({ where: { episodeId_generationIdentityHash: { episodeId: episode.id, generationIdentityHash } }, include: { job: true } });
  if (existing) return { run: existing, job: existing.job };
  try {
    return await prisma.$transaction(async (tx) => {
      const job = await tx.job.create({ data: { workspaceId: context.workspaceId, userId: context.userId, type: PODCAST_GENERATION_JOB, payload: { episodeId: episode.id }, idempotencyKey, correlationId: input.correlationId } });
      const run = await tx.podcastGenerationRun.create({ data: { workspaceId: context.workspaceId, podcastProjectId: episode.podcastProjectId, episodeId: episode.id, styleProfileId: episode.styleProfileId, jobId: job.id, pipelineVersion: input.pipelineVersion, promptVersion: input.promptVersion, provider: input.provider, model: input.model, modelVersion: input.modelVersion, modelVersionKey, hostConfigurationHash, hostConfigurationVersion, generationIdentityHash, idempotencyKey, correlationId: input.correlationId } });
      await tx.podcastGenerationSource.createMany({ data: current.map((item) => ({ podcastGenerationRunId: run.id, workspaceId: context.workspaceId, episodeId: episode.id, sourceDocumentId: item.sourceDocumentId, extractionId: item.extractionId, chunkSetId: item.chunkSetId, analysisRunId: item.analysisRunId })) });
      await tx.outboxEvent.create({ data: { topic: PODCAST_GENERATION_TOPIC, aggregateId: run.id, payload: { podcastGenerationRunId: run.id } } });
      return { run, job };
    });
  } catch (error) {
    const run = await prisma.podcastGenerationRun.findUnique({ where: { episodeId_generationIdentityHash: { episodeId: episode.id, generationIdentityHash } }, include: { job: true } });
    if (!run) throw error;
    return { run, job: run.job };
  }
}

export async function getPodcastGenerationStatus(context: TrustedRequestContext, runId: string) { await assertMembership(context); return prisma.podcastGenerationRun.findFirstOrThrow({ where: { id: runId, workspaceId: context.workspaceId }, include: { job: true, segments: { orderBy: { ordinal: "asc" } } } }); }
export async function getEpisodeScript(context: TrustedRequestContext, episodeId: string) { await assertMembership(context); return prisma.currentPodcastScript.findFirstOrThrow({ where: { episodeId, workspaceId: context.workspaceId }, include: { revision: { include: { evaluations: { include: { result: true } } } } } }); }
export async function getScriptRevision(context: TrustedRequestContext, revisionId: string) { await assertMembership(context); return prisma.podcastScriptRevision.findFirstOrThrow({ where: { id: revisionId, workspaceId: context.workspaceId }, include: { evaluations: { include: { result: true } } } }); }
export async function evaluatePodcastScript(context: TrustedRequestContext, revisionId: string, evaluatorVersion = "phase3-deterministic-v1") {
  await assertMembership(context);
  const revision = await prisma.podcastScriptRevision.findFirstOrThrow({ where: { id: revisionId, workspaceId: context.workspaceId } });
  const snapshot = revision.scriptSnapshot as { utterances?: EvaluationUtterance[] };
  const evaluation = evaluatePodcastScriptData(snapshot.utterances ?? []);
  return prisma.$transaction(async (tx) => {
    const run = await tx.podcastEvaluationRun.upsert({ where: { revisionId_evaluatorVersion: { revisionId, evaluatorVersion } }, create: { workspaceId: context.workspaceId, episodeId: revision.episodeId, revisionId, evaluatorVersion, status: "SUCCEEDED", completedAt: new Date() }, update: { status: "SUCCEEDED", errorCode: null, completedAt: new Date() } });
    await tx.podcastEvaluationResult.upsert({ where: { evaluationRunId: run.id }, create: { evaluationRunId: run.id, ...evaluation }, update: evaluation });
    return tx.podcastEvaluationRun.findUniqueOrThrow({ where: { id: run.id }, include: { result: true } });
  });
}
