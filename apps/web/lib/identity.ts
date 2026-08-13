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

  // `next start` runs with NODE_ENV=production even in the isolated browser
  // acceptance harness. The marker is set only by that test command; ordinary
  // production deployments still require an upstream verified identity.
  const phase6Acceptance = process.env.PHASE6_BROWSER_ACCEPTANCE === "true"
    && process.env.WEB_DEV_BOOTSTRAP_IDENTITY === "true"
    && process.env.DATABASE_URL?.includes("ai_cognitive_studio_phase6_test");
  if ((process.env.NODE_ENV === "production" && !phase6Acceptance) || (process.env.NODE_ENV !== "production" && process.env.WEB_DEV_BOOTSTRAP_IDENTITY !== "true")) {
    throw new Error("WEB_IDENTITY_REQUIRED");
  }

  const email = process.env.WEB_DEV_BOOTSTRAP_EMAIL ?? "local-product@ai-cognitive-studio.test";
  const user = await prisma.user.upsert({
    where: { email },
    create: { email },
    update: {},
  });
  const existing = await prisma.workspaceMember.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return { userId: existing.userId, workspaceId: existing.workspaceId };
  const workspace = await prisma.workspace.create({ data: { name: "本地产品工作区" } });
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  return { userId: user.id, workspaceId: workspace.id };
}

export async function assertMembership(context: WebIdentityContext): Promise<WebIdentityContext> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: context },
    select: { userId: true },
  });
  if (!member) throw new Error("WORKSPACE_ACCESS_DENIED");
  return context;
}
