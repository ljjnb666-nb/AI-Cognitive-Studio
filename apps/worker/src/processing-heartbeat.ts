import { createRedisConnection } from "@ai-cognitive/shared/server";

export const PROCESSING_HEARTBEAT_KEY = "ai-cognitive:worker:processing";
export type ProcessingHeartbeat = { startedAt: string; lastHeartbeatAt: string; version: string; capabilities: { ingestion: boolean; bookAnalysis: boolean; podcastGeneration: boolean; podcastAudio: boolean; shortVideoGeneration: boolean } };
type RedisLike = Pick<ReturnType<typeof createRedisConnection>, "set" | "quit">;

export function startProcessingHeartbeat(redisUrl: string, capabilities: ProcessingHeartbeat["capabilities"], options: { ttlSeconds?: number; intervalMs?: number; now?: () => Date; connection?: RedisLike; onError?: (error: unknown) => void } = {}) {
  const redis = options.connection ?? createRedisConnection(redisUrl), now = options.now ?? (() => new Date()), startedAt = now().toISOString(), ttlSeconds = options.ttlSeconds ?? 30;
  const beat = () => redis.set(PROCESSING_HEARTBEAT_KEY, JSON.stringify({ version: process.env.npm_package_version ?? "unknown", startedAt, lastHeartbeatAt: now().toISOString(), capabilities }), "EX", ttlSeconds);
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* diagnostic callbacks cannot affect the worker */ } };
  const timer = setInterval(() => { void beat().catch(report); }, options.intervalMs ?? 10_000);
  let closed = false;
  return { beat, async close() { if (closed) return; closed = true; clearInterval(timer); await redis.quit().catch(report); } };
}
