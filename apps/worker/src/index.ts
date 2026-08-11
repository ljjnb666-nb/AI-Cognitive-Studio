import { readEnvironment } from "@ai-cognitive/shared/server";
import { startWorkerRuntime } from "./runtime.js";

const environment = readEnvironment();
const runtime = await startWorkerRuntime(environment);

async function shutdown(signal: string): Promise<void> {
  await runtime.close(signal);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
