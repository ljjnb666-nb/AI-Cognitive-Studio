import { prisma } from "../../db/src/index.js";

export function validateBookChunkConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error("BOOK_CHUNK_CONCURRENCY_INVALID");
  return value;
}

/** 每次执行只读取一次；修改设置不改变已经在途的请求。 */
export async function workspaceBookChunkConcurrency(input: { workspaceId: string }): Promise<number> {
  const [policy] = await prisma.$queryRaw<Array<{ bookChunkConcurrency: number }>>`SELECT "bookChunkConcurrency" FROM "WorkspaceResourcePolicy" WHERE "workspaceId"=${input.workspaceId}`;
  return validateBookChunkConcurrency(policy?.bookChunkConcurrency ?? 2);
}

/** 首次失败即停止领取新工作，等待所有在途工作保存结果后再抛出错误。 */
export async function processConcurrentChunks<T>(items: readonly T[], concurrency: number, process: (item: T, stopped: () => boolean) => Promise<void>): Promise<void> {
  validateBookChunkConcurrency(concurrency);
  let cursor = 0, failed = false;
  let firstError: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const item = items[cursor++]!;
      try { await process(item, () => failed); }
      catch (error) { if (!failed) { failed = true; firstError = error; } }
    }
  }));
  if (failed) throw firstError;
}
