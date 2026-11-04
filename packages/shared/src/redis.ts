import { Redis } from "ioredis";

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
  });
}

/** Probe clients must not inherit BullMQ's unlimited retry semantics. */
export function createRedisProbeConnection(redisUrl: string, timeoutMs = 1500): Redis {
  const client = new Redis(redisUrl, { lazyConnect: true, connectTimeout: timeoutMs, commandTimeout: timeoutMs, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
  client.on("error", () => undefined);
  return client;
}
