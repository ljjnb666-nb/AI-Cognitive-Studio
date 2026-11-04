import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma, cancelWorkspaceJob, assertExecutionRunActive } from "../src/index.js";

const workspaceIds: string[] = [], userIds: string[] = [];
afterEach(async () => {
  const where = { workspaceId: { in: workspaceIds } };
  await prisma.$transaction(async tx => {
    await tx.shortVideoGenerationRun.deleteMany({ where });
    await tx.shortVideoStyleProfile.deleteMany({ where });
    await tx.shortVideoProject.deleteMany({ where });
    await tx.audioGenerationRun.deleteMany({ where });
    await tx.podcastScriptRevision.deleteMany({ where });
    await tx.podcastGenerationRun.deleteMany({ where });
    await tx.podcastEpisodeAudioConfig.deleteMany({ where });
    await tx.podcastEpisode.deleteMany({ where });
    await tx.podcastStyleProfile.deleteMany({ where });
    await tx.podcastProject.deleteMany({ where });
    await tx.bookAnalysisRun.deleteMany({ where });
    await tx.chunkSet.deleteMany({ where });
    await tx.documentExtraction.deleteMany({ where });
    await tx.ingestionRun.deleteMany({ where });
    await tx.job.deleteMany({ where });
    await tx.sourceDocument.deleteMany({ where });
    await tx.source.deleteMany({ where });
    await tx.sourceBlob.deleteMany({ where });
    await tx.workspaceMember.deleteMany({ where });
    await tx.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
  });
  workspaceIds.length = 0;
  userIds.length = 0;
});

const runTables = ["BookAnalysisRun", "PodcastGenerationRun", "AudioGenerationRun", "ShortVideoGenerationRun"] as const;
type RunTable = typeof runTables[number];
async function readRun(table: RunTable, id: string) {
  const [run] = await prisma.$queryRaw<Array<{ status: string; errorCode: string | null; executionClaimToken: string | null; dispatchGeneration: number }>>(Prisma.sql`SELECT "status", "errorCode", "executionClaimToken", "dispatchGeneration" FROM ${Prisma.raw(`"${table}"`)} WHERE "id"=${id}`);
  if (!run) throw new Error("TEST_RUN_NOT_FOUND");
  return run;
}
async function fixture(table: RunTable) {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { email: `${suffix}@cancel.test` } });
  userIds.push(user.id);
  const workspace = await prisma.workspace.create({ data: { name: `cancel-${suffix}`, members: { create: { userId: user.id, role: "OWNER" } } } });
  workspaceIds.push(workspace.id);
  const context = { workspaceId: workspace.id, userId: user.id };
  if (table !== "BookAnalysisRun") {
    const job = await prisma.job.create({ data: { workspaceId: workspace.id, type: table === "PodcastGenerationRun" ? "podcast.generate" : table === "AudioGenerationRun" ? "podcast.audio" : "short-video.generate", payload: {}, status: "RUNNING" } });
    const common = { workspaceId: workspace.id, jobId: job.id, pipelineVersion: "test", provider: "test", model: "test", generationIdentityHash: suffix, idempotencyKey: suffix, status: "RUNNING" as const, executionClaimToken: suffix, executionClaimedAt: new Date(), executionLeaseUntil: new Date(Date.now() + 60_000) };
    if (table === "ShortVideoGenerationRun") {
      const project = await prisma.shortVideoProject.create({ data: { workspaceId: workspace.id, name: "cancel" } });
      const style = await prisma.shortVideoStyleProfile.create({ data: { workspaceId: workspace.id, shortVideoProjectId: project.id, version: 1 } });
      const run = await prisma.shortVideoGenerationRun.create({ data: { ...common, shortVideoProjectId: project.id, styleProfileId: style.id, promptVersion: "test", retrievalVersion: "test", scenePlannerVersion: "test", captionVersion: "test", audioVersion: "test", renderVersion: "test" } });
      return { context, job, run };
    }
    const project = await prisma.podcastProject.create({ data: { workspaceId: workspace.id, name: "cancel" } });
    const style = await prisma.podcastStyleProfile.create({ data: { workspaceId: workspace.id, podcastProjectId: project.id, version: 1 } });
    const episode = await prisma.podcastEpisode.create({ data: { workspaceId: workspace.id, podcastProjectId: project.id, styleProfileId: style.id, title: "cancel", language: "zh-CN", targetDurationMinutes: 1 } });
    if (table === "PodcastGenerationRun") {
      const run = await prisma.podcastGenerationRun.create({ data: { ...common, podcastProjectId: project.id, episodeId: episode.id, styleProfileId: style.id, promptVersion: "test", modelVersionKey: "", hostConfigurationHash: suffix, hostConfigurationVersion: 1 } });
      return { context, job, run };
    }
    const revision = await prisma.podcastScriptRevision.create({ data: { workspaceId: workspace.id, episodeId: episode.id, revisionNumber: 1, source: "USER_EDIT", scriptSnapshot: {}, estimatedDurationSeconds: 60 } });
    const config = await prisma.podcastEpisodeAudioConfig.create({ data: { workspaceId: workspace.id, podcastProjectId: project.id, episodeId: episode.id, version: 1 } });
    const run = await prisma.audioGenerationRun.create({ data: { ...common, podcastProjectId: project.id, episodeId: episode.id, scriptRevisionId: revision.id, audioConfigId: config.id, speechPreparationVersion: "test", assemblyVersion: "test", normalizationVersion: "test", outputFormat: "wav" } });
    return { context, job, run };
  }
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "cancel" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: suffix, sizeBytes: 1, mediaType: "text/plain", storageKey: suffix } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/plain", storageKey: suffix } });
  const ingestJob = await prisma.job.create({ data: { workspaceId: workspace.id, type: "source.ingest", payload: {} } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: ingestJob.id, parserVersion: "test", normalizationVersion: "test" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } });
  const chunks = await prisma.chunkSet.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "test", configuration: {}, configurationHash: suffix, status: "SUCCEEDED" } });
  const job = await prisma.job.create({ data: { workspaceId: workspace.id, type: "book.analysis", payload: {}, status: "RUNNING" } });
  const run = await prisma.bookAnalysisRun.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunks.id, jobId: job.id, pipelineVersion: "test", promptVersion: "test", provider: "test", model: "test", modelVersionKey: "", idempotencyKey: suffix, analysisIdentityHash: suffix, status: "RUNNING", executionClaimToken: suffix, executionLeaseUntil: new Date(Date.now() + 60_000) } });
  return { context, job, run };
}

