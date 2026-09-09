import { Prisma } from "@prisma/client";

type Transaction = { $executeRaw(query: Prisma.Sql): Promise<unknown>; job: { count(args: { where: { workspaceId: string; status: { in: ("QUEUED" | "RUNNING")[] } } }): Promise<number> } };

/** PostgreSQL transaction lock makes the admission count and job creation one atomic decision. */
export async function admitWorkspaceExpensiveOperation(tx: Transaction, workspaceId: string, limit: number): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("WORKSPACE_EXPENSIVE_OPERATION_LIMIT_INVALID");
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${'phase18-expensive-operation:' + workspaceId}))`);
  const active = await tx.job.count({ where: { workspaceId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (active >= limit) throw new Error("WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED");
}
