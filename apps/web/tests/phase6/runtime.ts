import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startPhase6Runtime } from "./global-setup.js";

async function main() {
  const runtime = await startPhase6Runtime();
  const readyFile = process.env.PHASE6_RUNTIME_READY_FILE;
  if (!readyFile) throw new Error("PHASE6_RUNTIME_READY_FILE_REQUIRED");
  await mkdir(join(readyFile, ".."), { recursive: true });
  await writeFile(readyFile, "ready", "utf8");
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal = "phase6-runtime") => shutdownPromise ??= runtime.close(signal).then(() => { if (process.send) process.send({ type: "PHASE6_RUNTIME_SHUTDOWN_COMPLETE" }); process.exit(0); });
  process.on("message", (message: unknown) => { if (typeof message === "object" && message !== null && "type" in message && message.type === "PHASE6_RUNTIME_SHUTDOWN") void shutdown("phase6-parent"); });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
