import { logger } from "@ai-cognitive/shared";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { createHealthCheckWorker } from "./worker.js";

const environment = readEnvironment();
const worker = createHealthCheckWorker(environment.REDIS_URL);

async function shutdown(signal: string): Promise<void> {
  logger.info("worker.shutdown.started", { signal });
  await worker.close();
  logger.info("worker.shutdown.completed", { signal });
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

logger.info("worker.started", { queue: "system.health-check" });
