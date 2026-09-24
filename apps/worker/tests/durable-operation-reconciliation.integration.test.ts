import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { Prisma, prisma } from "@ai-cognitive/db";
import { createRedisConnection } from "@ai-cognitive/shared/server";
import {
  AUDIO_GENERATION_JOB,
  dispatchPendingPodcastAudioGeneration,
  openPodcastAudioPaidOutcomeQuarantine,
  type PodcastAudioDispatchPayload,
} from "@ai-cognitive/podcast-generation";
import {
  BOOK_ANALYSIS_JOB,
  dispatchPendingBookAnalysis,
} from "@ai-cognitive/book-intelligence";
import {
  PODCAST_GENERATION_JOB,
  dispatchPendingPodcastGeneration,
} from "@ai-cognitive/podcast-generation";
import {
  SHORT_VIDEO_GENERATION_JOB,
  dispatchPendingShortVideoGeneration,
} from "@ai-cognitive/short-video-generation";
import { admitWorkspaceExpensiveOperation, expensiveJobTypes } from "@ai-cognitive/db";
import { AUDIO_GENERATION_QUEUE } from "../src/audio-generation.js";
import { BOOK_ANALYSIS_QUEUE } from "../src/book-analysis.js";
import { PODCAST_GENERATION_QUEUE } from "../src/podcast-generation.js";
import { SHORT_VIDEO_GENERATION_QUEUE } from "../src/short-video-generation.js";
import { DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE, DURABLE_OPERATION_RECONCILIATION_INTERVAL_MS, scheduleDurableOperationReconciliation, reconcileDurableExpensiveOperationsBatch, reconcileDurableExpensiveOperationsSweep, type DurableOperationDomain, type ReconciliationCursor, type ReconciliationQueue, type ReconciliationHooks, type ReconciliationQueues, type ReconciliationSweepState, type ReconciliationTopics } from "../src/durable-operation-reconciliation.js";

type BookPayload = { analysisRunId: string; queueJobId?: string; dispatchGeneration: number };
type PodcastPayload = { podcastGenerationRunId: string; dispatchGeneration: number };
type VideoPayload = { shortVideoGenerationRunId: string; dispatchGeneration: number };

const suiteId = randomUUID();
const topicPrefix = `pr-a-reconciliation-${suiteId}`;
const workspaceIds = new Set<string>();
const podcastScaffolds = new Map<string, Promise<PodcastScaffold>>();
const bookScaffolds = new Map<string, Promise<BookScaffold>>();
const videoScaffolds = new Map<string, Promise<VideoScaffold>>();
let topicCounter = 0;
let priorOperationLimit: string | undefined;

type PodcastScaffold = { projectId: string; styleProfileId: string; episodeId: string; scriptRevisionId: string; audioConfigId: string };
type BookScaffold = { sourceDocumentId: string; extractionId: string; chunkSetId: string };
type VideoScaffold = { projectId: string; styleProfileId: string };
type AudioVoiceFixture = { hosts: Array<{ id: string; voiceProfileId: string; voiceIdentityHash: string }>; projectId: string; episodeId: string };
type SeededOperation = {
  domain: DurableOperationDomain;
  workspaceId: string;
  jobId: string;
  runId: string;
  topic: string;
  generation: number;
};

const queuePrefix = `pr-a-${suiteId}`;
let bookQueue!: Queue<BookPayload>;
let podcastQueue!: Queue<PodcastPayload>;
let videoQueue!: Queue<VideoPayload>;
let audioQueue!: Queue<PodcastAudioDispatchPayload>;

function queueAdapter<Data extends object>(queue: Queue<Data>): ReconciliationQueue {
  return {
    getJob: async id => {
      const job = await queue.getJob(id);
      return job ? { id: job.id ?? "", data: job.data, getState: () => job.getState() } : null;
    },
  };
}

function reconciliationQueues(): ReconciliationQueues {
  return {
    BOOK_ANALYSIS: queueAdapter(bookQueue),
    PODCAST_GENERATION: queueAdapter(podcastQueue),
    SHORT_VIDEO_GENERATION: queueAdapter(videoQueue),
    PODCAST_AUDIO_GENERATION: queueAdapter(audioQueue),
  };
}

function payloadFor(seed: SeededOperation, generation = seed.generation): Prisma.InputJsonObject {
  switch (seed.domain) {
    case "BOOK_ANALYSIS": return { analysisRunId: seed.runId, queueJobId: seed.jobId, dispatchGeneration: generation };
    case "PODCAST_GENERATION": return { podcastGenerationRunId: seed.runId, dispatchGeneration: generation };
    case "SHORT_VIDEO_GENERATION": return { shortVideoGenerationRunId: seed.runId, dispatchGeneration: generation };
    case "PODCAST_AUDIO_GENERATION": return { audioGenerationRunId: seed.runId, dispatchGeneration: generation };
  }
}

function queueJobId(seed: SeededOperation, generation = seed.generation): string {
  if (seed.domain === "BOOK_ANALYSIS") return generation === 0 ? seed.jobId : `${seed.jobId}-g${generation}`;
  if (seed.domain === "PODCAST_AUDIO_GENERATION") return generation === 0 ? seed.runId : `podcast-audio-${seed.runId}-g${generation}`;
  return generation === 0 ? seed.runId : `${seed.runId}-g${generation}`;
}

async function workspaceId(): Promise<string> {
  const workspace = await prisma.workspace.create({ data: { name: `${topicPrefix}-workspace-${randomUUID()}` } });
  workspaceIds.add(workspace.id);
  return workspace.id;
}

async function seedOrphanJob(order: number): Promise<string> {
  const workspace = await workspaceId();
  const job = await prisma.job.create({ data: { workspaceId: workspace, type: BOOK_ANALYSIS_JOB, payload: {}, status: "QUEUED", idempotencyKey: `${topicPrefix}-orphan-${randomUUID()}` } });
  await prisma.job.update({ where: { id: job.id }, data: { createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, order)) } });
  return job.id;
}

async function audioVoiceFixture(workspace: string, scaffold: PodcastScaffold): Promise<AudioVoiceFixture> {
  const hosts: AudioVoiceFixture["hosts"] = [];
  for (const [ordinal, name] of ["A", "B"].entries()) {
    const host = await prisma.podcastHost.create({ data: {
      workspaceId: workspace, podcastProjectId: scaffold.projectId, ordinal,
      displayName: `PR-A host ${name}`, role: "host", speakingStyle: "clear", knowledgeStyle: "generalist",
      temperament: "curious", questionStyle: "direct", disagreementStyle: "respectful",
      preferredSentenceLength: "medium", fillerPreference: "none",
    } });
    const voiceProfile = await prisma.podcastVoiceProfile.create({ data: {
      workspaceId: workspace, podcastProjectId: scaffold.projectId, displayName: `PR-A voice ${name}`,
      language: "en", provider: "fixture-tts", providerVoiceId: `pr-a-${workspace}-${name}`,
      voiceVersion: "1", model: "fixture-model", modelVersion: "1",
    } });
    hosts.push({ id: host.id, voiceProfileId: voiceProfile.id, voiceIdentityHash: `voice-hash-${name}` });
  }
  return { hosts, projectId: scaffold.projectId, episodeId: scaffold.episodeId };
}

