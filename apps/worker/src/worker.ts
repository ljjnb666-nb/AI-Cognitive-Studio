import { Worker } from "bullmq";
import { AppError, type HealthCheckPayload } from "@ai-cognitive/domain";
import { createRedisConnection, logger } from "@ai-cognitive/shared";
import { HEALTH_CHECK_QUEUE } from "./jobs/health-check.js";
import { processHealthCheck } from "./processors/health-check.js";

export function createHealthCheckWorker(redisUrl: string, queueName = HEALTH_CHECK_QUEUE): Worker<HealthCheckPayload> {
  const connection = createRedisConnection(redisUrl);
  const worker = new Worker<HealthCheckPayload>(
    queueName,
    async (job) => {
      logger.info("queue.job.started", { jobId: job.id, jobType: job.name, status: "RUNNING" });
      const result = processHealthCheck(job.data);
      logger.info("queue.job.succeeded", { jobId: job.id, jobType: job.name, status: "SUCCEEDED" });
      return result;
    },
    { connection },
  );

  worker.on("failed", (job, error) => {
    const appError = error instanceof AppError ? error : undefined;
    logger.error("queue.job.failed", {
      jobId: job?.id,
      jobType: job?.name,
      status: "FAILED",
      code: appError?.code ?? "UNEXPECTED_ERROR",
      retryable: appError?.retryable ?? false,
    });
  });

  return worker;
}
