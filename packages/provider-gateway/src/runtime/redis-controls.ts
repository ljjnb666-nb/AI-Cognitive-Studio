import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { ProviderGatewayError } from "../errors.js";

export class RedisRateLimiter {
  constructor(private readonly redis: Redis) {}
  async admit(key: string, limit: number, windowSeconds: number): Promise<void> { const bucket = `provider-gateway:rate:${key}:${Math.floor(Date.now() / (windowSeconds * 1_000))}`; const count = await this.redis.incr(bucket); if (count === 1) await this.redis.expire(bucket, windowSeconds); if (count > limit) throw new ProviderGatewayError("RATE_LIMITED"); }
}

export type ConcurrencyLease = { key: string; token: string };
const acquireLua = "local c=redis.call('GET',KEYS[1]); if c then local n=tonumber(c); if n>=tonumber(ARGV[1]) then return 0 end end; redis.call('INCR',KEYS[1]); redis.call('PEXPIRE',KEYS[1],ARGV[2]); redis.call('SET',KEYS[2],ARGV[3],'PX',ARGV[2],'NX'); return 1";
const releaseLua = "if redis.call('GET',KEYS[2])==ARGV[1] then redis.call('DEL',KEYS[2]); local c=redis.call('GET',KEYS[1]); if c and tonumber(c)>0 then redis.call('DECR',KEYS[1]) end return 1 end return 0";
export class RedisConcurrencyLimiter {
  constructor(private readonly redis: Redis) {}
  async acquire(key: string, limit: number, leaseMs: number): Promise<ConcurrencyLease> { const token = randomUUID(); const admitted = await this.redis.eval(acquireLua, 2, `provider-gateway:concurrency:${key}`, `provider-gateway:concurrency-lease:${key}:${token}`, limit, leaseMs, token); if (admitted !== 1) throw new ProviderGatewayError("RATE_LIMITED", "Provider concurrency limit reached"); return { key, token }; }
  async release(lease: ConcurrencyLease): Promise<boolean> { return (await this.redis.eval(releaseLua, 2, `provider-gateway:concurrency:${lease.key}`, `provider-gateway:concurrency-lease:${lease.key}:${lease.token}`, lease.token)) === 1; }
}

type CircuitState = { failures: number; openedUntil: number };
export class RedisCircuitBreaker {
  constructor(private readonly redis: Redis) {}
  async admit(key: string, threshold: number, cooldownMs: number): Promise<void> { const state = JSON.parse((await this.redis.get(`provider-gateway:circuit:${key}`)) ?? "{\"failures\":0,\"openedUntil\":0}") as CircuitState; if (state.openedUntil > Date.now()) throw new ProviderGatewayError("CIRCUIT_OPEN"); if (state.openedUntil !== 0) { const probe = await this.redis.set(`provider-gateway:circuit-probe:${key}`, "1", "PX", cooldownMs, "NX"); if (probe !== "OK") throw new ProviderGatewayError("CIRCUIT_OPEN"); } await this.redis.set(`provider-gateway:circuit-threshold:${key}`, String(threshold), "PX", cooldownMs); }
  async recordSuccess(key: string): Promise<void> { await this.redis.del(`provider-gateway:circuit:${key}`, `provider-gateway:circuit-probe:${key}`); }
  async recordRetryableFailure(key: string, threshold: number, cooldownMs: number): Promise<void> { const current = JSON.parse((await this.redis.get(`provider-gateway:circuit:${key}`)) ?? "{\"failures\":0,\"openedUntil\":0}") as CircuitState; const failures = current.failures + 1; const state: CircuitState = { failures, openedUntil: failures >= threshold ? Date.now() + cooldownMs : 0 }; await this.redis.set(`provider-gateway:circuit:${key}`, JSON.stringify(state), "PX", Math.max(cooldownMs, 60_000)); }
}
