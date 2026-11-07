import { describe, expect, it, vi } from "vitest";
vi.mock("../../db/src/index.js", () => ({ prisma: {} }));
import { processConcurrentChunks, validateBookChunkConcurrency } from "../src/chunk-concurrency.js";
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
describe("单书分块并发", () => {
  it.each([0, 5, 1.5, NaN, Infinity])("拒绝无效并发数 %s", value => { expect(() => validateBookChunkConcurrency(value)).toThrow("BOOK_CHUNK_CONCURRENCY_INVALID"); });
  it("并发按设置限流，完成顺序可不同且每块只执行一次", async () => {
    const first = gate(), twoStarted = gate(); let active = 0, maximum = 0;
    const completed: number[] = [];
    const pending = processConcurrentChunks([0, 1, 2, 3], 2, async item => {
      maximum = Math.max(maximum, ++active);
      if (item === 0) await first.promise;
      if (item === 1) twoStarted.release();
      completed.push(item); active--;
    });
    await twoStarted.promise;
    expect(maximum).toBe(2);
    first.release(); await pending;
    expect([...completed].sort()).toEqual([0, 1, 2, 3]);
    expect(completed[0]).toBe(1);
  });
  it("首次失败停止新派发，等待在途成功保存后才向上层报错", async () => {
    const failure = gate(), success = gate(), entered = gate(), failed = gate(); const started: number[] = [], saved: number[] = [];
    let settled = false;
    const pending = processConcurrentChunks([0, 1, 2, 3], 2, async item => {
      started.push(item);
      if (item === 0) { await failure.promise; failed.release(); throw new Error("CONTENT_REJECTED"); }
      entered.release(); await success.promise; saved.push(item);
    }).then(() => { settled = true; return "ok"; }, error => { settled = true; return (error as Error).message; });
    await entered.promise; failure.release(); await failed.promise;
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false); expect(started).toEqual([0, 1]);
    success.release(); expect(await pending).toBe("CONTENT_REJECTED");
    expect(saved).toEqual([1]); expect(started).toEqual([0, 1]);
  });
  it("串行模式及空列表不会启动多余工作", async () => {
    let active = 0;
    await processConcurrentChunks([1, 2, 3], 1, async () => { expect(++active).toBe(1); await Promise.resolve(); active--; });
    const work = vi.fn(); await processConcurrentChunks([], 4, work); expect(work).not.toHaveBeenCalled();
  });
});
