import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import { createRedisConnection } from "@ai-cognitive/shared/server";

const resources: Array<{ queue: Queue; events: QueueEvents; worker: Worker }> = [];
afterEach(async () => { await Promise.all(resources.splice(0).flatMap(resource => [resource.worker.close(), resource.events.close(), resource.queue.close()])); });

async function observeConcurrency(concurrency: number) {
  const name = `phase16-concurrency-${randomUUID()}`, connection = createRedisConnection(process.env.REDIS_URL!);
  let inFlight = 0, maxInFlight = 0, signalStarted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const worker = new Worker(name, async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); if (inFlight === concurrency) signalStarted(); await gate; inFlight--; }, { connection, concurrency });
  const queue = new Queue(name, { connection: createRedisConnection(process.env.REDIS_URL!) }), events = new QueueEvents(name, { connection: createRedisConnection(process.env.REDIS_URL!) }); resources.push({ queue, events, worker }); await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
  const jobs = await Promise.all(Array.from({ length: concurrency + 1 }, (_, index) => queue.add("phase16", { index }, { jobId: `job-${index}` })));
  await started; const observed = maxInFlight; release(); await Promise.all(jobs.map(job => job.waitUntilFinished(events, 15_000))); return observed;
}

describe("Phase 16 deterministic BullMQ worker concurrency", () => {
  it("holds actual in-flight work to one at concurrency=1", async () => { expect(await observeConcurrency(1)).toBe(1); });
  it("allows bounded parallel work at concurrency=3", async () => { const max = await observeConcurrency(3); expect(max).toBeGreaterThan(1); expect(max).toBeLessThanOrEqual(3); });
});
