import { cookies } from "next/headers";
import { cache } from "react";
import { prisma } from "@ai-cognitive/db";
import { browserIdentityMode } from "./identity-policy";
import { auth } from "./auth";
import { ensurePersonalWorkspace } from "./onboarding";

export type WebIdentityContext = {
  userId: string;
  workspaceId: string;
  userName: string | null;
  email: string;
  workspaces: { id: string; name: string }[];
};

/** Strip presentation-only identity fields before crossing into domain services. */
export function trustedRequestContext(identity: WebIdentityContext): { userId: string; workspaceId: string } {
  return { userId: identity.userId, workspaceId: identity.workspaceId };
}

const TEST_HARNESS_COOKIE = "acs_phase6_harness";
const DEVELOPMENT_WORKSPACE_ID = "cm000000000000000000000001";

/**
 * React scopes cache() to one server request. This intentionally does not
 * cache sessions across requests: every new RSC/document request revalidates
 * Better Auth with cookie caching disabled.
 */
export const resolveWebIdentity = cache(async (): Promise<WebIdentityContext> => {
  const jar = await cookies();
  const mode = browserIdentityMode(jar.get(TEST_HARNESS_COOKIE)?.value);
  try {
    const session = await auth.api.getSession({ headers: new Headers({ cookie: jar.toString() }), query: { disableCookieCache: true } }).catch(() => null);
    if (session?.user?.id) return await resolveAuthenticatedIdentity(session.user.id, jar.get("acs_active_workspace")?.value);
    if (mode === "REQUIRED") throw new Error("WEB_IDENTITY_REQUIRED");
    return await resolveFixedBootstrapIdentity(mode === "TEST_HARNESS"
      ? (process.env.WEB_TEST_HARNESS_EMAIL ?? "phase6-browser@ai-cognitive-studio.test")
      : (process.env.WEB_DEV_BOOTSTRAP_EMAIL ?? "local-product@ai-cognitive-studio.test"));
  } catch (error) {
    if (mode === "REQUIRED" || (error instanceof Error && error.message === "WEB_IDENTITY_REQUIRED")) throw error;
    // Fallback bootstrap identity when database or auth session is not active in dev/test
    return developmentIdentity();
  }
});

async function resolveAuthenticatedIdentity(userId: string, requestedWorkspaceId?: string): Promise<WebIdentityContext> {
  const user = await ensurePersonalWorkspace(userId);
  const validRequested = requestedWorkspaceId && user.memberships.some((membership) => membership.workspaceId === requestedWorkspaceId) ? requestedWorkspaceId : undefined;
  const workspaceId = validRequested ?? (user.defaultWorkspaceId && user.memberships.some((membership) => membership.workspaceId === user.defaultWorkspaceId) ? user.defaultWorkspaceId : user.memberships[0].workspaceId);
  if (workspaceId !== user.defaultWorkspaceId) await prisma.user.update({ where: { id: user.id }, data: { defaultWorkspaceId: workspaceId } }).catch(() => null);
  return {
    userId: user.id,
    workspaceId,
    userName: user.name,
    email: user.email,
    workspaces: user.memberships.map(({ workspaceId: id, workspace }) => ({ id, name: workspace.name })),
  };
}

async function resolveFixedBootstrapIdentity(email: string): Promise<WebIdentityContext> {
  try {
    const user = await prisma.user.findUnique({ where: { email } }) ?? await prisma.user.create({ data: { email } }).catch(async (error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "P2002") throw error;
      return prisma.user.findUniqueOrThrow({ where: { email } });
    });
    const workspace = await prisma.workspace.upsert({ where: { id: DEVELOPMENT_WORKSPACE_ID }, create: { id: DEVELOPMENT_WORKSPACE_ID, name: "Local product workspace" }, update: {} });
    await prisma.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } }, create: { workspaceId: workspace.id, userId: user.id, role: "OWNER" }, update: {} }).catch(async (error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "P2002") throw error;
      return prisma.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } } });
    });
    return { userId: user.id, workspaceId: workspace.id, userName: user.name, email: user.email, workspaces: [{ id: workspace.id, name: workspace.name }] };
  } catch {
    return developmentIdentity();
  }
}

function developmentIdentity(): WebIdentityContext {
  return {
    userId: "dev-user-01",
    workspaceId: DEVELOPMENT_WORKSPACE_ID,
    userName: "Local Product User",
    email: "local-product@ai-cognitive-studio.test",
    workspaces: [{ id: DEVELOPMENT_WORKSPACE_ID, name: "Local product workspace" }],
  };
}

export async function assertMembership(context: WebIdentityContext): Promise<WebIdentityContext> {
  try {
    const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { userId: context.userId, workspaceId: context.workspaceId } }, select: { userId: true } });
    if (!member && process.env.NODE_ENV === "production") throw new Error("WORKSPACE_ACCESS_DENIED");
    return context;
  } catch (error) {
    if (error instanceof Error && error.message === "WORKSPACE_ACCESS_DENIED" && process.env.NODE_ENV === "production") throw error;
    return context;
  }
}
