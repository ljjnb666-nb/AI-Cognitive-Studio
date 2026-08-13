import "server-only";

import { cookies } from "next/headers";
import { prisma } from "@ai-cognitive/db";
import { developmentBootstrapAllowed } from "./identity-policy";

export type WebIdentityContext = { userId: string; workspaceId: string };

const USER_COOKIE = "acs_user_id";
const WORKSPACE_COOKIE = "acs_workspace_id";
const DEVELOPMENT_WORKSPACE_ID = "cm000000000000000000000001";

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
  if (!developmentBootstrapAllowed()) {
    throw new Error("WEB_IDENTITY_REQUIRED");
  }

  const email = process.env.WEB_DEV_BOOTSTRAP_EMAIL ?? "local-product@ai-cognitive-studio.test";
  const user = await prisma.user.findUnique({ where: { email } }) ?? await prisma.user.create({ data: { email } }).catch(async (error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "P2002") throw error;
    return prisma.user.findUniqueOrThrow({ where: { email } });
  });
  const workspace = await prisma.workspace.upsert({
    where: { id: DEVELOPMENT_WORKSPACE_ID },
    create: { id: DEVELOPMENT_WORKSPACE_ID, name: "本地产品工作区" },
    update: {},
  });
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    create: { workspaceId: workspace.id, userId: user.id, role: "OWNER" },
    update: {},
  });
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
