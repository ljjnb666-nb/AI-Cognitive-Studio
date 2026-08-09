import { Queue, QueueEvents, type JobsOptions, type Worker } from "bullmq";
import type IORedis from "ioredis";
import { createRedisConnection, logger } from "@ai-cognitive/shared";
import type { HealthCheckPayload } from "@ai-cognitive/domain";
import { HEALTH_CHECK_JOB, HEALTH_CHECK_QUEUE } from "./jobs/health-check.js";

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 250 },
  removeOnComplete: 100,
  removeOnFail: 100,
};

export function createHealthCheckQueue(redisUrl: string, queueName = HEALTH_CHECK_QUEUE): {
  queue: Queue<HealthCheckPayload>;
  events: QueueEvents;
  connection: IORedis;
} {
  const connection = createRedisConnection(redisUrl);
  return {
    queue: new Queue<HealthCheckPayload>(queueName, { connection, defaultJobOptions }),
    events: new QueueEvents(queueName, { connection: createRedisConnection(redisUrl) }),
    connection,
  };
}

export async function enqueueHealthCheck(
  queue: Queue<HealthCheckPayload>,
  payload: HealthCheckPayload = { message: "phase-0" },
) {
  const job = await queue.add(HEALTH_CHECK_JOB, payload);
  logger.info("queue.job.enqueued", { jobId: job.id, jobType: HEALTH_CHECK_JOB, status: "QUEUED" });
  return job;
}

export async function closeQueueResources(
  queue: Queue,
  events: QueueEvents,
  connection: IORedis,
  worker?: Worker,
): Promise<void> {
  await worker?.close();
  await events.close();
  await queue.close();
  await connection.quit();
}
