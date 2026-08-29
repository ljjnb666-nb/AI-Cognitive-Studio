import { prisma } from "@ai-cognitive/db";
import { describe, expect, it, vi } from "vitest";
import { ensurePersonalWorkspace } from "../../lib/onboarding";

describe("authenticated onboarding", () => {
  it("keeps existing members on the read-only fast path", async () => {
    const user = await prisma.user.create({ data: { email: `onboarding-fast-${Date.now()}-${Math.random()}@test.invalid`, name: "Existing Member" } });
    const workspace = await prisma.workspace.create({ data: { name: "Existing workspace", members: { create: { userId: user.id, role: "OWNER" } } } });
    await prisma.user.update({ where: { id: user.id }, data: { defaultWorkspaceId: workspace.id } });
    const transaction = vi.spyOn(prisma, "$transaction");
    try {
      const identity = await ensurePersonalWorkspace(user.id);
      expect(identity.memberships).toHaveLength(1);
      expect(identity.memberships[0]).toMatchObject({ workspaceId: workspace.id, workspace: { name: "Existing workspace" } });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  it("serializes concurrent first-workspace initialization without duplicates", async () => {
    const user = await prisma.user.create({ data: { email: `onboarding-${Date.now()}-${Math.random()}@test.invalid`, name: "Concurrent User" } });
    try {
      const identities = await Promise.all(Array.from({ length: 8 }, () => ensurePersonalWorkspace(user.id)));
      const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { memberships: true } });
      expect(new Set(identities.map((identity) => identity.memberships[0]!.workspaceId)).size).toBe(1);
      expect(refreshed.memberships).toHaveLength(1);
      expect(refreshed.defaultWorkspaceId).toBe(refreshed.memberships[0]!.workspaceId);
      await prisma.workspace.delete({ where: { id: refreshed.memberships[0]!.workspaceId } });
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });
});
