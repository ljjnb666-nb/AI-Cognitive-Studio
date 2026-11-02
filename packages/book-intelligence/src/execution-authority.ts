import { prisma } from "../../db/src/index.js";

export type BookAuthorityTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export type BookExecutionContext = { analysisRunId: string; jobId: string; dispatchGeneration: number; claimToken: string; userId: string; workspaceId: string };
export const BOOK_PAID_GRANT_TYPE = "BOOK_ANALYSIS_PAID_AUTHORIZATION_V1";

/** Lock order is Run -> execution Job -> grant Job. All are existing identities. */
export async function assertBookJobAuthority(tx: BookAuthorityTransaction, runId: string, allowed: readonly string[] = ["RUNNING"]) {
  await tx.$queryRaw`SELECT "id" FROM "BookAnalysisRun" WHERE "id"=${runId} FOR UPDATE`;
  const run = await tx.bookAnalysisRun.findUniqueOrThrow({ where: { id: runId } });
  await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${run.jobId} FOR UPDATE`;
  const job = await tx.job.findUniqueOrThrow({ where: { id: run.jobId } });
  if (job.workspaceId !== run.workspaceId || !allowed.includes(job.status)) throw new Error("BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST");
  const grantId = (job.payload as { bookPaidGrantId?: unknown } | null)?.bookPaidGrantId;
  if (grantId !== undefined) {
    if (typeof grantId !== "string") throw new Error("BOOK_PAID_EXECUTION_DENIED");
    await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${grantId} FOR UPDATE`;
    const grant = await tx.job.findUniqueOrThrow({ where: { id: grantId } });
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const p = grant.payload as { binding?: { analysisRunId: string; jobId: string; dispatchGeneration: number }; sourceDocumentId?: string; extractionId?: string; stopped?: boolean; expiresAt?: string };
    if ((grant.payload as { version?: number }).version !== 1 || grant.type !== BOOK_PAID_GRANT_TYPE || grant.status !== "RUNNING" || grant.workspaceId !== run.workspaceId || !job.userId || grant.userId !== job.userId || p.stopped || !p.expiresAt || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= clock!.now.getTime() || p.sourceDocumentId !== run.sourceDocumentId || p.extractionId !== run.extractionId || p.binding?.analysisRunId !== run.id || p.binding.jobId !== run.jobId || p.binding.dispatchGeneration !== run.dispatchGeneration) throw new Error("BOOK_PAID_EXECUTION_DENIED");
    await tx.$queryRaw`SELECT "userId" FROM "WorkspaceMember" WHERE "workspaceId"=${run.workspaceId} AND "userId"=${job.userId} FOR SHARE`;
    const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: run.workspaceId, userId: job.userId } } });
    const current = await tx.currentDocumentExtraction.findUnique({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: run.sourceDocumentId, workspaceId: run.workspaceId } } });
    const doc = await tx.sourceDocument.findFirst({ where: { id: run.sourceDocumentId, workspaceId: run.workspaceId, source: { archivedAt: null } } });
    if (!member || member.role === "VIEWER" || current?.extractionId !== run.extractionId || !doc || (grant.payload as { sha256?: string }).sha256 !== doc.sha256) throw new Error("BOOK_PAID_EXECUTION_DENIED");
  }
  return { run, job, grantId: typeof grantId === "string" ? grantId : undefined };
}

/** Recheck lease after every authority lock has been acquired, using database time. */
export async function assertBookOwnedAuthority(tx: BookAuthorityTransaction, runId: string, claimToken: string) {
  const state = await assertBookJobAuthority(tx, runId);
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (state.run.status !== "RUNNING" || state.run.executionClaimToken !== claimToken || !state.run.executionLeaseUntil || state.run.executionLeaseUntil.getTime() <= clock!.now.getTime()) throw new Error("BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST");
  return state;
}

export async function assertBookExecutionAuthority(tx: BookAuthorityTransaction, context: BookExecutionContext) {
  const state = await assertBookOwnedAuthority(tx, context.analysisRunId, context.claimToken);
  const { run, job } = state;
  if (run.workspaceId !== context.workspaceId || job.userId !== context.userId || run.jobId !== context.jobId || run.dispatchGeneration !== context.dispatchGeneration) throw new Error("BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST");
  return state;
}
