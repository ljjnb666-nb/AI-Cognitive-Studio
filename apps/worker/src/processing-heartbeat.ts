import { createRedisConnection } from "@ai-cognitive/shared/server";

export const PROCESSING_HEARTBEAT_KEY = "ai-cognitive:worker:processing";
export type ProcessingHeartbeat = { startedAt: string; lastHeartbeatAt: string; version: string; capabilities: { ingestion: boolean; bookAnalysis: boolean; podcastGeneration: boolean; podcastAudio: boolean; shortVideoGeneration: boolean } };
type RedisLike = Pick<ReturnType<typeof createRedisConnection>, "set" | "quit">;

export function startProcessingHeartbeat(redisUrl: string, capabilities: ProcessingHeartbeat["capabilities"], options: { ttlSeconds?: number; intervalMs?: number; now?: () => Date; connection?: RedisLike } = {}) {
  const redis = options.connection ?? createRedisConnection(redisUrl), now = options.now ?? (() => new Date()), startedAt = now().toISOString(), ttlSeconds = options.ttlSeconds ?? 30;
  const beat = () => redis.set(PROCESSING_HEARTBEAT_KEY, JSON.stringify({ version: process.env.npm_package_version ?? "unknown", startedAt, lastHeartbeatAt: now().toISOString(), capabilities }), "EX", ttlSeconds);
  const timer = setInterval(() => { void beat(); }, options.intervalMs ?? 10_000);
  return { beat, async close() { clearInterval(timer); await redis.quit(); } };
}
