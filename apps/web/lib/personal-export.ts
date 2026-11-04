import "server-only";
import { prisma, Prisma } from "@ai-cognitive/db";

const MAX_ROWS = 10_000;
const MAX_BYTES = 20 * 1024 * 1024;

/** Account-owned records only. Shared workspace files and provider/auth secrets are excluded. */
export async function exportPersonalRecords(userId: string): Promise<string> {
  return prisma.$transaction(async tx => {
    const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`personal-export:${userId}`}, 0)) AS acquired`;
    if (!lock?.acquired) throw new Error("PERSONAL_EXPORT_BUSY");
    // Measure only exported columns inside the same snapshot before transferring
    // potentially oversized text/JSON into the Node process. Keep the final exact
    // UTF-8 envelope check below as well.
    const [size] = await tx.$queryRaw<Array<{ bytes: string }>>(Prisma.sql`
      SELECT SUM(bytes)::text AS bytes FROM (${Prisma.join([
      Prisma.sql`SELECT COALESCE(SUM(octet_length(row_to_json(selected)::text)),0) AS bytes FROM (SELECT r."id", r."email", r."name", r."emailVerified", r."createdAt", r."updatedAt" FROM "User" r WHERE r."id"=${userId}) selected`,
      Prisma.sql`SELECT COALESCE(SUM(octet_length(row_to_json(selected)::text)),0) AS bytes FROM (SELECT r."workspaceId", r."role" FROM "WorkspaceMember" r WHERE r."userId"=${userId}) selected`,
      Prisma.sql`SELECT COALESCE(SUM(octet_length(row_to_json(selected)::text)),0) AS bytes FROM (SELECT r."id", r."workspaceId", r."memoryItemId", r."state", r."createdAt", r."updatedAt" FROM "UserCognitionState" r WHERE r."userId"=${userId}) selected`,
      Prisma.sql`SELECT COALESCE(SUM(octet_length(row_to_json(selected)::text)),0) AS bytes FROM (SELECT r."id", r."workspaceId", r."memoryItemId", r."reviewCount", r."lastReviewedAt", r."nextReviewAt", r."lastMasteryState", r."lastMasteryAssessedAt" FROM "UserCognitionReviewState" r WHERE r."userId"=${userId}) selected`,
      Prisma.sql`SELECT COALESCE(SUM(octet_length(row_to_json(selected)::text)),0) AS bytes FROM (SELECT r."id", r."workspaceId", r."memoryItemId", r."kind", r."createdAt" FROM "UserCognitionReviewEvent" r WHERE r."userId"=${userId}) selected`,
      Prisma.sql`SELECT COALESCE(SUM(octet_length(row_to_json(selected)::text)),0) AS bytes FROM (SELECT r."id", r."workspaceId", r."memoryItemId", r."status", r."createdAt", r."updatedAt", r."completedAt" FROM "ThinkingSession" r WHERE r."userId"=${userId}) selected`,
      Prisma.sql`SELECT COALESCE(SUM(octet_length(row_to_json(selected)::text)),0) AS bytes FROM (SELECT r."id", r."sessionId", r."role", r."content", r."ordinal", r."createdAt" FROM "ThinkingSessionMessage" r JOIN "ThinkingSession" p ON p."id"=r."sessionId" WHERE p."userId"=${userId}) selected`,
      Prisma.sql`SELECT COALESCE(SUM(octet_length(row_to_json(selected)::text)),0) AS bytes FROM (SELECT r."id", r."workspaceId", r."memoryItemId", r."content", r."status", r."createdAt", r."updatedAt", r."assessedAt" FROM "TeachBackAttempt" r WHERE r."userId"=${userId}) selected`,
      Prisma.sql`SELECT COALESCE(SUM(octet_length(row_to_json(selected)::text)),0) AS bytes FROM (SELECT r."id", r."attemptId", r."masteryState", r."rubric", r."feedback", r."nextPrompt", r."createdAt" FROM "TeachBackAssessment" r JOIN "TeachBackAttempt" p ON p."id"=r."attemptId" WHERE p."userId"=${userId}) selected`
      ], " UNION ALL ")}) sections`);
    const estimatedBytes = Number(size?.bytes);
    if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0) throw new Error("PERSONAL_EXPORT_SIZE_UNAVAILABLE");
    if (estimatedBytes > MAX_BYTES) throw new Error("PERSONAL_EXPORT_TOO_LARGE");
    const profile = await tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, emailVerified: true, createdAt: true, updatedAt: true } });
    if (!profile) throw new Error("WEB_IDENTITY_REQUIRED");
    const own = { userId };
    const counts = await Promise.all([
      tx.workspaceMember.count({ where: own }), tx.userCognitionState.count({ where: own }),
      tx.userCognitionReviewState.count({ where: own }), tx.userCognitionReviewEvent.count({ where: own }),
      tx.thinkingSession.count({ where: own }), tx.thinkingSessionMessage.count({ where: { session: own } }),
      tx.teachBackAttempt.count({ where: own }), tx.teachBackAssessment.count({ where: { attempt: own } }),
    ]);
    if (counts.reduce((sum, count) => sum + count, 0) > MAX_ROWS) throw new Error("PERSONAL_EXPORT_TOO_LARGE");
    const data = {
      profile,
      memberships: await tx.workspaceMember.findMany({ where: own, orderBy: { workspaceId: "asc" }, select: { workspaceId: true, role: true } }),
      cognitionStates: await tx.userCognitionState.findMany({ where: own, orderBy: { id: "asc" }, select: { id: true, workspaceId: true, memoryItemId: true, state: true, createdAt: true, updatedAt: true } }),
      reviewStates: await tx.userCognitionReviewState.findMany({ where: own, orderBy: { id: "asc" }, select: { id: true, workspaceId: true, memoryItemId: true, reviewCount: true, lastReviewedAt: true, nextReviewAt: true, lastMasteryState: true, lastMasteryAssessedAt: true } }),
      reviewEvents: await tx.userCognitionReviewEvent.findMany({ where: own, orderBy: { id: "asc" }, select: { id: true, workspaceId: true, memoryItemId: true, kind: true, createdAt: true } }),
      thinkingSessions: await tx.thinkingSession.findMany({ where: own, orderBy: { id: "asc" }, select: { id: true, workspaceId: true, memoryItemId: true, status: true, createdAt: true, updatedAt: true, completedAt: true } }),
      thinkingMessages: await tx.thinkingSessionMessage.findMany({ where: { session: own }, orderBy: [{ sessionId: "asc" }, { ordinal: "asc" }], select: { id: true, sessionId: true, role: true, content: true, ordinal: true, createdAt: true } }),
      teachBackAttempts: await tx.teachBackAttempt.findMany({ where: own, orderBy: { id: "asc" }, select: { id: true, workspaceId: true, memoryItemId: true, content: true, status: true, createdAt: true, updatedAt: true, assessedAt: true } }),
      teachBackAssessments: await tx.teachBackAssessment.findMany({ where: { attempt: own }, orderBy: { id: "asc" }, select: { id: true, attemptId: true, masteryState: true, rubric: true, feedback: true, nextPrompt: true, createdAt: true } }),
    };
    const json = JSON.stringify({ format: "acs-personal-learning-records", version: 1, exportedAt: new Date().toISOString(), scope: "account-and-personal-learning-records", excluded: ["shared-workspace-content", "source-files", "generated-media", "beta-telemetry-and-feedback", "authentication-and-provider-secrets"], data });
    if (Buffer.byteLength(json, "utf8") > MAX_BYTES) throw new Error("PERSONAL_EXPORT_TOO_LARGE");
    return json;
  }, { isolationLevel: "RepeatableRead", timeout: 30_000 });
}
