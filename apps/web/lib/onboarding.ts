import { prisma } from "@ai-cognitive/db";

export type UserWithMemberships = { id: string; name: string | null; defaultWorkspaceId: string | null; memberships: { workspaceId: string }[] };

/** A locked User row makes interrupted/retried onboarding idempotent. */
export async function ensurePersonalWorkspace(userId: string): Promise<UserWithMemberships> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, name: true, defaultWorkspaceId: true, memberships: { select: { workspaceId: true }, orderBy: { createdAt: "asc" } } } });
    if (!user) throw new Error("WEB_IDENTITY_REQUIRED");
    if (user.memberships.length) return user;
    const workspace = await tx.workspace.create({ data: { name: `${user.name?.trim() || "My"} workspace`, members: { create: { userId: user.id, role: "OWNER" } } } });
    await tx.user.update({ where: { id: user.id }, data: { defaultWorkspaceId: workspace.id } });
    return { ...user, defaultWorkspaceId: workspace.id, memberships: [{ workspaceId: workspace.id }] };
  });
}
