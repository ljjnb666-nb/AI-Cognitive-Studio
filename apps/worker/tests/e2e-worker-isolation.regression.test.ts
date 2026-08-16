import "./setup-phase1-e2e.js";
import { Queue, Worker } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import { dispatchPendingOutbox, INGESTION_QUEUE, INGESTION_TOPIC } from "@ai-cognitive/ingestion";
import { prisma } from "@ai-cognitive/db";
import { createRedisConnection, readEnvironment } from "@ai-cognitive/shared/server";
import { createE2EWorkerIsolation } from "./helpers/e2e-worker-isolation.js";

const environment = readEnvironment();
const queueName = "e2e-worker-isolation-regression";

describe("real Redis E2E worker isolation", () => {
  it("keeps BullMQ namespaces and outbox topics mutually isolated while defaults stay unchanged", async () => {
    const isolation = createE2EWorkerIsolation("isolation-regression"), connection = createRedisConnection(environment.REDIS_URL);
    const defaultQueue = new Queue<{ direction: string }>(queueName, { connection });
    const isolatedQueue = new Queue<{ direction: string }>(queueName, { connection: createRedisConnection(environment.REDIS_URL), prefix: isolation.bullmqPrefix });
    const defaultJobs: string[] = [], isolatedJobs: string[] = [];
    const defaultWorker = new Worker<{ direction: string }>(queueName, async job => { defaultJobs.push(job.data.direction); }, { connection: createRedisConnection(environment.REDIS_URL) });
    const isolatedWorker = new Worker<{ direction: string }>(queueName, async job => { isolatedJobs.push(job.data.direction); }, { connection: createRedisConnection(environment.REDIS_URL), prefix: isolation.bullmqPrefix });
    const defaultTopic = "source.ingestion.requested", isolatedTopic = isolation.topics.sourceIngestion, eventIds: string[] = [];
    try {
      expect([INGESTION_QUEUE, INGESTION_TOPIC, defaultQueue.opts.prefix]).toEqual(["source.ingestion", "source.ingestion.requested", "bull"]);
      await Promise.all([defaultWorker.waitUntilReady(), isolatedWorker.waitUntilReady()]);
      await isolatedQueue.add("isolation", { direction: "isolated" }, { jobId: `isolated-${isolation.id}` });
      await expect.poll(() => isolatedJobs).toEqual(["isolated"]);
      expect(defaultJobs).toEqual([]);
      await defaultQueue.add("isolation", { direction: "default" }, { jobId: `default-${isolation.id}` });
      await expect.poll(() => defaultJobs).toEqual(["default"]);
      expect(isolatedJobs).toEqual(["isolated"]);

      const [defaultEvent, isolatedEvent] = await Promise.all([prisma.outboxEvent.create({ data: { topic: defaultTopic, aggregateId: `default-${isolation.id}`, payload: { direction: "default" } } }), prisma.outboxEvent.create({ data: { topic: isolatedTopic, aggregateId: `isolated-${isolation.id}`, payload: { direction: "isolated" } } })]);
      eventIds.push(defaultEvent.id, isolatedEvent.id);
      const enqueue = async (topic: string) => dispatchPendingOutbox<{ direction: string }>({ topic, queue: topic === defaultTopic ? defaultQueue : isolatedQueue, jobName: "outbox-isolation", parse: payload => payload as { direction: string }, jobId: payload => `${topic}:${payload.direction}:${isolation.id}` });
      expect(await enqueue(defaultTopic)).toBe(1);
      expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: isolatedEvent.id } })).status).toBe("PENDING");
      expect(await enqueue(isolatedTopic)).toBe(1);
      expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: defaultEvent.id } })).status).toBe("DISPATCHED");
      expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: isolatedEvent.id } })).status).toBe("DISPATCHED");
    } finally {
      await Promise.all([defaultWorker.close(), isolatedWorker.close(), defaultQueue.close(), isolatedQueue.close()]);
      await prisma.outboxEvent.deleteMany({ where: { id: { in: eventIds } } });
    }
  });
});

afterAll(() => prisma.$disconnect());
