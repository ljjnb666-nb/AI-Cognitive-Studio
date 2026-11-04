import { prisma } from "@ai-cognitive/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebIdentity } from "@/lib/identity";

export async function GET() {
  try {
    const identity = await resolveWebIdentity();
    const policy = await prisma.workspaceResourcePolicy.findUnique({ where: { workspaceId: identity.workspaceId } });
    const [used] = await prisma.$queryRaw<Array<{ units: bigint }>>`SELECT COALESCE(sum(COALESCE("chargedUnits","units")),0)::bigint AS units FROM "ProviderResourceReservation" WHERE "workspaceId"=${identity.workspaceId} AND "createdAt">=date_trunc('day', NOW() AT TIME ZONE 'UTC')`;
    return NextResponse.json({ dailyUnitLimit: policy?.dailyUnitLimit ?? 1000000, runUnitLimit: policy?.runUnitLimit ?? 300000, usedUnits: Number(used?.units ?? 0), unit: "TOKENS_OR_CHARACTERS", currencyEstimate: null });
  } catch { return NextResponse.json({ error: "BUDGET_UNAVAILABLE" }, { status: 503 }); }
}
export async function POST(request: Request) {
  try {
    const identity = await resolveWebIdentity();
    const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: identity.workspaceId, userId: identity.userId } } });
    if (member?.role !== "OWNER") return NextResponse.json({ error: "WORKSPACE_WRITE_DENIED" }, { status: 403 });
    const value = z.object({ dailyUnitLimit: z.number().int().min(0).max(100000000), runUnitLimit: z.number().int().min(0).max(10000000) }).strict().parse(await request.json());
    await prisma.workspaceResourcePolicy.upsert({ where: { workspaceId: identity.workspaceId }, create: { workspaceId: identity.workspaceId, ...value }, update: value });
    return NextResponse.json({ ok: true });
  } catch { return NextResponse.json({ error: "BUDGET_UPDATE_FAILED" }, { status: 400 }); }
}
