import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";

export type CompletionClaim = { token: string };

export async function claimUploadCompletion(workspaceId: string, sessionId: string, leaseMs: number): Promise<CompletionClaim | null> {
  const token = randomUUID();
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "UploadSession"
    SET "status" = 'COMPLETING'::"UploadSessionStatus",
        "completionClaimToken" = ${token},
        "completionClaimedAt" = NOW(),
        "completionLeaseUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
        "updatedAt" = NOW()
    WHERE "id" = ${sessionId}
      AND "workspaceId" = ${workspaceId}
      AND (
        "status" IN ('CREATED'::"UploadSessionStatus", 'UPLOADED'::"UploadSessionStatus")
        OR ("status" = 'COMPLETING'::"UploadSessionStatus" AND "completionLeaseUntil" < NOW())
      )
    RETURNING "id"
  `;
  return rows.length ? { token } : null;
}

export async function renewCompletionClaim(workspaceId: string, sessionId: string, token: string, leaseMs: number): Promise<boolean> {
  const result = await prisma.$executeRaw`
    UPDATE "UploadSession"
    SET "completionClaimedAt" = NOW(), "completionLeaseUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond'), "updatedAt" = NOW()
    WHERE "id" = ${sessionId} AND "workspaceId" = ${workspaceId}
      AND "status" = 'COMPLETING'::"UploadSessionStatus"
      AND "completionClaimToken" = ${token} AND "completionLeaseUntil" >= NOW()
  `;
  return result === 1;
}

export async function releaseCompletionClaim(workspaceId: string, sessionId: string, token: string): Promise<boolean> {
  const result = await prisma.$executeRaw`
    UPDATE "UploadSession"
    SET "status" = 'CREATED'::"UploadSessionStatus", "completionClaimToken" = NULL,
        "completionClaimedAt" = NULL, "completionLeaseUntil" = NULL, "updatedAt" = NOW()
    WHERE "id" = ${sessionId} AND "workspaceId" = ${workspaceId}
      AND "status" = 'COMPLETING'::"UploadSessionStatus" AND "completionClaimToken" = ${token}
  `;
  return result === 1;
}

export async function rejectCompletionClaim(workspaceId: string, sessionId: string, token: string, status: "REJECTED" | "EXPIRED"): Promise<boolean> {
  const result = await prisma.$executeRaw`
    UPDATE "UploadSession"
    SET "status" = ${status}::"UploadSessionStatus", "completionClaimToken" = NULL,
        "completionClaimedAt" = NULL, "completionLeaseUntil" = NULL, "updatedAt" = NOW()
    WHERE "id" = ${sessionId} AND "workspaceId" = ${workspaceId}
      AND "status" = 'COMPLETING'::"UploadSessionStatus" AND "completionClaimToken" = ${token}
  `;
  return result === 1;
}
