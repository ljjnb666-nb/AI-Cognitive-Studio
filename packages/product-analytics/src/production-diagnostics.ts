import { prisma } from "@ai-cognitive/db";

export type WorkspaceDiagnosticIdentity = { userId: string; workspaceId: string };
export type SafeJobDiagnostic = { id: string; type: string; state: string; ageMs: number; attempts: number; failureCode: string | null; stuck: boolean };
const safeFailureCodes = new Set(["PROVIDER_TIMEOUT", "AUTHENTICATION_FAILED", "AUTHORIZATION_FAILED", "RATE_LIMITED", "BUDGET_EXCEEDED", "ROUTE_UNAVAILABLE", "CONNECTION_DISABLED", "CREDENTIAL_REVOKED", "WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED", "OUTBOX_MAX_ATTEMPTS_EXCEEDED"]);
function safeFailureCode(error: unknown): string | null { const code = error && typeof error === "object" && !Array.isArray(error) ? (error as { code?: unknown }).code : undefined; return typeof code === "string" && safeFailureCodes.has(code) ? code : code ? "OPERATION_FAILED" : null; }

/** Tenant-scoped operator data: payloads, error bodies, credentials and source content are intentionally never selected. */
export async function workspaceProductionDiagnostics(identity: WorkspaceDiagnosticIdentity, now = new Date()) {
  const membership = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: identity } });
  if (!membership) throw new Error("WORKSPACE_ACCESS_DENIED");
  const jobs = await prisma.job.findMany({ where: { workspaceId: identity.workspaceId }, orderBy: { createdAt: "asc" }, take: 100, select: { id: true, type: true, status: true, createdAt: true, startedAt: true, attemptCount: true, error: true } });
  return {
    queue: { queued: jobs.filter((job) => job.status === "QUEUED").length, running: jobs.filter((job) => job.status === "RUNNING").length, failed: jobs.filter((job) => job.status === "FAILED").length },
    jobs: jobs.map((job): SafeJobDiagnostic => {
      const ageMs = now.getTime() - (job.startedAt ?? job.createdAt).getTime();
      return { id: job.id, type: job.type, state: job.status, ageMs, attempts: job.attemptCount, failureCode: safeFailureCode(job.error), stuck: ageMs > 15 * 60_000 };
    }),
  };
}
