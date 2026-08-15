import { Queue } from "bullmq";
import { createRedisConnection } from "@ai-cognitive/shared/server";
import { expect, test } from "vitest";

const cadence = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("producer queue create-close and reuse have equivalent Redis lifecycle", async () => {
  const url = new URL(process.env.REDIS_URL!); url.pathname = "/14";
  const redisUrl = url.toString();
  const control = createRedisConnection(redisUrl);
  const baseline = (await control.call("CLIENT", "LIST") as string).split("\n").filter(Boolean).length;
  const result: Array<{ name: string; operations: number; errors: number; reconnects: number; baseline: number; final: number }> = [];
  try {
    await control.ping(); await control.flushdb();
    for (const [name, reuse, interval] of [["A1", false, 0], ["A2", false, 250], ["B1", true, 0], ["B2", true, 250]] as const) {
      let queue: Queue | undefined, connection: ReturnType<typeof createRedisConnection> | undefined, errors = 0, reconnects = 0, operations = 0;
      for (let index = 0; index < 50; index++) {
        const began = Date.now();
        if (!reuse || !queue) { connection = createRedisConnection(redisUrl); connection.on("error", () => errors++); connection.on("reconnecting", () => reconnects++); queue = new Queue(`phase7-churn-${name}`, { connection }); await queue.waitUntilReady(); }
        await queue.getJobCounts(); operations++;
        if (!reuse) { await queue.close(); queue = undefined; }
        if (interval) await cadence(Math.max(0, interval - (Date.now() - began)));
      }
      if (queue) await queue.close();
      const final = (await control.call("CLIENT", "LIST") as string).split("\n").filter(Boolean).length;
      result.push({ name, operations, errors, reconnects, baseline, final });
    }
    expect(result.map(({ operations, errors, reconnects }) => ({ operations, errors, reconnects }))).toEqual(Array.from({ length: 4 }, () => ({ operations: 50, errors: 0, reconnects: 0 })));
    expect(result.map((entry) => entry.final - entry.baseline)).toEqual([50, 100, 101, 102]);
  } finally { await control.flushdb(); await control.quit(); }
}, 180_000);
