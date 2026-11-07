import "server-only";
import { prisma } from "@ai-cognitive/db";

type Context = { workspaceId: string; userId: string };
async function membership(context: Context) {
  const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: context.userId } }, select: { role: true } });
  if (!member) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  return member;
}
export async function libraryDeletionPreview(context: Context, sourceDocumentId: string) {
  await membership(context);
  const document = await prisma.sourceDocument.findFirst({ where: { id: sourceDocumentId, workspaceId: context.workspaceId }, select: { source: { select: { id: true, displayName: true, updatedAt: true, archivedAt: true, _count: { select: { documents: true } } } } } });
  if (!document) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  return { sourceId: document.source.id, fileName: document.source.displayName, versionCount: document.source._count.documents, updatedAt: document.source.updatedAt.toISOString(), deleted: Boolean(document.source.archivedAt) };
}
export async function deleteFromLibrary(context: Context, sourceDocumentId: string, expected: { sourceId: string; versionCount: number; updatedAt: string }) {
  const member = await membership(context);
  if (member.role !== "OWNER" && member.role !== "EDITOR") throw new Error("SOURCE_DELETE_FORBIDDEN");
  return prisma.$transaction(async tx => {
    const document = await tx.sourceDocument.findFirst({ where: { id: sourceDocumentId, workspaceId: context.workspaceId }, select: { sourceId: true } });
    if (!document) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
    await tx.$queryRaw`SELECT "id" FROM "Source" WHERE "id"=${document.sourceId} AND "workspaceId"=${context.workspaceId} FOR UPDATE`;
    const currentMember = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: context.userId } }, select: { role: true } });
    if (currentMember?.role !== "OWNER" && currentMember?.role !== "EDITOR") throw new Error("SOURCE_DELETE_FORBIDDEN");
    const source = await tx.source.findUniqueOrThrow({ where: { id_workspaceId: { id: document.sourceId, workspaceId: context.workspaceId } }, select: { id: true, updatedAt: true, archivedAt: true, documents: { select: { id: true } } } });
    if (!source.archivedAt && (source.id !== expected.sourceId || source.updatedAt.toISOString() !== expected.updatedAt || source.documents.length !== expected.versionCount)) throw new Error("SOURCE_DELETE_CHANGED");
    if (!source.archivedAt) await tx.source.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
    return { documentIds: source.documents.map(item => item.id) };
  });
}