async function attachAudioVoiceMapping(seed: SeededOperation, fixture: AudioVoiceFixture, swapped = false): Promise<void> {
  const [a, b] = fixture.hosts;
  if (!a || !b) throw new Error("PR_A_AUDIO_VOICE_FIXTURE_INCOMPLETE");
  const assignments = swapped ? [{ host: a, voice: b }, { host: b, voice: a }] : [{ host: a, voice: a }, { host: b, voice: b }];
  await prisma.audioGenerationHostVoice.createMany({ data: assignments.map(({ host, voice }) => ({
    audioGenerationRunId: seed.runId, workspaceId: seed.workspaceId, podcastProjectId: fixture.projectId,
    episodeId: fixture.episodeId, hostId: host.id, voiceProfileId: voice.voiceProfileId,
    voiceIdentityHash: voice.voiceIdentityHash,
  })) });
}

async function podcastScaffold(workspace: string): Promise<PodcastScaffold> {
  let pending = podcastScaffolds.get(workspace);
  if (!pending) {
    pending = (async () => {
      const project = await prisma.podcastProject.create({ data: { workspaceId: workspace, name: `PR-A ${workspace}` } });
      const style = await prisma.podcastStyleProfile.create({ data: { workspaceId: workspace, podcastProjectId: project.id, version: 1 } });
      const episode = await prisma.podcastEpisode.create({ data: { workspaceId: workspace, podcastProjectId: project.id, styleProfileId: style.id, title: "PR-A reconciliation fixture", language: "en", targetDurationMinutes: 1 } });
      const revision = await prisma.podcastScriptRevision.create({ data: { workspaceId: workspace, episodeId: episode.id, revisionNumber: 1, source: "USER_EDIT", status: "FINAL", scriptSnapshot: { segments: [] }, estimatedDurationSeconds: 1 } });
      const audioConfig = await prisma.podcastEpisodeAudioConfig.create({ data: { workspaceId: workspace, podcastProjectId: project.id, episodeId: episode.id, version: 1 } });
      return { projectId: project.id, styleProfileId: style.id, episodeId: episode.id, scriptRevisionId: revision.id, audioConfigId: audioConfig.id };
    })();
    podcastScaffolds.set(workspace, pending);
  }
  return pending;
}

async function bookScaffold(workspace: string): Promise<BookScaffold> {
  let pending = bookScaffolds.get(workspace);
  if (!pending) {
    pending = (async () => {
      const suffix = randomUUID();
      const source = await prisma.source.create({ data: { workspaceId: workspace, kind: "FILE", displayName: "pr-a-fixture.md" } });
      const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace, sha256: suffix, sizeBytes: 1n, mediaType: "text/markdown", storageKey: `pr-a/${suffix}` } });
      const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace, version: 1, sha256: suffix, sizeBytes: 1n, mediaType: "text/markdown", storageKey: blob.storageKey } });
      const ingestionJob = await prisma.job.create({ data: { workspaceId: workspace, type: "source.ingest", payload: {}, idempotencyKey: `pr-a-ingest-${suffix}` } });
      const ingestion = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace, jobId: ingestionJob.id, parserVersion: "test", normalizationVersion: "test", status: "SUCCEEDED", completedAt: new Date() } });
      const extraction = await prisma.documentExtraction.create({ data: { ingestionRunId: ingestion.id, sourceDocumentId: document.id, workspaceId: workspace, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } });
      await prisma.currentDocumentExtraction.create({ data: { sourceDocumentId: document.id, extractionId: extraction.id, workspaceId: workspace } });
      const chunks = await prisma.chunkSet.create({ data: { workspaceId: workspace, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "pr-a-test", configuration: {}, configurationHash: suffix, status: "SUCCEEDED", completedAt: new Date() } });
      return { sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunks.id };
    })();
    bookScaffolds.set(workspace, pending);
  }
  return pending;
}

async function videoScaffold(workspace: string): Promise<VideoScaffold> {
  let pending = videoScaffolds.get(workspace);
  if (!pending) {
    pending = (async () => {
      const project = await prisma.shortVideoProject.create({ data: { workspaceId: workspace, name: `PR-A ${workspace}` } });
      const style = await prisma.shortVideoStyleProfile.create({ data: { workspaceId: workspace, shortVideoProjectId: project.id, version: 1 } });
      return { projectId: project.id, styleProfileId: style.id };
    })();
    videoScaffolds.set(workspace, pending);
  }
  return pending;
}

