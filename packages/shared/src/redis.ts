import IORedis from "ioredis";

export function createRedisConnection(redisUrl: string): IORedis {
  return new IORedis(redisUrl, {
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
  });
}
