import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthCheckQueue, closeQueueResources, enqueueHealthCheck } from "../src/queue.js";
import { createHealthCheckWorker } from "../src/worker.js";

const resources: Array<ReturnType<typeof createHealthCheckQueue>> = [];
const workers: ReturnType<typeof createHealthCheckWorker>[] = [];

afterEach(async () => {
  await Promise.all(
    resources
      .splice(0)
      .map((resource, index) => closeQueueResources(resource.queue, resource.events, resource.connection, workers[index])),
  );
  workers.splice(0);
});

describe("BullMQ health-check integration", () => {
  it("enqueues and completes the health-check job", async () => {
    const queueName = `phase-0-health-${randomUUID()}`;
    const resource = createHealthCheckQueue(process.env.REDIS_URL!, queueName);
    const worker = createHealthCheckWorker(process.env.REDIS_URL!, queueName);
    resources.push(resource);
    workers.push(worker);
    await resource.events.waitUntilReady();

    const job = await enqueueHealthCheck(resource.queue);
    const completed = await job.waitUntilFinished(resource.events, 15_000);

    expect(completed).toEqual({ ok: true, message: "phase-0" });
  });

  it("records a failed job when payload validation fails", async () => {
    const queueName = `phase-0-failure-${randomUUID()}`;
    const resource = createHealthCheckQueue(process.env.REDIS_URL!, queueName);
    const worker = createHealthCheckWorker(process.env.REDIS_URL!, queueName);
    resources.push(resource);
    workers.push(worker);
    await resource.events.waitUntilReady();

    const job = await resource.queue.add("system.health-check", { message: "invalid" } as never, { attempts: 1 });
    await expect(job.waitUntilFinished(resource.events, 15_000)).rejects.toThrow();

    const failedJob = await resource.queue.getJob(job.id!);
    expect(await failedJob?.getState()).toBe("failed");
    expect(failedJob?.failedReason).toBeTruthy();
  });
});
