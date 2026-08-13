import "server-only";

import { cookies } from "next/headers";
import { prisma } from "@ai-cognitive/db";

export type WebIdentityContext = { userId: string; workspaceId: string };

const USER_COOKIE = "acs_user_id";
const WORKSPACE_COOKIE = "acs_workspace_id";

/**
 * This is intentionally the only web identity entrypoint. Production callers
 * must provide a verified identity upstream; development/test can opt into a
 * bootstrap identity explicitly for local product work.
 */
export async function resolveWebIdentity(): Promise<WebIdentityContext> {
  const jar = await cookies();
  const userId = jar.get(USER_COOKIE)?.value;
  const workspaceId = jar.get(WORKSPACE_COOKIE)?.value;
  if (userId && workspaceId) return assertMembership({ userId, workspaceId });

  if (process.env.NODE_ENV === "production" || process.env.WEB_DEV_BOOTSTRAP_IDENTITY !== "true") {
    throw new Error("WEB_IDENTITY_REQUIRED");
  }

  const member = await prisma.workspaceMember.findFirst({ orderBy: { createdAt: "asc" } });
  if (!member) throw new Error("WEB_BOOTSTRAP_IDENTITY_UNAVAILABLE");
  return { userId: member.userId, workspaceId: member.workspaceId };
}

export async function assertMembership(context: WebIdentityContext): Promise<WebIdentityContext> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: context },
    select: { userId: true },
  });
  if (!member) throw new Error("WORKSPACE_ACCESS_DENIED");
  return context;
}