async function seedOperation(domain: DurableOperationDomain, input: { workspaceId?: string; generation?: number } = {}): Promise<SeededOperation> {
  const workspace = input.workspaceId ?? await workspaceId();
  const generation = input.generation ?? 0;
  const topic = `${topicPrefix}-${++topicCounter}`;
  const job = await prisma.job.create({ data: { workspaceId: workspace, type: jobType(domain), payload: {}, idempotencyKey: `${topic}-job` } });
  let runId: string;
  switch (domain) {
    case "BOOK_ANALYSIS": {
      const scaffold = await bookScaffold(workspace);
      const run = await prisma.bookAnalysisRun.create({ data: { workspaceId: workspace, sourceDocumentId: scaffold.sourceDocumentId, extractionId: scaffold.extractionId, chunkSetId: scaffold.chunkSetId, jobId: job.id, pipelineVersion: "pr-a-test", promptVersion: "pr-a-test", provider: "no-provider", model: "no-provider", modelVersionKey: "", idempotencyKey: `${topic}-run`, analysisIdentityHash: randomUUID(), dispatchGeneration: generation } });
      runId = run.id;
      break;
    }
    case "PODCAST_GENERATION": {
      const scaffold = await podcastScaffold(workspace);
      const run = await prisma.podcastGenerationRun.create({ data: { workspaceId: workspace, podcastProjectId: scaffold.projectId, episodeId: scaffold.episodeId, styleProfileId: scaffold.styleProfileId, jobId: job.id, pipelineVersion: "pr-a-test", promptVersion: "pr-a-test", provider: "no-provider", model: "no-provider", modelVersionKey: "", hostConfigurationHash: randomUUID(), hostConfigurationVersion: 1, generationIdentityHash: randomUUID(), idempotencyKey: `${topic}-run`, dispatchGeneration: generation } });
      runId = run.id;
      break;
    }
    case "SHORT_VIDEO_GENERATION": {
      const scaffold = await videoScaffold(workspace);
      const run = await prisma.shortVideoGenerationRun.create({ data: { workspaceId: workspace, shortVideoProjectId: scaffold.projectId, styleProfileId: scaffold.styleProfileId, jobId: job.id, provider: "no-provider", model: "no-provider", promptVersion: "pr-a-test", pipelineVersion: "pr-a-test", retrievalVersion: "pr-a-test", scenePlannerVersion: "pr-a-test", captionVersion: "pr-a-test", audioVersion: "pr-a-test", renderVersion: "pr-a-test", generationIdentityHash: randomUUID(), idempotencyKey: `${topic}-run`, dispatchGeneration: generation } });
      runId = run.id;
      break;
    }
    case "PODCAST_AUDIO_GENERATION": {
      const scaffold = await podcastScaffold(workspace);
      const run = await prisma.audioGenerationRun.create({ data: { workspaceId: workspace, podcastProjectId: scaffold.projectId, episodeId: scaffold.episodeId, scriptRevisionId: scaffold.scriptRevisionId, audioConfigId: scaffold.audioConfigId, jobId: job.id, provider: "no-provider", model: "no-provider", pipelineVersion: "pr-a-test", speechPreparationVersion: "pr-a-test", assemblyVersion: "pr-a-test", normalizationVersion: "pr-a-test", outputFormat: "wav", generationIdentityHash: randomUUID(), idempotencyKey: `${topic}-run`, dispatchGeneration: generation } });
      runId = run.id;
      break;
    }
  }
  const seed = { domain, workspaceId: workspace, jobId: job.id, runId, topic, generation };
  await prisma.outboxEvent.create({ data: { topic, aggregateId: runId, payload: payloadFor(seed) } });
  return seed;
}

function jobType(domain: DurableOperationDomain): string {
  switch (domain) {
    case "BOOK_ANALYSIS": return BOOK_ANALYSIS_JOB;
    case "PODCAST_GENERATION": return PODCAST_GENERATION_JOB;
    case "SHORT_VIDEO_GENERATION": return SHORT_VIDEO_GENERATION_JOB;
    case "PODCAST_AUDIO_GENERATION": return AUDIO_GENERATION_JOB;
  }
}

async function setState(seed: SeededOperation, runStatus: string, jobStatus: string, lease: "NONE" | "EXPIRED" | "LIVE" = "NONE"): Promise<void> {
  const runLease = lease === "NONE" ? { executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null } : {
    executionClaimToken: `pr-a-owner-${seed.runId}`,
    executionClaimedAt: new Date(Date.now() - 120_000),
    executionLeaseUntil: new Date(Date.now() + (lease === "LIVE" ? 300_000 : -60_000)),
  };
  const completedAt = runStatus === "SUCCEEDED" || runStatus === "FAILED" ? new Date() : null;
  const common = { status: runStatus as never, ...runLease, completedAt, errorCode: runStatus === "FAILED" ? "PR_A_TEST_FAILURE" : null };
  switch (seed.domain) {
    case "BOOK_ANALYSIS": await prisma.bookAnalysisRun.update({ where: { id: seed.runId }, data: common }); break;
    case "PODCAST_GENERATION": await prisma.podcastGenerationRun.update({ where: { id: seed.runId }, data: common }); break;
    case "SHORT_VIDEO_GENERATION": await prisma.shortVideoGenerationRun.update({ where: { id: seed.runId }, data: common }); break;
    case "PODCAST_AUDIO_GENERATION": await prisma.audioGenerationRun.update({ where: { id: seed.runId }, data: common }); break;
  }
  await prisma.job.update({ where: { id: seed.jobId }, data: { status: jobStatus as never, queueJobId: null, completedAt: jobStatus === "SUCCEEDED" || jobStatus === "FAILED" ? new Date() : null, ...(jobStatus === "FAILED" ? { error: { code: "PR_A_TEST_FAILURE" } } : {}) } });
}

async function markDispatched(seed: SeededOperation, generation = seed.generation): Promise<void> {
  await prisma.outboxEvent.updateMany({ where: { aggregateId: seed.runId, topic: seed.topic }, data: { status: "DISPATCHED", dispatchedAt: new Date() } });
  await prisma.job.update({ where: { id: seed.jobId }, data: { queueJobId: queueJobId(seed, generation) } });
}

async function dispatchOutbox(seed: SeededOperation): Promise<void> {
  const options = { topic: seed.topic, aggregateIds: [seed.runId] };
  switch (seed.domain) {
    case "BOOK_ANALYSIS": await dispatchPendingBookAnalysis(bookQueue, options); break;
    case "PODCAST_GENERATION": await dispatchPendingPodcastGeneration(podcastQueue, options); break;
    case "SHORT_VIDEO_GENERATION": await dispatchPendingShortVideoGeneration(videoQueue, options); break;
    case "PODCAST_AUDIO_GENERATION": await dispatchPendingPodcastAudioGeneration(audioQueue, options); break;
  }
}

async function reconcile(seeds: SeededOperation[], hooks?: ReconciliationHooks, cursor?: ReconciliationCursor | null, batchSize?: number) {
  const topics = seeds.reduce<ReconciliationTopics>((current, seed) => ({ ...current, [seed.domain]: seed.topic }), {});
  return reconcileDurableExpensiveOperationsBatch({ queues: reconciliationQueues(), topics, hooks, cursor, batchSize, candidateJobIds: seeds.map(seed => seed.jobId) });
}

async function createAudioQuarantine(seed: SeededOperation): Promise<void> {
  const suffix = randomUUID();
  const snapshot = await prisma.providerExecutionSnapshot.create({ data: { workspaceId: seed.workspaceId, routeSlot: "PODCAST_TTS", providerKey: "fixture", protocol: "https-json", modelId: "fixture", capability: {}, configurationHash: suffix, adapterVersion: "pr-a-test", correlationId: suffix } });
  const invocation = await prisma.providerInvocation.create({ data: { workspaceId: seed.workspaceId, snapshotId: snapshot.id, providerKey: "fixture", protocol: "https-json", modelId: "fixture", routeSlot: "PODCAST_TTS", idempotencyKey: `podcast-tts:${seed.runId}:fixture`, requestFingerprint: suffix, correlationId: suffix, status: "RECONCILIATION_REQUIRED" } });
  const attempt = await prisma.providerInvocationAttempt.create({ data: { workspaceId: seed.workspaceId, invocationId: invocation.id, attemptNumber: 1, status: "REMOTE_OUTCOME_UNKNOWN" } });
  await openPodcastAudioPaidOutcomeQuarantine({ workspaceId: seed.workspaceId, audioGenerationRunId: seed.runId, providerInvocationId: invocation.id, providerInvocationAttemptId: attempt.id });
}

