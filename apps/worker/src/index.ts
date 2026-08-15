import { readEnvironment } from "@ai-cognitive/shared/server";
import { startWorkerRuntime } from "./runtime.js";

const environment = readEnvironment();
const runtimePromise = startWorkerRuntime(environment);
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const runtime = await runtimePromise;
  await runtime.close(signal);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
