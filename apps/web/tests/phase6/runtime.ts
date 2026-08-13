import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startPhase6Runtime } from "./global-setup.js";

async function main() {
  const runtime = await startPhase6Runtime();
  const readyFile = process.env.PHASE6_RUNTIME_READY_FILE;
  if (!readyFile) throw new Error("PHASE6_RUNTIME_READY_FILE_REQUIRED");
  await mkdir(join(readyFile, ".."), { recursive: true });
  await writeFile(readyFile, "ready", "utf8");
  const shutdown = async () => { await runtime.close("phase6-runtime"); process.exit(0); };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
