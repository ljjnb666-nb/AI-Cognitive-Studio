import { prisma } from "@ai-cognitive/db";
import type { StorageProvider } from "@ai-cognitive/storage";

/** Deletes only expired/rejected temporary upload objects; canonical blobs are never candidates. */
export async function cleanupTemporaryUploads(storage: StorageProvider, retentionMs: number, now = new Date()): Promise<number> {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error("INVALID_TEMP_RETENTION");
  const cutoff = new Date(now.getTime() - retentionMs);
  const sessions = await prisma.uploadSession.findMany({
    where: {
      OR: [
        { status: { in: ["EXPIRED", "REJECTED"] } },
        { status: { in: ["CREATED", "UPLOADED"] }, updatedAt: { lt: cutoff } },
      ],
      temporaryStorageKey: { startsWith: "temporary/" },
    },
    select: { id: true, temporaryStorageKey: true },
  });
  for (const session of sessions) await storage.deleteObject(session.temporaryStorageKey).catch(() => undefined);
  return sessions.length;
}
