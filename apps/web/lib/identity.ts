import "server-only";

import { cookies } from "next/headers";
import { prisma } from "@ai-cognitive/db";
import { browserIdentityMode } from "./identity-policy";

export type WebIdentityContext = { userId: string; workspaceId: string };

const TEST_HARNESS_COOKIE = "acs_phase6_harness";
const DEVELOPMENT_WORKSPACE_ID = "cm000000000000000000000001";

/**
 * This is intentionally the only web identity entrypoint. Production callers
 * must provide a verified identity upstream; development/test can opt into a
 * bootstrap identity explicitly for local product work.
 */
export async function resolveWebIdentity(): Promise<WebIdentityContext> {
  const jar = await cookies();
  const mode = browserIdentityMode(jar.get(TEST_HARNESS_COOKIE)?.value);
  if (mode === "REQUIRED") {
    throw new Error("WEB_IDENTITY_REQUIRED");
  }

  return resolveFixedBootstrapIdentity(
    mode === "TEST_HARNESS"
      ? (process.env.WEB_TEST_HARNESS_EMAIL ?? "phase6-browser@ai-cognitive-studio.test")
      : (process.env.WEB_DEV_BOOTSTRAP_EMAIL ?? "local-product@ai-cognitive-studio.test"),
  );
}

async function resolveFixedBootstrapIdentity(email: string): Promise<WebIdentityContext> {
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