async function runFor(seed: SeededOperation): Promise<{ status: string; generation: number; executionClaimToken: string | null }> {
  switch (seed.domain) {
    case "BOOK_ANALYSIS": { const row = await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id: seed.runId }, select: { status: true, dispatchGeneration: true, executionClaimToken: true } }); return { status: row.status, generation: row.dispatchGeneration, executionClaimToken: row.executionClaimToken }; }
    case "PODCAST_GENERATION": { const row = await prisma.podcastGenerationRun.findUniqueOrThrow({ where: { id: seed.runId }, select: { status: true, dispatchGeneration: true, executionClaimToken: true } }); return { status: row.status, generation: row.dispatchGeneration, executionClaimToken: row.executionClaimToken }; }
    case "SHORT_VIDEO_GENERATION": { const row = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: seed.runId }, select: { status: true, dispatchGeneration: true, executionClaimToken: true } }); return { status: row.status, generation: row.dispatchGeneration, executionClaimToken: row.executionClaimToken }; }
    case "PODCAST_AUDIO_GENERATION": { const row = await prisma.audioGenerationRun.findUniqueOrThrow({ where: { id: seed.runId }, select: { status: true, dispatchGeneration: true, executionClaimToken: true } }); return { status: row.status, generation: row.dispatchGeneration, executionClaimToken: row.executionClaimToken }; }
  }
}

async function cleanupFixtures(): Promise<void> {
  const ids = [...workspaceIds];
  if (!ids.length) return;
  await prisma.outboxEvent.deleteMany({ where: { topic: { startsWith: topicPrefix } } });
  await prisma.podcastAudioPaidOutcomeQuarantine.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.providerInvocation.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.bookAnalysisRun.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.podcastGenerationRun.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.audioGenerationRun.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.shortVideoGenerationRun.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.chunkSet.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.job.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.source.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
  workspaceIds.clear();
  podcastScaffolds.clear();
  bookScaffolds.clear();
  videoScaffolds.clear();
}

