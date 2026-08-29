import { prisma } from "@ai-cognitive/db";

const userWithMemberships = {
  id: true,
  name: true,
  email: true,
  defaultWorkspaceId: true,
  memberships: {
    select: { workspaceId: true, workspace: { select: { name: true } } },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

export type UserWithMemberships = {
  id: string;
  name: string | null;
  email: string;
  defaultWorkspaceId: string | null;
  memberships: { workspaceId: string; workspace: { name: string } }[];
};

/**
 * Existing users take this read-only path. The lock is reserved for the rare
 * first-workspace race, where it keeps provisioning idempotent.
 */
export async function ensurePersonalWorkspace(userId: string): Promise<UserWithMemberships> {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: userWithMemberships });
  if (!existing) throw new Error("WEB_IDENTITY_REQUIRED");
  if (existing.memberships.length) return existing;

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: userWithMemberships });
    if (!user) throw new Error("WEB_IDENTITY_REQUIRED");
    if (user.memberships.length) return user;
    const workspace = await tx.workspace.create({ data: { name: `${user.name?.trim() || "My"} workspace`, members: { create: { userId: user.id, role: "OWNER" } } } });
    await tx.user.update({ where: { id: user.id }, data: { defaultWorkspaceId: workspace.id } });
    return { ...user, defaultWorkspaceId: workspace.id, memberships: [{ workspaceId: workspace.id, workspace: { name: workspace.name } }] };
  });
}
