import { readEnvironment } from "@ai-cognitive/shared/server";
import { startWorkerRuntime } from "./runtime.js";

const environment = readEnvironment();
let runtime: Awaited<ReturnType<typeof startWorkerRuntime>> | undefined;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (runtime) await runtime.close(signal);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

runtime = await startWorkerRuntime(environment);
