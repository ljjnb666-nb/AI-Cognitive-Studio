import { logger } from "@ai-cognitive/shared";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { createHealthCheckWorker } from "./worker.js";
import { createSourceIngestionWorker, dispatchSourceIngestion } from "./source-ingestion.js";
import { createBookAnalysisWorker, dispatchBookAnalysis } from "./book-analysis.js";

const environment = readEnvironment();
const worker = createHealthCheckWorker(environment.REDIS_URL);
const ingestionWorker = createSourceIngestionWorker(environment);
const bookAnalysisWorker = process.env.BOOK_ANALYSIS_PROVIDER ? createBookAnalysisWorker(environment) : undefined;
const dispatchTimer = setInterval(() => void dispatchSourceIngestion(environment), 1000);
const bookDispatchTimer = bookAnalysisWorker ? setInterval(() => void dispatchBookAnalysis(environment), 1000) : undefined;
void dispatchSourceIngestion(environment);
if (bookAnalysisWorker) void dispatchBookAnalysis(environment);

async function shutdown(signal: string): Promise<void> {
  logger.info("worker.shutdown.started", { signal });
  await worker.close();
  clearInterval(dispatchTimer);
  if (bookDispatchTimer) clearInterval(bookDispatchTimer);
  await ingestionWorker.close();
  await bookAnalysisWorker?.close();
  logger.info("worker.shutdown.completed", { signal });
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

logger.info("worker.started", { queue: "system.health-check" });
