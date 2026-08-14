import "server-only";

import { cookies } from "next/headers";
import { prisma } from "@ai-cognitive/db";
import { browserIdentityMode } from "./identity-policy";
import { auth } from "./auth";

export type WebIdentityContext = { userId: string; workspaceId: string };

const TEST_HARNESS_COOKIE = "acs_phase6_harness";
const DEVELOPMENT_WORKSPACE_ID = "cm000000000000000000000001";

export async function resolveWebIdentity(): Promise<WebIdentityContext> {
  const jar = await cookies();
  const session = await auth.api.getSession({ headers: new Headers({ cookie: jar.toString() }) });
  if (session?.user?.id) return resolveAuthenticatedIdentity(session.user.id, jar.get("acs_active_workspace")?.value);
  const mode = browserIdentityMode(jar.get(TEST_HARNESS_COOKIE)?.value);
  if (mode === "REQUIRED") throw new Error("WEB_IDENTITY_REQUIRED");
  return resolveFixedBootstrapIdentity(mode === "TEST_HARNESS"
    ? (process.env.WEB_TEST_HARNESS_EMAIL ?? "phase6-browser@ai-cognitive-studio.test")
    : (process.env.WEB_DEV_BOOTSTRAP_EMAIL ?? "local-product@ai-cognitive-studio.test"));
}

type UserWithMemberships = { id: string; name: string | null; defaultWorkspaceId: string | null; memberships: { workspaceId: string }[] };

async function resolveAuthenticatedIdentity(userId: string, requestedWorkspaceId?: string): Promise<WebIdentityContext> {
  const user = await ensurePersonalWorkspace(userId);
  const validRequested = requestedWorkspaceId && user.memberships.some((membership) => membership.workspaceId === requestedWorkspaceId) ? requestedWorkspaceId : undefined;
  const workspaceId = validRequested ?? (user.defaultWorkspaceId && user.memberships.some((membership) => membership.workspaceId === user.defaultWorkspaceId) ? user.defaultWorkspaceId : user.memberships[0].workspaceId);
  if (workspaceId !== user.defaultWorkspaceId) await prisma.user.update({ where: { id: user.id }, data: { defaultWorkspaceId: workspaceId } });
  return { userId: user.id, workspaceId };
}

/** A locked User row makes interrupted/retried onboarding idempotent. */
async function ensurePersonalWorkspace(userId: string): Promise<UserWithMemberships> {
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

async function resolveFixedBootstrapIdentity(email: string): Promise<WebIdentityContext> {
  const user = await prisma.user.findUnique({ where: { email } }) ?? await prisma.user.create({ data: { email } }).catch(async (error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "P2002") throw error;
    return prisma.user.findUniqueOrThrow({ where: { email } });
  });
  const workspace = await prisma.workspace.upsert({ where: { id: DEVELOPMENT_WORKSPACE_ID }, create: { id: DEVELOPMENT_WORKSPACE_ID, name: "Local product workspace" }, update: {} });
  await prisma.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } }, create: { workspaceId: workspace.id, userId: user.id, role: "OWNER" }, update: {} }).catch(async (error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "P2002") throw error;
    return prisma.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } } });
  });
  return { userId: user.id, workspaceId: workspace.id };
}

export async function assertMembership(context: WebIdentityContext): Promise<WebIdentityContext> {
  const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: context }, select: { userId: true } });
  if (!member) throw new Error("WORKSPACE_ACCESS_DENIED");
  return context;
}
