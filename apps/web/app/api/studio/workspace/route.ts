import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@ai-cognitive/db";
import { auth } from "@/lib/auth";

const inputSchema = z.object({ workspaceId: z.string().min(1).max(128) });

export async function POST(request: Request) {
  try {
    const requested = inputSchema.parse(await request.json());
    const jar = await cookies();
    const session = await auth.api.getSession({ headers: new Headers({ cookie: jar.toString() }) });
    if (!session?.user?.id) return NextResponse.json({ error: "WEB_IDENTITY_REQUIRED" }, { status: 401 });
    const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: requested.workspaceId, userId: session.user.id } }, select: { workspaceId: true } });
    if (!member) return NextResponse.json({ error: "WORKSPACE_ACCESS_DENIED" }, { status: 403 });
    await prisma.user.update({ where: { id: session.user.id }, data: { defaultWorkspaceId: member.workspaceId } });
    jar.set("acs_active_workspace", member.workspaceId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
    return NextResponse.json({ workspaceId: member.workspaceId });
  } catch {
    return NextResponse.json({ error: "WORKSPACE_ACCESS_DENIED" }, { status: 403 });
  }
}