describe.each(runTables)("%s cancellation fences", table => {
  it.each(["downgrade", "remove"] as const)("rechecks authority after waiting for a run lock: %s", async change => {
    const { context, job, run } = await fixture(table);
    let unlock!: () => void, locked!: (pid: number) => void;
    const barrier = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<number>(resolve => { locked = resolve; });
    const holder = prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id"=${run.id} FOR UPDATE`);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      locked(row!.pid);
      await barrier;
    }, { timeout: 15000 });
    const holderPid = await acquired;
    const cancellation = cancelWorkspaceJob(context, job.id).then(value => value, error => error as Error);
    try {
      await expect.poll(async () => {
        const [row] = await prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
        return row!.count;
      }, { timeout: 3000, interval: 20 }).toBeGreaterThan(0);
      if (change === "downgrade") await prisma.workspaceMember.update({ where: { workspaceId_userId: context }, data: { role: "VIEWER" } });
      else await prisma.workspaceMember.delete({ where: { workspaceId_userId: context } });
    } finally { unlock(); await holder; }
    expect(await cancellation).toMatchObject({ message: "WORKSPACE_WRITE_DENIED" });
    expect(await readRun(table, run.id)).toMatchObject({ status: "RUNNING", executionClaimToken: run.executionClaimToken, dispatchGeneration: run.dispatchGeneration });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "RUNNING" });
  });
  it("serializes duplicate cancels, invalidates the claim, and blocks subsequent paid work", async () => {
    const { context, job, run } = await fixture(table);
    await expect(assertExecutionRunActive(context.workspaceId, run.id)).resolves.toBeUndefined();
    const results = await Promise.all([cancelWorkspaceJob(context, job.id), cancelWorkspaceJob(context, job.id)]);
    expect(results).toEqual([{ status: "CANCELLED" }, { status: "CANCELLED" }]);
    expect(await readRun(table, run.id)).toMatchObject({ status: "FAILED", errorCode: "USER_CANCELLED", executionClaimToken: null, dispatchGeneration: run.dispatchGeneration + 1 });
    await expect(assertExecutionRunActive(context.workspaceId, run.id)).rejects.toThrow("EXECUTION_CANCELLED");
  });
  it("rejects viewers and foreign jobs, and preserves completed jobs", async () => {
    const a = await fixture(table), b = await fixture(table);
    await expect(cancelWorkspaceJob(a.context, b.job.id)).rejects.toThrow("CANCELLABLE_OPERATION_NOT_FOUND");
    await prisma.workspaceMember.update({ where: { workspaceId_userId: a.context }, data: { role: "VIEWER" } });
    await expect(cancelWorkspaceJob(a.context, a.job.id)).rejects.toThrow("WORKSPACE_WRITE_DENIED");
    await prisma.job.update({ where: { id: b.job.id }, data: { status: "SUCCEEDED" } });
    await expect(cancelWorkspaceJob(b.context, b.job.id)).rejects.toThrow("OPERATION_ALREADY_TERMINAL");
    expect((await readRun(table, b.run.id)).executionClaimToken).toBe(b.run.executionClaimToken);
  });
  it("still cancels at the persisted generation ceiling without integer overflow", async () => {
    const { context, run, job } = await fixture(table);
    await prisma.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET "dispatchGeneration"=2147483647 WHERE "id"=${run.id}`);
    await expect(cancelWorkspaceJob(context, job.id)).resolves.toEqual({ status: "CANCELLED" });
    await expect(assertExecutionRunActive(context.workspaceId, run.id)).rejects.toThrow("EXECUTION_CANCELLED");
  });
});
afterAll(() => prisma.$disconnect());
