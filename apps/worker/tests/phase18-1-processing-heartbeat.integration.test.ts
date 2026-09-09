import { describe, expect, it, vi } from "vitest";
import { PROCESSING_HEARTBEAT_KEY, startProcessingHeartbeat } from "../src/processing-heartbeat.js";
import { createRedisConnection } from "@ai-cognitive/shared/server";

describe("Phase 18.1 processing heartbeat", () => {
  it("writes only safe capability metadata with a TTL and closes its connection", async () => {
    const set = vi.fn(async () => "OK"), quit = vi.fn(async () => "OK"), heartbeat = startProcessingHeartbeat("redis://test", { ingestion: true, bookAnalysis: true, podcastGeneration: false, podcastAudio: false, shortVideoGeneration: false }, { connection: { set, quit } as never, intervalMs: 60_000, now: () => new Date("2026-01-01T00:00:00.000Z") });
    await heartbeat.beat(); await heartbeat.close();
    expect(set).toHaveBeenCalledWith(PROCESSING_HEARTBEAT_KEY, expect.stringContaining('"bookAnalysis":true'), "EX", 30);
    expect((set.mock.calls as unknown as Array<[string, string]>)[0]![1]).not.toContain("credential");
    expect(quit).toHaveBeenCalledOnce();
  });
  it("expires a stopped worker heartbeat", async () => {
    const redis = createRedisConnection(process.env.REDIS_URL!);
    try {
      await redis.set(PROCESSING_HEARTBEAT_KEY, "safe", "EX", 1);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(await redis.get(PROCESSING_HEARTBEAT_KEY)).toBeNull();
    } finally { await redis.quit(); }
  });
});
