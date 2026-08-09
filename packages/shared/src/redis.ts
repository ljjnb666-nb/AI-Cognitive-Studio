import { Redis } from "ioredis";

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
  });
}
