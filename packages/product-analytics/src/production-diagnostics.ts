import { prisma } from "@ai-cognitive/db";

export type WorkspaceDiagnosticIdentity = { userId: string; workspaceId: string };
export type SafeJobDiagnostic = { id: string; type: string; state: string; ageMs: number; attempts: number; failureCode: string | null; stuck: boolean };
const safeFailureCodes = new Set(["PROVIDER_TIMEOUT", "AUTHENTICATION_FAILED", "AUTHORIZATION_FAILED", "RATE_LIMITED", "BUDGET_EXCEEDED", "ROUTE_UNAVAILABLE", "CONNECTION_DISABLED", "CREDENTIAL_REVOKED", "WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED", "OUTBOX_MAX_ATTEMPTS_EXCEEDED"]);
function safeFailureCode(error: unknown): string | null { const code = error && typeof error === "object" && !Array.isArray(error) ? (error as { code?: unknown }).code : undefined; return typeof code === "string" && safeFailureCodes.has(code) ? code : code ? "OPERATION_FAILED" : null; }

/** Tenant-scoped operator data: payloads, error bodies, credentials and source content are intentionally never selected. */
export async function workspaceProductionDiagnostics(identity: WorkspaceDiagnosticIdentity, now = new Date()) {
  const membership = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: identity } });
  if (!membership) throw new Error("WORKSPACE_ACCESS_DENIED");
  const [jobs, counts] = await Promise.all([
    prisma.job.findMany({ where: { workspaceId: identity.workspaceId, OR: [{ status: { in: ["QUEUED", "RUNNING"] } }, { status: "FAILED", updatedAt: { gte: new Date(now.getTime() - 86400000) } }] }, orderBy: { createdAt: "asc" }, take: 100, select: { id: true, type: true, status: true, createdAt: true, startedAt: true, updatedAt: true, attemptCount: true, error: true, bookAnalysisRun: { select: { executionLeaseUntil: true } }, podcastGenerationRun: { select: { executionLeaseUntil: true } }, audioGenerationRun: { select: { executionLeaseUntil: true } }, shortVideoGenerationRun: { select: { executionLeaseUntil: true } }, ingestionRun: { select: { executionLeaseUntil: true } } } }),
    prisma.job.groupBy({ by: ["status"], where: { workspaceId: identity.workspaceId }, _count: { _all: true } }),
  ]);
  return {
    queue: { queued: counts.find(row => row.status === "QUEUED")?._count._all ?? 0, running: counts.find(row => row.status === "RUNNING")?._count._all ?? 0, failed: counts.find(row => row.status === "FAILED")?._count._all ?? 0 },
    jobs: jobs.map((job): SafeJobDiagnostic => {
      const ageMs = now.getTime() - (job.startedAt ?? job.createdAt).getTime();
      const lease = job.bookAnalysisRun?.executionLeaseUntil ?? job.podcastGenerationRun?.executionLeaseUntil ?? job.audioGenerationRun?.executionLeaseUntil ?? job.shortVideoGenerationRun?.executionLeaseUntil ?? job.ingestionRun?.executionLeaseUntil;
      const stuck = job.status === "QUEUED" ? ageMs > 15 * 60000 : job.status === "RUNNING" && (lease ? lease < now : now.getTime() - job.updatedAt.getTime() > 15 * 60000);
      return { id: job.id, type: job.type, state: job.status, ageMs, attempts: job.attemptCount, failureCode: safeFailureCode(job.error), stuck };
    }),
  };
}
