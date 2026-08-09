import { logger } from "@ai-cognitive/shared";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { createHealthCheckWorker } from "./worker.js";
import { createSourceIngestionWorker, dispatchSourceIngestion } from "./source-ingestion.js";

const environment = readEnvironment();
const worker = createHealthCheckWorker(environment.REDIS_URL);
const ingestionWorker = createSourceIngestionWorker(environment);
const dispatchTimer = setInterval(() => void dispatchSourceIngestion(environment), 1000);
void dispatchSourceIngestion(environment);

async function shutdown(signal: string): Promise<void> {
  logger.info("worker.shutdown.started", { signal });
  await worker.close();
  clearInterval(dispatchTimer);
  await ingestionWorker.close();
  logger.info("worker.shutdown.completed", { signal });
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

logger.info("worker.started", { queue: "system.health-check" });
