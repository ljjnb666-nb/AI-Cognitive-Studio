import { prisma } from "@ai-cognitive/db";
import { describe, expect, it } from "vitest";
import { ensurePersonalWorkspace } from "../../lib/onboarding";

describe("authenticated onboarding", () => {
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
