import { Prisma } from "@prisma/client";

type Transaction = { $executeRaw(query: Prisma.Sql): Promise<unknown>; job: { count(args: { where: { workspaceId: string; type: { in: string[] }; status: { in: ("QUEUED" | "RUNNING")[] } } }): Promise<number> } };
export const expensiveJobTypes = ["book.analysis", "podcast.generation", "short-video.generation", "podcast.audio-generation"] as const;

/** The domain rearm helpers use this same identity when they reacquire a released slot. */
export type ExpensiveOperationRecoveryTarget = { workspaceId: string; jobId: string; jobType: string };

/** Serialize all capacity-changing mutations for one workspace. */
export async function lockWorkspaceExpensiveOperationCapacity(tx: Pick<Transaction, "$executeRaw">, workspaceId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'phase18-expensive-operation:' + workspaceId}))`);
}

/** Read capacity while holding the same workspace lock used by every admission and recovery path. */
export async function workspaceExpensiveOperationCapacityAvailable(tx: Transaction, workspaceId: string, limit: number): Promise<boolean> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("WORKSPACE_EXPENSIVE_OPERATION_LIMIT_INVALID");
  await lockWorkspaceExpensiveOperationCapacity(tx, workspaceId);
  const active = await tx.job.count({ where: { workspaceId, type: { in: [...expensiveJobTypes] }, status: { in: ["QUEUED", "RUNNING"] } } });
  return active < limit;
}

/** PostgreSQL transaction lock makes the admission count and job creation one atomic decision. */
export async function admitWorkspaceExpensiveOperation(tx: Transaction, workspaceId: string, limit: number): Promise<void> {
  if (!await workspaceExpensiveOperationCapacityAvailable(tx, workspaceId, limit)) throw new Error("WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED");
}
