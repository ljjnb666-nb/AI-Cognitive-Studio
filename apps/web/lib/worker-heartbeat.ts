import { createRedisConnection } from "@ai-cognitive/shared/server";
import type { WorkerAvailability } from "./processing-state";

export const PROCESSING_HEARTBEAT_KEY = "ai-cognitive:worker:processing";
export async function processingWorkerAvailability(redisUrl = process.env.REDIS_URL): Promise<WorkerAvailability> {
  if (!redisUrl) return "UNKNOWN";
  const redis = createRedisConnection(redisUrl);
  try { return await redis.get(PROCESSING_HEARTBEAT_KEY) ? "AVAILABLE" : "DEGRADED"; }
  catch { return "UNKNOWN"; }
  finally { await redis.quit().catch(() => undefined); }
}
