import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { createShortVideoGenerationQueue, createShortVideoGenerationWorker } from "../../../apps/worker/src/short-video-generation.js";
import { dispatchPendingShortVideoGeneration, rearmShortVideoGenerationRunById, SHORT_VIDEO_GENERATION_TOPIC } from "../src/index.js";

const owned: Array<{ workspaceId: string; runId: string; jobId: string }> = [];
afterEach(async () => { for (const item of owned.splice(0)) { await prisma.outboxEvent.deleteMany({ where: { aggregateId: item.runId } }); await prisma.shortVideoGenerationRun.deleteMany({ where: { id: item.runId } }); await prisma.job.deleteMany({ where: { workspaceId: item.workspaceId } }); await prisma.shortVideoStyleProfile.deleteMany({ where: { workspaceId: item.workspaceId } }); await prisma.shortVideoProject.deleteMany({ where: { workspaceId: item.workspaceId } }); await prisma.workspace.deleteMany({ where: { id: item.workspaceId } }); } });

async function fixture(generation: number) {
  const workspaceId = randomUUID();
  await prisma.workspace.create({ data: { id: workspaceId, name: workspaceId } });
  const project = await prisma.shortVideoProject.create({ data: { workspaceId, name: "A2 overflow" } });
  const style = await prisma.shortVideoStyleProfile.create({ data: { workspaceId, shortVideoProjectId: project.id, version: 1, targetDurationSeconds: 15 } });
  const job = await prisma.job.create({ data: { workspaceId, type: "short-video.generation", payload: {}, status: "FAILED" } });
  const run = await prisma.shortVideoGenerationRun.create({ data: { workspaceId, shortVideoProjectId: project.id, styleProfileId: style.id, jobId: job.id, provider: "fixture", model: "fixture", modelVersionKey: "1", promptVersion: "p", pipelineVersion: "p", retrievalVersion: "p", scenePlannerVersion: "p", captionVersion: "p", audioVersion: "p", renderVersion: "p", generationIdentityHash: randomUUID(), idempotencyKey: randomUUID(), status: "FAILED", stage: "VIDEO_PLANNING", dispatchGeneration: generation } });
  owned.push({ workspaceId, runId: run.id, jobId: job.id });
  return { run, job };
}

