import { prisma } from "@ai-cognitive/db";
import type { StorageProvider } from "@ai-cognitive/storage";

/** Expired signed URLs can no longer resurrect successfully cleaned objects. */
export async function cleanupTemporaryUploads(storage: StorageProvider, retentionMs: number, now = new Date()): Promise<number> {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error("INVALID_TEMP_RETENTION");
  const cutoff = new Date(now.getTime() - retentionMs);
  const sessions = await prisma.uploadSession.findMany({
    where: {
      expiresAt: { lt: cutoff }, temporaryCleanedAt: null,
      OR: [{ status: { not: "COMPLETING" } }, { completionLeaseUntil: { lt: now } }, { completionLeaseUntil: null }],
      temporaryStorageKey: { startsWith: "temporary/" },
    },
    select: { id: true }, orderBy: [{ expiresAt: "asc" }, { id: "asc" }], take: 100,
  });
  let cleaned = 0, failed = 0;
  for (const session of sessions) {
    try {
      cleaned += await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "UploadSession" WHERE "id" = ${session.id} FOR UPDATE`;
        const fresh = await tx.uploadSession.findUniqueOrThrow({ where: { id: session.id } });
        if (fresh.temporaryCleanedAt || fresh.expiresAt >= cutoff || (fresh.status === "COMPLETING" && fresh.completionLeaseUntil && fresh.completionLeaseUntil >= now)) return 0;
        if (!fresh.temporaryStorageKey.startsWith(`temporary/${fresh.workspaceId}/`)) throw new Error("TEMP_UPLOAD_KEY_SCOPE_INVALID");
        await storage.deleteObject(fresh.temporaryStorageKey);
        if (await storage.objectExists(fresh.temporaryStorageKey)) throw new Error("TEMP_UPLOAD_DELETE_NOT_VERIFIED");
        await tx.uploadSession.update({ where: { id: fresh.id }, data: { temporaryCleanedAt: now, ...(fresh.status === "COMPLETED" || fresh.status === "REJECTED" ? {} : { status: "EXPIRED", completionClaimToken: null, completionLeaseUntil: null }) } });
        return 1;
      });
    } catch { failed++; }
  }
  if (failed) throw new Error(`TEMP_UPLOAD_CLEANUP_RETRY_REQUIRED:${failed}`);
  return cleaned;
}
