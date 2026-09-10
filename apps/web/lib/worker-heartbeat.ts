import { createRedisConnection } from "@ai-cognitive/shared/server";
import type { ProcessingWorkerAvailability, WorkerAvailability } from "./processing-state";

export const PROCESSING_HEARTBEAT_KEY = "ai-cognitive:worker:processing";
const capabilities = ["ingestion", "bookAnalysis", "podcastGeneration", "podcastAudio", "shortVideoGeneration"] as const;
function unavailable(value: WorkerAvailability): ProcessingWorkerAvailability { return Object.fromEntries(capabilities.map((capability) => [capability, value])) as ProcessingWorkerAvailability; }

/** Treat Redis as untrusted input: only complete boolean capability records are usable. */
export function processingAvailabilityFromHeartbeat(raw: string | null): ProcessingWorkerAvailability {
  if (!raw) return unavailable("DEGRADED");
  try {
    const value = JSON.parse(raw) as { capabilities?: unknown }, record = value.capabilities;
    if (!record || typeof record !== "object" || !capabilities.every((capability) => typeof (record as Record<string, unknown>)[capability] === "boolean")) return unavailable("UNKNOWN");
    return Object.fromEntries(capabilities.map((capability) => [capability, (record as Record<string, boolean>)[capability] ? "AVAILABLE" : "DEGRADED"])) as ProcessingWorkerAvailability;
  } catch { return unavailable("UNKNOWN"); }
}
export async function processingWorkerAvailability(redisUrl = process.env.REDIS_URL): Promise<ProcessingWorkerAvailability> {
  if (!redisUrl) return unavailable("UNKNOWN");
  const redis = createRedisConnection(redisUrl);
  try { return processingAvailabilityFromHeartbeat(await redis.get(PROCESSING_HEARTBEAT_KEY)); }
  catch { return unavailable("UNKNOWN"); }
  finally { await redis.quit().catch(() => undefined); }
}