describe("STABILITY PR-A durable operation reconciliation", () => {
  beforeAll(async () => {
    priorOperationLimit = process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT;
    process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT = "2";
    const connection = () => createRedisConnection(process.env.REDIS_URL!);
    bookQueue = new Queue<BookPayload>(BOOK_ANALYSIS_QUEUE, { connection: connection(), prefix: queuePrefix });
    podcastQueue = new Queue<PodcastPayload>(PODCAST_GENERATION_QUEUE, { connection: connection(), prefix: queuePrefix });
    videoQueue = new Queue<VideoPayload>(SHORT_VIDEO_GENERATION_QUEUE, { connection: connection(), prefix: queuePrefix });
    audioQueue = new Queue<PodcastAudioDispatchPayload>(AUDIO_GENERATION_QUEUE, { connection: connection(), prefix: queuePrefix });
    await Promise.all([bookQueue.waitUntilReady(), podcastQueue.waitUntilReady(), videoQueue.waitUntilReady(), audioQueue.waitUntilReady()]);
  });

  afterEach(async () => {
    await Promise.all([bookQueue.obliterate({ force: true }), podcastQueue.obliterate({ force: true }), videoQueue.obliterate({ force: true }), audioQueue.obliterate({ force: true })]);
    await cleanupFixtures();
  });

  afterAll(async () => {
    await Promise.all([bookQueue.close(), podcastQueue.close(), videoQueue.close(), audioQueue.close()]);
    if (priorOperationLimit === undefined) delete process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT;
    else process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT = priorOperationLimit;
  });

  it.each([
    ["PR-A-01", "BOOK_ANALYSIS"],
    ["PR-A-02", "PODCAST_GENERATION"],
    ["PR-A-03", "SHORT_VIDEO_GENERATION"],
    ["PR-A-04", "PODCAST_AUDIO_GENERATION"],
  ] as const)("%s converges a successful %s ghost without replay", async (_caseId, domain) => {
    const seed = await seedOperation(domain);
    await setState(seed, "SUCCEEDED", "RUNNING", "EXPIRED");
    await markDispatched(seed);
    if (domain === "PODCAST_AUDIO_GENERATION") await createAudioQuarantine(seed);
    const invocationCount = await prisma.providerInvocation.count({ where: { workspaceId: seed.workspaceId } });
    const result = await reconcile([seed]);
    expect(result.decisions[0]?.decision).toBe("CONVERGED_TERMINAL");
    expect(await prisma.job.findUniqueOrThrow({ where: { id: seed.jobId }, select: { status: true, queueJobId: true } })).toEqual({ status: "SUCCEEDED", queueJobId: queueJobId(seed) });
    expect(await runFor(seed)).toMatchObject({ status: "SUCCEEDED", generation: 0, executionClaimToken: null });
    expect(await prisma.job.count({ where: { workspaceId: seed.workspaceId, type: { in: [...expensiveJobTypes] }, status: { in: ["QUEUED", "RUNNING"] } } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: seed.runId } })).toBe(1);
    expect(await prisma.providerInvocation.count({ where: { workspaceId: seed.workspaceId } })).toBe(invocationCount);
  });

  it.each(["BOOK_ANALYSIS", "PODCAST_AUDIO_GENERATION"] as const)("PR-A-05 converges %s FAILED as terminal with no automatic retry", async domain => {
    const seed = await seedOperation(domain);
    await setState(seed, "FAILED", "RUNNING", "EXPIRED");
    await markDispatched(seed);
    const result = await reconcile([seed]);
    expect(result.decisions[0]?.decision).toBe("CONVERGED_TERMINAL");
    expect(await runFor(seed)).toMatchObject({ status: "FAILED", generation: 0, executionClaimToken: null });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: seed.jobId }, select: { status: true } })).toEqual({ status: "FAILED" });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: seed.runId } })).toBe(1);
  });

  it("PR-A-06 leaves a healthy current lease owner untouched", async () => {
    const seed = await seedOperation("PODCAST_GENERATION");
    await setState(seed, "RUNNING", "RUNNING", "LIVE");
    await markDispatched(seed);
    const before = await runFor(seed);
    const result = await reconcile([seed]);
    expect(result.decisions[0]?.decision).toBe("NOOP_ACTIVE_OWNER");
    expect(await runFor(seed)).toEqual(before);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: seed.runId } })).toBe(1);
  });

  it.each([
    "BOOK_ANALYSIS",
    "PODCAST_GENERATION",
    "SHORT_VIDEO_GENERATION",
    "PODCAST_AUDIO_GENERATION",
  ] as const)("PR-A-07 safely rearms only the current %s generation and dispatches it through BullMQ", async domain => {
    const seed = await seedOperation(domain);
    await setState(seed, "QUEUED", "QUEUED");
    await markDispatched(seed);
    expect(await reconciliationQueues()[seed.domain]!.getJob(queueJobId(seed))).toBeNull();
    const result = await reconcile([seed]);
    expect(result.decisions[0]?.decision).toBe("RECOVERED_TRANSPORT");
    expect(await runFor(seed)).toMatchObject({ status: "QUEUED", generation: 1 });
    const events = await prisma.outboxEvent.findMany({ where: { aggregateId: seed.runId }, orderBy: { createdAt: "asc" } });
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toEqual(payloadFor(seed, 1));
    expect(events[1]?.status).toBe("PENDING");
    await dispatchOutbox({ ...seed, generation: 1 });
    const queueJob = await reconciliationQueues()[seed.domain]!.getJob(queueJobId(seed, 1));
    expect(queueJob).toMatchObject({ id: queueJobId(seed, 1), data: payloadFor(seed, 1) });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: seed.jobId }, select: { queueJobId: true } })).toEqual({ queueJobId: queueJobId(seed, 1) });
  });

  it("does not infer business ownership from a present current-generation BullMQ job", async () => {
    const seed = await seedOperation("PODCAST_GENERATION");
    await setState(seed, "QUEUED", "QUEUED");
    await markDispatched(seed);
    await podcastQueue.add(PODCAST_GENERATION_JOB, payloadFor(seed) as PodcastPayload, { jobId: queueJobId(seed) });
    const beforeRun = await runFor(seed);
    const result = await reconcile([seed]);
    expect(result.decisions[0]?.decision).toBe("NOOP_QUEUE_PRESENT");
    expect(await runFor(seed)).toEqual(beforeRun);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: seed.jobId }, select: { status: true } })).toEqual({ status: "QUEUED" });
    expect(await prisma.providerInvocation.count({ where: { workspaceId: seed.workspaceId } })).toBe(0);
  });

  it("PR-A-08 never resurrects a stale generation still present in BullMQ", async () => {
    const seed = await seedOperation("PODCAST_GENERATION", { generation: 1 });
    await setState(seed, "QUEUED", "QUEUED");
    await markDispatched(seed, 0);
    await prisma.outboxEvent.updateMany({ where: { aggregateId: seed.runId, topic: seed.topic }, data: { payload: payloadFor(seed, 0) } });
    await podcastQueue.add(PODCAST_GENERATION_JOB, payloadFor(seed, 0) as PodcastPayload, { jobId: queueJobId(seed, 0) });
    const beforeCount = await prisma.outboxEvent.count({ where: { aggregateId: seed.runId } });
    const result = await reconcile([seed]);
    expect(result.decisions[0]?.decision).toBe("STALE_GENERATION_IGNORED");
    expect(await runFor(seed)).toMatchObject({ status: "QUEUED", generation: 1 });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: seed.runId } })).toBe(beforeCount);
    expect(await podcastQueue.getJob(queueJobId(seed, 0))).toBeDefined();
  });

  it("PR-A-09 lets a success committed after transport inspection win", async () => {
    const seed = await seedOperation("BOOK_ANALYSIS");
    await setState(seed, "QUEUED", "QUEUED");
    await markDispatched(seed);
    const result = await reconcile([seed], {
      afterTransportInspected: async () => setState(seed, "SUCCEEDED", "SUCCEEDED"),
    });
    expect(result.decisions[0]?.decision).toBe("NOOP_ALREADY_CONVERGED");
    expect(await runFor(seed)).toMatchObject({ status: "SUCCEEDED", generation: 0 });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: seed.runId } })).toBe(1);
  });

  it("PR-A-10 lets a new valid owner acquired after inspection win", async () => {
    const seed = await seedOperation("PODCAST_GENERATION");
    await setState(seed, "RUNNING", "RUNNING", "EXPIRED");
    await markDispatched(seed);
    const result = await reconcile([seed], {
      afterTransportInspected: async () => setState(seed, "RUNNING", "RUNNING", "LIVE"),
    });
    expect(result.decisions[0]?.decision).toBe("NOOP_ACTIVE_OWNER");
    expect(await runFor(seed)).toMatchObject({ status: "RUNNING", generation: 0, executionClaimToken: `pr-a-owner-${seed.runId}` });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: seed.runId } })).toBe(1);
  });

  it("PR-A-11 serializes two reconcilers so exactly one generation is rearmed", async () => {
    const seed = await seedOperation("SHORT_VIDEO_GENERATION");
    await setState(seed, "QUEUED", "QUEUED");
    await markDispatched(seed);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const hook = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    };
    const [left, right] = await Promise.all([reconcile([seed], { afterTransportInspected: hook }), reconcile([seed], { afterTransportInspected: hook })]);
    expect([left, right].flatMap(batch => batch.decisions).filter(item => item.decision === "RECOVERED_TRANSPORT")).toHaveLength(1);
    expect(await runFor(seed)).toMatchObject({ status: "QUEUED", generation: 1 });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: seed.runId } })).toBe(2);
  });

  it("PR-A-12 makes concurrent terminal convergence idempotent", async () => {
    const seed = await seedOperation("PODCAST_AUDIO_GENERATION");
    await setState(seed, "FAILED", "RUNNING", "EXPIRED");
    await markDispatched(seed);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const hook = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    };
    const [left, right] = await Promise.all([reconcile([seed], { afterCandidateDiscovered: hook }), reconcile([seed], { afterCandidateDiscovered: hook })]);
    expect([left, right].flatMap(batch => batch.decisions).filter(item => item.decision === "CONVERGED_TERMINAL")).toHaveLength(1);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: seed.jobId }, select: { status: true } })).toEqual({ status: "FAILED" });
    expect(await prisma.job.count({ where: { workspaceId: seed.workspaceId, type: { in: [...expensiveJobTypes] }, status: { in: ["QUEUED", "RUNNING"] } } })).toBe(0);
  });

  it("PR-A-13 releases both ghost slots before allowing new workspace admission", async () => {
    const workspace = await workspaceId();
    const first = await seedOperation("BOOK_ANALYSIS", { workspaceId: workspace });
    const second = await seedOperation("PODCAST_GENERATION", { workspaceId: workspace });
    await setState(first, "SUCCEEDED", "RUNNING", "EXPIRED");
    await setState(second, "FAILED", "RUNNING", "EXPIRED");
    expect(await prisma.job.count({ where: { workspaceId: workspace, type: { in: [...expensiveJobTypes] }, status: { in: ["QUEUED", "RUNNING"] } } })).toBe(2);
    await expect(prisma.$transaction(tx => admitWorkspaceExpensiveOperation(tx, workspace, 2))).rejects.toThrow("WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED");
    const result = await reconcile([first, second]);
    expect(result.converged).toBe(2);
    expect(await prisma.job.count({ where: { workspaceId: workspace, type: { in: [...expensiveJobTypes] }, status: { in: ["QUEUED", "RUNNING"] } } })).toBe(0);
    await expect(prisma.$transaction(async tx => {
      await admitWorkspaceExpensiveOperation(tx, workspace, 2);
      return tx.job.create({ data: { workspaceId: workspace, type: "book.analysis", payload: {}, idempotencyKey: `${topicPrefix}-admitted-${randomUUID()}` } });
    })).resolves.toMatchObject({ workspaceId: workspace, status: "QUEUED" });
  });

  it("PR-A-14 keeps capacity at or below two during concurrent reconciliation and admission", async () => {
    const workspace = await workspaceId();
    const ghost = await seedOperation("SHORT_VIDEO_GENERATION", { workspaceId: workspace });
    await setState(ghost, "SUCCEEDED", "RUNNING", "EXPIRED");
    const other = await prisma.job.create({ data: { workspaceId: workspace, type: "book.analysis", payload: {}, idempotencyKey: `${topicPrefix}-other-${randomUUID()}` } });
    void other;
    let observing = true;
    let maxObserved = 0;
    const observe = (async () => {
      while (observing) {
        const count = await prisma.job.count({ where: { workspaceId: workspace, type: { in: [...expensiveJobTypes] }, status: { in: ["QUEUED", "RUNNING"] } } });
        maxObserved = Math.max(maxObserved, count);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    })();
    const admission = prisma.$transaction(async tx => {
      await admitWorkspaceExpensiveOperation(tx, workspace, 2);
      return tx.job.create({ data: { workspaceId: workspace, type: "podcast.generation", payload: {}, idempotencyKey: `${topicPrefix}-race-${randomUUID()}` } });
    }).then(() => "ADMITTED" as const, error => error instanceof Error && error.message === "WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED" ? "BLOCKED" as const : Promise.reject(error));
    const reconciliation = reconcile([ghost]);
    const [admissionResult, reconciliationResult] = await Promise.all([admission, reconciliation]);
    observing = false;
    await observe;
    expect(admissionResult === "ADMITTED" || admissionResult === "BLOCKED").toBe(true);
    expect(reconciliationResult.converged).toBe(1);
    const finalCount = await prisma.job.count({ where: { workspaceId: workspace, type: { in: [...expensiveJobTypes] }, status: { in: ["QUEUED", "RUNNING"] } } });
    expect(Math.max(maxObserved, finalCount)).toBeLessThanOrEqual(2);
  });

  it("PR-A-15 recovers a real DISPATCHED outbox whose BullMQ job was removed", async () => {
    const seed = await seedOperation("PODCAST_GENERATION");
    await setState(seed, "QUEUED", "QUEUED");
    await dispatchOutbox(seed);
    const dispatched = await podcastQueue.getJob(queueJobId(seed));
    expect(dispatched).toBeDefined();
    await dispatched!.remove();
    expect(await podcastQueue.getJob(queueJobId(seed))).toBeUndefined();
    expect((await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: seed.runId } })).status).toBe("DISPATCHED");
    const result = await reconcile([seed]);
    expect(result.decisions[0]?.decision).toBe("RECOVERED_TRANSPORT");
    expect(await runFor(seed)).toMatchObject({ generation: 1, status: "QUEUED" });
  });

  it("PR-A-16 converges DISPATCHED plus success without replay", async () => {
    const seed = await seedOperation("BOOK_ANALYSIS");
    await setState(seed, "SUCCEEDED", "RUNNING", "EXPIRED");
    await markDispatched(seed);
    const result = await reconcile([seed]);
    expect(result.decisions[0]?.decision).toBe("CONVERGED_TERMINAL");
    expect(await prisma.outboxEvent.count({ where: { aggregateId: seed.runId } })).toBe(1);
    expect(await bookQueue.getJob(queueJobId(seed))).toBeUndefined();
  });

  it("PR-A-17 processes one bounded startup page and resumes from its cursor", async () => {
    const workspace = await workspaceId();
    const scaffold = await videoScaffold(workspace);
    const seeds: SeededOperation[] = [];
    for (let index = 0; index < DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE + 1; index += 1) {
      const seed = await seedOperation("SHORT_VIDEO_GENERATION", { workspaceId: workspace });
      await setState(seed, "SUCCEEDED", "RUNNING", "EXPIRED");
      seeds.push(seed);
    }
    const first = await reconcile(seeds, undefined, null, DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE);
    expect(first.discovered).toBe(DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE);
    expect(first.processed).toBe(DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE);
    expect(first.nextCursor).not.toBeNull();
    const rest = await reconcile(seeds, undefined, first.nextCursor, DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE);
    expect(rest.discovered).toBe(1);
    expect(rest.converged).toBe(1);
    expect(await prisma.shortVideoGenerationRun.count({ where: { shortVideoProjectId: scaffold.projectId, status: "SUCCEEDED" } })).toBe(DURABLE_OPERATION_RECONCILIATION_BATCH_SIZE + 1);
  }, 60_000);

  it("PR-A-18 periodic sweep body converges stale capacity without a user request", async () => {
    const seed = await seedOperation("BOOK_ANALYSIS");
    await setState(seed, "FAILED", "RUNNING", "EXPIRED");
    const result = await reconcile([seed]);
    expect(result.decisions[0]?.decision).toBe("CONVERGED_TERMINAL");
    expect(await prisma.job.findUniqueOrThrow({ where: { id: seed.jobId }, select: { status: true } })).toEqual({ status: "FAILED" });
  });

  it("PR-A-18 wires the periodic sweep at the configured 60-second cadence", () => {
    let registeredInterval = 0;
    const handle = scheduleDurableOperationReconciliation(() => undefined, (_callback, intervalMs) => {
      registeredInterval = intervalMs;
      return {} as ReturnType<typeof setInterval>;
    });
    expect(registeredInterval).toBe(DURABLE_OPERATION_RECONCILIATION_INTERVAL_MS);
    expect(registeredInterval).toBe(60_000);
    expect(handle).toBeDefined();
  });

  it("PR-A-19 keeps audio quarantine authoritative over generic transport recovery", async () => {
    const seed = await seedOperation("PODCAST_AUDIO_GENERATION");
    await setState(seed, "QUEUED", "QUEUED");
    await markDispatched(seed);
    await createAudioQuarantine(seed);
    const beforeEvents = await prisma.outboxEvent.count({ where: { aggregateId: seed.runId } });
    const beforeInvocations = await prisma.providerInvocation.count({ where: { workspaceId: seed.workspaceId } });
    const result = await reconcile([seed]);
    expect(result.decisions[0]).toMatchObject({ decision: "AMBIGUOUS_SKIPPED", reason: "AUDIO_PAID_OUTCOME_QUARANTINED" });
    expect(await runFor(seed)).toMatchObject({ generation: 0, status: "QUEUED" });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: seed.runId } })).toBe(beforeEvents);
    expect(await prisma.providerInvocation.count({ where: { workspaceId: seed.workspaceId } })).toBe(beforeInvocations);
  });

  it("PR-A-20 performs zero provider invocations while reconciling all four domains", async () => {
    const seeds = await Promise.all([
      seedOperation("BOOK_ANALYSIS"),
      seedOperation("PODCAST_GENERATION"),
      seedOperation("SHORT_VIDEO_GENERATION"),
      seedOperation("PODCAST_AUDIO_GENERATION"),
    ]);
    for (const seed of seeds) {
      await setState(seed, "QUEUED", "QUEUED");
      await markDispatched(seed);
    }
    const before = await prisma.providerInvocation.count({ where: { workspaceId: { in: seeds.map(seed => seed.workspaceId) } } });
    const result = await reconcile(seeds);
    expect(result.recovered).toBe(4);
    expect(await prisma.providerInvocation.count({ where: { workspaceId: { in: seeds.map(seed => seed.workspaceId) } } })).toBe(before);
    expect(result.decisions.map(item => item.decision)).toEqual(["RECOVERED_TRANSPORT", "RECOVERED_TRANSPORT", "RECOVERED_TRANSPORT", "RECOVERED_TRANSPORT"]);
  });

  it("PR-A-R1-01 revisits a skipped candidate while later arrivals keep the pages full", async () => {
    const old = await seedOperation("BOOK_ANALYSIS");
    await setState(old, "QUEUED", "QUEUED");
    await markDispatched(old);
    await prisma.job.update({ where: { id: old.jobId }, data: { createdAt: new Date(Date.UTC(2024, 0, 1)) } });
    let transientQueueFailure = true;
    const queues: ReconciliationQueues = { BOOK_ANALYSIS: { getJob: async id => {
      if (id === queueJobId(old) && transientQueueFailure) { transientQueueFailure = false; throw new Error("TEMPORARY_QUEUE_READ_FAILURE"); }
      return null;
    } } };
    const candidateIds = [old.jobId];
    let state: ReconciliationSweepState | undefined;
    const first = await reconcileDurableExpensiveOperationsSweep({ state, batchSize: 1, candidateJobIds: candidateIds, queues, topics: { BOOK_ANALYSIS: old.topic } });
    state = first.nextState;
    expect(first.lane).toBe("FORWARD");
    expect(first.decisions[0]).toMatchObject({ jobId: old.jobId, decision: "INFRA_FAILURE" });

    for (const order of [1, 2, 3]) candidateIds.push(await seedOrphanJob(order));
    const repaired = await reconcileDurableExpensiveOperationsSweep({ state, batchSize: 1, candidateJobIds: candidateIds, queues, topics: { BOOK_ANALYSIS: old.topic } });
    state = repaired.nextState;
    expect(repaired.lane).toBe("REVISIT");
    expect(repaired.discovered).toBe(1);
    expect(repaired.decisions[0]).toMatchObject({ jobId: old.jobId, decision: "RECOVERED_TRANSPORT" });
    expect(await runFor(old)).toMatchObject({ status: "QUEUED", generation: 1 });

    for (const order of [4, 5, 6, 7]) {
      candidateIds.push(await seedOrphanJob(order));
      const page = await reconcileDurableExpensiveOperationsSweep({ state, batchSize: 1, candidateJobIds: candidateIds, queues, topics: { BOOK_ANALYSIS: old.topic } });
      state = page.nextState;
      expect(page.discovered).toBe(1);
    }
    expect(transientQueueFailure).toBe(false);
    expect(await prisma.providerInvocation.count({ where: { workspaceId: old.workspaceId } })).toBe(0);
  });

  it("PR-A-R1-02 alternates revisits with forward progress to the tail during continuing arrivals", async () => {
    const candidateIds = [await seedOrphanJob(101), await seedOrphanJob(102), await seedOrphanJob(103)];
    let state: ReconciliationSweepState | undefined;
    const forwardVisited = new Set<string>();
    const revisitVisited = new Set<string>();
    const lanes: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const page = await reconcileDurableExpensiveOperationsSweep({ state, batchSize: 1, candidateJobIds: candidateIds });
      state = page.nextState;
      lanes.push(page.lane);
      const visited = page.decisions[0]?.jobId;
      if (visited) (page.lane === "FORWARD" ? forwardVisited : revisitVisited).add(visited);
      if (index < 7) candidateIds.push(await seedOrphanJob(104 + index));
    }
    expect(lanes).toEqual(["FORWARD", "REVISIT", "FORWARD", "REVISIT", "FORWARD", "REVISIT", "FORWARD", "REVISIT"]);
    expect(revisitVisited.has(candidateIds[0]!)).toBe(true);
    expect(forwardVisited.has(candidateIds[3]!)).toBe(true);
    expect(forwardVisited.size).toBeGreaterThan(1);
  });

  it("PR-A-R1-03 releases only an active legacy audio duplicate superseded by an equivalent active run", async () => {
    const old = await seedOperation("PODCAST_AUDIO_GENERATION");
    const newer = await seedOperation("PODCAST_AUDIO_GENERATION", { workspaceId: old.workspaceId });
    const scaffold = await podcastScaffold(old.workspaceId);
    const voices = await audioVoiceFixture(old.workspaceId, scaffold);
    await attachAudioVoiceMapping(old, voices);
    await attachAudioVoiceMapping(newer, voices);
    await setState(old, "QUEUED", "QUEUED");
    await setState(newer, "QUEUED", "QUEUED");
    await markDispatched(old);
    const providerCallsBefore = await prisma.providerInvocation.count({ where: { workspaceId: old.workspaceId } });
    const result = await reconcile([old]);
    const [oldRun, oldJob, newerRun, newerJob] = await Promise.all([
      prisma.audioGenerationRun.findUniqueOrThrow({ where: { id: old.runId } }),
      prisma.job.findUniqueOrThrow({ where: { id: old.jobId } }),
      prisma.audioGenerationRun.findUniqueOrThrow({ where: { id: newer.runId } }),
      prisma.job.findUniqueOrThrow({ where: { id: newer.jobId } }),
    ]);
    expect(result.decisions[0]).toMatchObject({ decision: "CONVERGED_TERMINAL", reason: "AUDIO_GENERATION_SUPERSEDED" });
    expect([oldRun.status, oldRun.errorCode, oldJob.status, oldJob.error]).toEqual(["FAILED", "AUDIO_GENERATION_SUPERSEDED", "FAILED", { code: "AUDIO_GENERATION_SUPERSEDED" }]);
    expect([newerRun.status, newerRun.dispatchGeneration, newerJob.status]).toEqual(["QUEUED", 0, "QUEUED"]);
    expect(await prisma.job.count({ where: { workspaceId: old.workspaceId, type: AUDIO_GENERATION_JOB, status: { in: ["QUEUED", "RUNNING"] } } })).toBe(1);
    expect(await prisma.providerInvocation.count({ where: { workspaceId: old.workspaceId } })).toBe(providerCallsBefore);
  });

  it("PR-A-R1-04 releases an active ghost superseded by a successful equivalent without copying success", async () => {
    const old = await seedOperation("PODCAST_AUDIO_GENERATION");
    const successful = await seedOperation("PODCAST_AUDIO_GENERATION", { workspaceId: old.workspaceId });
    const voices = await audioVoiceFixture(old.workspaceId, await podcastScaffold(old.workspaceId));
    await attachAudioVoiceMapping(old, voices);
    await attachAudioVoiceMapping(successful, voices);
    await setState(old, "QUEUED", "QUEUED");
    await setState(successful, "SUCCEEDED", "SUCCEEDED");
    await markDispatched(old);
    const providerCallsBefore = await prisma.providerInvocation.count({ where: { workspaceId: old.workspaceId } });
    const result = await reconcile([old]);
    const [oldRun, oldJob, successRun, successJob] = await Promise.all([
      prisma.audioGenerationRun.findUniqueOrThrow({ where: { id: old.runId } }),
      prisma.job.findUniqueOrThrow({ where: { id: old.jobId } }),
      prisma.audioGenerationRun.findUniqueOrThrow({ where: { id: successful.runId } }),
      prisma.job.findUniqueOrThrow({ where: { id: successful.jobId } }),
    ]);
    expect(result.decisions[0]).toMatchObject({ decision: "CONVERGED_TERMINAL", reason: "AUDIO_GENERATION_SUPERSEDED" });
    expect([oldRun.status, oldRun.errorCode, oldJob.status, oldJob.error]).toEqual(["FAILED", "AUDIO_GENERATION_SUPERSEDED", "FAILED", { code: "AUDIO_GENERATION_SUPERSEDED" }]);
    expect([successRun.status, successRun.errorCode, successJob.status]).toEqual(["SUCCEEDED", null, "SUCCEEDED"]);
    expect(await prisma.providerInvocation.count({ where: { workspaceId: old.workspaceId } })).toBe(providerCallsBefore);
  });

  it("PR-A-R1-05 does not supersede an audio run when host-to-voice assignments are swapped", async () => {
    const old = await seedOperation("PODCAST_AUDIO_GENERATION");
    const swapped = await seedOperation("PODCAST_AUDIO_GENERATION", { workspaceId: old.workspaceId });
    const voices = await audioVoiceFixture(old.workspaceId, await podcastScaffold(old.workspaceId));
    await attachAudioVoiceMapping(old, voices);
    await attachAudioVoiceMapping(swapped, voices, true);
    await setState(old, "QUEUED", "QUEUED");
    await setState(swapped, "QUEUED", "QUEUED");
    await markDispatched(old);
    const result = await reconcile([old]);
    expect(result.decisions[0]).toMatchObject({ decision: "RECOVERED_TRANSPORT" });
    expect(await runFor(old)).toMatchObject({ status: "QUEUED", generation: 1 });
    expect(await runFor(swapped)).toMatchObject({ status: "QUEUED", generation: 0 });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: old.jobId }, select: { status: true, error: true } })).toEqual({ status: "QUEUED", error: null });
  });

  it("PR-A-R1-06 keeps an OPEN paid-outcome quarantine ahead of audio superseded convergence", async () => {
    const old = await seedOperation("PODCAST_AUDIO_GENERATION");
    const equivalent = await seedOperation("PODCAST_AUDIO_GENERATION", { workspaceId: old.workspaceId });
    const voices = await audioVoiceFixture(old.workspaceId, await podcastScaffold(old.workspaceId));
    await attachAudioVoiceMapping(old, voices);
    await attachAudioVoiceMapping(equivalent, voices);
    await setState(old, "QUEUED", "QUEUED");
    await setState(equivalent, "QUEUED", "QUEUED");
    await markDispatched(old);
    await createAudioQuarantine(old);
    const providerCallsBefore = await prisma.providerInvocation.count({ where: { workspaceId: old.workspaceId } });
    const before = await prisma.job.findUniqueOrThrow({ where: { id: old.jobId }, select: { status: true, error: true } });
    const result = await reconcile([old]);
    expect(result.decisions[0]).toMatchObject({ decision: "AMBIGUOUS_SKIPPED", reason: "AUDIO_PAID_OUTCOME_QUARANTINED" });
    expect(await runFor(old)).toMatchObject({ status: "QUEUED", generation: 0 });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: old.jobId }, select: { status: true, error: true } })).toEqual(before);
    expect(await runFor(equivalent)).toMatchObject({ status: "QUEUED", generation: 0 });
    expect(await prisma.providerInvocation.count({ where: { workspaceId: old.workspaceId } })).toBe(providerCallsBefore);
  });

  it("PR-A-R1-07 leaves an orphan active expensive Job untouched with a stable diagnostic", async () => {
    const orphanJobId = await seedOrphanJob(900);
    const before = await prisma.job.findUniqueOrThrow({ where: { id: orphanJobId } });
    const providerCallsBefore = await prisma.providerInvocation.count({ where: { workspaceId: before.workspaceId! } });
    const result = await reconcileDurableExpensiveOperationsBatch({ batchSize: 1, candidateJobIds: [orphanJobId] });
    expect(result.decisions[0]).toMatchObject({ jobId: orphanJobId, decision: "AMBIGUOUS_SKIPPED", reason: "DURABLE_RUN_IDENTITY_MISSING" });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: orphanJobId } })).toEqual(before);
    expect(await prisma.providerInvocation.count({ where: { workspaceId: before.workspaceId! } })).toBe(providerCallsBefore);
  });
});