describe("A2 Short Video dispatch generation overflow", () => {
  it("accepts the largest safe transport generation but fences it against the persisted generation before provider resolution", async () => {
    const { run, job } = await fixture(0);
    const prefix = `a2-video-safe-integer-${randomUUID()}`;
    let provider = 0, embedding = 0, tts = 0;
    const environment = { REDIS_URL: process.env.REDIS_URL!, S3_ENDPOINT: "http://localhost:9000", S3_REGION: "us-east-1", S3_BUCKET: "ai-cognitive-studio-dev", S3_ACCESS_KEY: "local-development-only", S3_SECRET_KEY: "local-development-only", S3_FORCE_PATH_STYLE: true, WORKER_SHORT_VIDEO_GENERATION_CONCURRENCY: 1 } as unknown as Parameters<typeof createShortVideoGenerationWorker>[0];
    const worker = createShortVideoGenerationWorker(environment, { providerForRun: async () => { provider++; throw new Error("UNEXPECTED_PROVIDER"); }, embeddingProviderForRun: async () => { embedding++; throw new Error("UNEXPECTED_EMBEDDING"); }, ttsForRun: async () => { tts++; throw new Error("UNEXPECTED_TTS"); } }, { prefix });
    const queue = createShortVideoGenerationQueue(environment, { prefix });
    try {
      await worker.waitUntilReady();
      const before = await Promise.all([prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: run.id } }), prisma.job.findUniqueOrThrow({ where: { id: job.id } }), prisma.providerInvocation.count()]);
      const delivered = await queue.add("a2-safe-integer", { shortVideoGenerationRunId: run.id, dispatchGeneration: Number.MAX_SAFE_INTEGER }, { jobId: `${run.id}-safe` });
      await expect.poll(async () => delivered.getState(), { timeout: 10_000 }).toBe("completed");
      expect([provider, embedding, tts]).toEqual([0, 0, 0]);
      expect(await Promise.all([prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: run.id } }), prisma.job.findUniqueOrThrow({ where: { id: job.id } }), prisma.providerInvocation.count()])).toEqual(before);
    } finally { await Promise.all([worker.close(), queue.obliterate({ force: true }), queue.close()]); }
  });
  it("dispatches distinct real BullMQ gen0 and gen1 jobs, then fences stale gen0 redelivery", async () => {
    const { run } = await fixture(0);
    const prefix = `a2-video-gen0-gen1-${randomUUID()}`;
    let provider = 0;
    const environment = { REDIS_URL: process.env.REDIS_URL!, S3_ENDPOINT: "http://localhost:9000", S3_REGION: "us-east-1", S3_BUCKET: "ai-cognitive-studio-dev", S3_ACCESS_KEY: "local-development-only", S3_SECRET_KEY: "local-development-only", S3_FORCE_PATH_STYLE: true, WORKER_SHORT_VIDEO_GENERATION_CONCURRENCY: 1 } as unknown as Parameters<typeof createShortVideoGenerationWorker>[0];
    const worker = createShortVideoGenerationWorker(environment, { providerForRun: async () => { provider++; throw new Error("A2_EXPECTED_PROVIDER_FAILURE"); }, embeddingProviderForRun: async () => { throw new Error("UNEXPECTED_EMBEDDING"); }, ttsForRun: async () => { throw new Error("UNEXPECTED_TTS"); } }, { prefix });
    const queue = createShortVideoGenerationQueue(environment, { prefix });
    try {
      await worker.waitUntilReady();
      await prisma.outboxEvent.create({ data: { topic: SHORT_VIDEO_GENERATION_TOPIC, aggregateId: run.id, payload: { shortVideoGenerationRunId: run.id, dispatchGeneration: 0 } } });
      await dispatchPendingShortVideoGeneration(queue, { aggregateIds: [run.id] });
      const gen0 = await queue.getJob(run.id);
      expect(gen0).toBeTruthy();
      await expect.poll(async () => gen0!.getState(), { timeout: 10_000 }).toBe("failed");
      await expect(rearmShortVideoGenerationRunById(run.id, 0)).resolves.toBe("REARMED");
      await dispatchPendingShortVideoGeneration(queue, { aggregateIds: [run.id] });
      const gen1 = await queue.getJob(`${run.id}-g1`);
      expect(gen1).toBeTruthy();
      await expect.poll(async () => gen1!.getState(), { timeout: 10_000 }).toBe("failed");
      expect([gen0!.id, gen1!.id]).toEqual([run.id, `${run.id}-g1`]);
      const beforeStale = provider;
      const stale = await queue.add("a2-stale-redelivery", { shortVideoGenerationRunId: run.id, dispatchGeneration: 0 }, { jobId: `${run.id}-g0-redelivery` });
      await expect.poll(async () => stale.getState(), { timeout: 10_000 }).toBe("completed");
      expect(provider).toBe(beforeStale);
    } finally { await Promise.all([worker.close(), queue.obliterate({ force: true }), queue.close()]); }
  });
  it("keeps active capacity, reacquires terminal capacity, and rolls back when full", async () => { const prior = process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT; process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT = "2"; try { const active = await fixture(0); await prisma.job.update({ where: { id: active.job.id }, data: { status: "QUEUED" } }); await prisma.job.create({ data: { workspaceId: active.run.workspaceId, type: "book.analysis", payload: {}, status: "QUEUED" } }); await expect(rearmShortVideoGenerationRunById(active.run.id, 0)).resolves.toBe("REARMED"); expect(await prisma.job.count({ where: { workspaceId: active.run.workspaceId, status: { in: ["QUEUED", "RUNNING"] } } })).toBe(2); const terminal = await fixture(0); await prisma.job.create({ data: { workspaceId: terminal.run.workspaceId, type: "book.analysis", payload: {}, status: "QUEUED" } }); await expect(rearmShortVideoGenerationRunById(terminal.run.id, 0)).resolves.toBe("REARMED"); expect(await prisma.job.count({ where: { workspaceId: terminal.run.workspaceId, status: { in: ["QUEUED", "RUNNING"] } } })).toBe(2); const full = await fixture(0); await prisma.job.createMany({ data: ["a", "b"].map(id => ({ workspaceId: full.run.workspaceId, type: "book.analysis", payload: {}, status: "QUEUED", idempotencyKey: `a2-full-${id}-${randomUUID()}` })) }); const before = await Promise.all([prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: full.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: full.job.id } }), prisma.outboxEvent.count({ where: { aggregateId: full.run.id } })]); await expect(rearmShortVideoGenerationRunById(full.run.id, 0)).resolves.toBe("CAPACITY_BLOCKED"); expect(await Promise.all([prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: full.run.id } }), prisma.job.findUniqueOrThrow({ where: { id: full.job.id } }), prisma.outboxEvent.count({ where: { aggregateId: full.run.id } })])).toEqual(before); } finally { if (prior === undefined) delete process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT; else process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT = prior; } });
  it("does not rearm a Short Video run with a live execution lease", async () => { const { run, job } = await fixture(0); await prisma.shortVideoGenerationRun.update({ where: { id: run.id }, data: { status: "RUNNING", executionLeaseUntil: new Date(Date.now() + 60_000) } }); const before = await Promise.all([prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: run.id } }), prisma.job.findUniqueOrThrow({ where: { id: job.id } }), prisma.outboxEvent.count({ where: { aggregateId: run.id } })]); await expect(rearmShortVideoGenerationRunById(run.id, 0)).resolves.toBe("NOT_ELIGIBLE"); expect(await Promise.all([prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: run.id } }), prisma.job.findUniqueOrThrow({ where: { id: job.id } }), prisma.outboxEvent.count({ where: { aggregateId: run.id } })])).toEqual(before); });
  it("allows exactly one concurrent max-minus-one rearm and never persists an overflow", async () => {
    const { run } = await fixture(2_147_483_646);
    const results = await Promise.all([
      rearmShortVideoGenerationRunById(run.id, 2_147_483_646, "a2.overflow.concurrent.video"),
      rearmShortVideoGenerationRunById(run.id, 2_147_483_646, "a2.overflow.concurrent.video"),
    ]);
    expect(results.filter((result) => result === "REARMED")).toHaveLength(1);
    expect(results.every((result) => result === "REARMED" || result === "RACE_LOST" || result === "NOT_ELIGIBLE")).toBe(true);
    expect((await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: run.id } })).dispatchGeneration).toBe(2_147_483_647);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: run.id, topic: "a2.overflow.concurrent.video" } })).toBe(1);
  });

  it("fences a stale outbox finalizer after same-run rearm", async () => {
    const { run, job } = await fixture(0);
    await prisma.outboxEvent.create({ data: { topic: SHORT_VIDEO_GENERATION_TOPIC, aggregateId: run.id, payload: { shortVideoGenerationRunId: run.id, dispatchGeneration: 0 } } });
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((resolve) => (reached = resolve));
    const releaseP = new Promise<void>((resolve) => (release = resolve));
    const stale = dispatchPendingShortVideoGeneration(
      { add: async () => ({}) },
      { aggregateIds: [run.id], beforeFinalize: async () => { reached(); await releaseP; } },
    );
    await reachedP;
    await expect(rearmShortVideoGenerationRunById(run.id, 0)).resolves.toBe("REARMED");
    release();
    await stale;
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).queueJobId).toBeNull();
    const queueIds: string[] = [];
    await dispatchPendingShortVideoGeneration(
      { add: async (_name, _payload, options) => { queueIds.push(options.jobId); return {}; } },
      { aggregateIds: [run.id] },
    );
    expect([queueIds, (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).queueJobId]).toEqual([[`${run.id}-g1`], `${run.id}-g1`]);
  });

  it("advances max-minus-one once, then refuses the persisted maximum without side effects", async () => {
    const { run, job } = await fixture(2_147_483_646);
    await expect(rearmShortVideoGenerationRunById(run.id, 2_147_483_646, "a2.overflow.video")).resolves.toBe("REARMED");
    const atMax = await prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(atMax.dispatchGeneration).toBe(2_147_483_647);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: run.id } })).toBe(1);
    const before = await Promise.all([prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: run.id } }), prisma.job.findUniqueOrThrow({ where: { id: job.id } }), prisma.outboxEvent.count({ where: { aggregateId: run.id } })]);
    await expect(rearmShortVideoGenerationRunById(run.id, 2_147_483_647, "a2.overflow.video")).resolves.toBe("NOT_ELIGIBLE");
    const after = await Promise.all([prisma.shortVideoGenerationRun.findUniqueOrThrow({ where: { id: run.id } }), prisma.job.findUniqueOrThrow({ where: { id: job.id } }), prisma.outboxEvent.count({ where: { aggregateId: run.id } })]);
    expect(after).toEqual(before);
  });
});
