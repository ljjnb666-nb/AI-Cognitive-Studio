import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import { podcastAudioGenerationJobId, type PodcastAudioDispatchPayload } from "@ai-cognitive/podcast-generation";
import { createRedisConnection } from "@ai-cognitive/shared/server";

const resources: Array<{ queue: Queue<PodcastAudioDispatchPayload>; events: QueueEvents; worker: Worker<PodcastAudioDispatchPayload> }> = [];
afterEach(async () => { await Promise.all(resources.splice(0).flatMap(({ queue, events, worker }) => [worker.close(), events.close(), queue.close()])); });

describe("Podcast Audio durable dispatch generations", () => {
  it("keeps completed generation zero separate from executable generation one", async () => {
    const queueName = `audio-dispatch-generation-${randomUUID()}`;
    const queue = new Queue<PodcastAudioDispatchPayload>(queueName, { connection: createRedisConnection(process.env.REDIS_URL!) });
    const events = new QueueEvents(queueName, { connection: createRedisConnection(process.env.REDIS_URL!) });
    const delivered: string[] = [];
    const worker = new Worker<PodcastAudioDispatchPayload>(queueName, async job => { delivered.push(job.id!); return job.data.dispatchGeneration; }, { connection: createRedisConnection(process.env.REDIS_URL!) });
    resources.push({ queue, events, worker });
    await Promise.all([events.waitUntilReady(), worker.waitUntilReady()]);
    const runId = `run-${randomUUID()}`, gen0: PodcastAudioDispatchPayload = { audioGenerationRunId: runId, dispatchGeneration: 0 }, gen1: PodcastAudioDispatchPayload = { audioGenerationRunId: runId, dispatchGeneration: 1 };
    const old = await queue.add("podcast.audio-generation", gen0, { jobId: podcastAudioGenerationJobId(gen0), removeOnComplete: false });
    await expect(old.waitUntilFinished(events, 15_000)).resolves.toBe(0);
    expect(await old.getState()).toBe("completed");
    const replacement = await queue.add("podcast.audio-generation", gen1, { jobId: podcastAudioGenerationJobId(gen1), removeOnComplete: false });
    await expect(replacement.waitUntilFinished(events, 15_000)).resolves.toBe(1);
    expect([old.id, replacement.id, delivered]).toEqual([runId, `podcast-audio-${runId}-g1`, [runId, `podcast-audio-${runId}-g1`]]);
  });
});
