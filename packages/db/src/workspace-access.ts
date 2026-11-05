import { prisma } from "./client.js";
import type { Prisma } from "@prisma/client";

export async function assertWorkspaceWrite(context: { workspaceId: string; userId: string }, db: Pick<Prisma.TransactionClient, "workspaceMember"> = prisma): Promise<void> {
  const member = await db.workspaceMember.findUnique({ where: { workspaceId_userId: context }, select: { role: true } });
  if (!member || (member.role !== "OWNER" && member.role !== "EDITOR")) throw new Error("WORKSPACE_WRITE_DENIED");
}
