import { prisma } from "@ai-cognitive/db";

export type WorkspaceDiagnosticIdentity = { userId: string; workspaceId: string };
export type SafeJobDiagnostic = { id: string; type: string; state: string; ageMs: number; attempts: number; failureCode: string | null; stuck: boolean };

/** Tenant-scoped operator data: payloads, error bodies, credentials and source content are intentionally never selected. */
export async function workspaceProductionDiagnostics(identity: WorkspaceDiagnosticIdentity, now = new Date()) {
  const membership = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: identity } });
  if (!membership) throw new Error("WORKSPACE_ACCESS_DENIED");
  const jobs = await prisma.job.findMany({ where: { workspaceId: identity.workspaceId }, orderBy: { createdAt: "asc" }, take: 100, select: { id: true, type: true, status: true, createdAt: true, startedAt: true, attemptCount: true, error: true } });
  const active = jobs.filter((job) => job.status === "QUEUED" || job.status === "RUNNING");
  return {
    queue: { queued: jobs.filter((job) => job.status === "QUEUED").length, running: jobs.filter((job) => job.status === "RUNNING").length, failed: jobs.filter((job) => job.status === "FAILED").length },
    jobs: active.map((job): SafeJobDiagnostic => {
      const ageMs = now.getTime() - (job.startedAt ?? job.createdAt).getTime();
      const error = job.error && typeof job.error === "object" && !Array.isArray(job.error) ? job.error as { code?: unknown } : undefined;
      return { id: job.id, type: job.type, state: job.status, ageMs, attempts: job.attemptCount, failureCode: typeof error?.code === "string" ? error.code.slice(0, 96) : null, stuck: ageMs > 15 * 60_000 };
    }),
  };
}
