import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startPhase6Runtime } from "../phase6/global-setup.js";
import { createPhase7BookAnalysisEmbeddingGateway } from "./book-analysis-gateway.js";

async function main() {
  const runtime = await startPhase6Runtime({ bookEmbeddingGateway: createPhase7BookAnalysisEmbeddingGateway(), phase6Identity: false });
  const readyFile = process.env.PHASE7_RUNTIME_READY_FILE;
  if (!readyFile) throw new Error("PHASE7_RUNTIME_READY_FILE_REQUIRED");
  await mkdir(join(readyFile, ".."), { recursive: true });
  await writeFile(readyFile, "ready", "utf8");
  const close = async () => { await runtime.close("phase7-runtime"); process.exit(0); };
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
}
void main().catch((error) => { console.error(error); process.exit(1); });
