import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { assertWorkspaceWrite } from "./workspace-access.js";

const runTables = ["BookAnalysisRun", "PodcastGenerationRun", "AudioGenerationRun", "ShortVideoGenerationRun"] as const;
export async function assertExecutionRunActive(workspaceId: string, runId?: string) {
  if (!runId) return;
  const rows = await prisma.$queryRaw<Array<{ cancelled: boolean }>>(Prisma.join(runTables.map(table => Prisma.sql`SELECT (j."status"='CANCELLED' OR r."errorCode"='USER_CANCELLED') AS cancelled FROM ${Prisma.raw(`"${table}"`)} r JOIN "Job" j ON j."id"=r."jobId" WHERE r."workspaceId"=${workspaceId} AND r."id"=${runId}`), " UNION ALL "));
  if (rows.length !== 1 || rows[0]?.cancelled) throw new Error("EXECUTION_CANCELLED");
}

export async function cancelWorkspaceJob(context: { workspaceId: string; userId: string }, jobId: string) {
  await assertWorkspaceWrite(context);
  return prisma.$transaction(async tx => {
    // Preserve the established run-row -> Job lock order.
    for (const table of runTables) {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "jobId"=${jobId} AND "workspaceId"=${context.workspaceId} FOR UPDATE`);
      if (!rows.length) continue;
      // A role may have changed while this request waited for the run lock.
      // Hold a shared member-row lock through commit so revocation cannot slip
      // between this fresh authorization and the cancellation writes.
      const members = await tx.$queryRaw<Array<{ role: string }>>`SELECT "role" FROM "WorkspaceMember" WHERE "workspaceId"=${context.workspaceId} AND "userId"=${context.userId} FOR SHARE`;
      if (!members[0] || !["OWNER", "EDITOR"].includes(members[0].role)) throw new Error("WORKSPACE_WRITE_DENIED");
      const job = await tx.job.findFirstOrThrow({ where: { id: jobId, workspaceId: context.workspaceId } });
      if (job.status === "CANCELLED") return { status: "CANCELLED" as const };
      if (job.status !== "QUEUED" && job.status !== "RUNNING") throw new Error("OPERATION_ALREADY_TERMINAL");
      await tx.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)} SET "status"='FAILED', "errorCode"='USER_CANCELLED', "completedAt"=NOW(), "executionClaimToken"=NULL, "executionClaimedAt"=NULL, "executionLeaseUntil"=NULL, "dispatchGeneration"=LEAST("dispatchGeneration"::bigint+1,2147483647)::integer WHERE "id"=${rows[0]!.id}`);
      await tx.job.update({ where: { id: jobId }, data: { status: "CANCELLED", completedAt: new Date(), error: { code: "USER_CANCELLED" } } });
      return { status: "CANCELLED" as const };
    }
    throw new Error("CANCELLABLE_OPERATION_NOT_FOUND");
  });
}
