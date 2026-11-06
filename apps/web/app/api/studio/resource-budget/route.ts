import { prisma } from "@ai-cognitive/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebIdentity } from "@/lib/identity";

export async function GET() {
  try {
    const identity = await resolveWebIdentity();
    const [policy] = await prisma.$queryRaw<Array<{dailyUnitLimit:number;runUnitLimit:number;runLimitEnabled:boolean;bookChunkConcurrency:number}>>`SELECT "dailyUnitLimit","runUnitLimit","runLimitEnabled","bookChunkConcurrency" FROM "WorkspaceResourcePolicy" WHERE "workspaceId"=${identity.workspaceId}`;
    const [used] = await prisma.$queryRaw<Array<{ units: bigint }>>`SELECT COALESCE(sum(COALESCE("chargedUnits","units")),0)::bigint AS units FROM "ProviderResourceReservation" WHERE "workspaceId"=${identity.workspaceId} AND "createdAt">=date_trunc('day', NOW() AT TIME ZONE 'UTC')`;
    return NextResponse.json({ dailyUnitLimit: policy?.dailyUnitLimit ?? 1000000, runUnitLimit: policy?.runUnitLimit ?? 300000, runLimitEnabled: policy?.runLimitEnabled ?? true, bookChunkConcurrency: policy?.bookChunkConcurrency ?? 2, usedUnits: Number(used?.units ?? 0), unit: "TOKENS_OR_CHARACTERS", currencyEstimate: null });
  } catch { return NextResponse.json({ error: "BUDGET_UNAVAILABLE" }, { status: 503 }); }
}
export async function POST(request: Request) {
  try {
    const identity = await resolveWebIdentity();
    const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: identity.workspaceId, userId: identity.userId } } });
    if (member?.role !== "OWNER") return NextResponse.json({ error: "WORKSPACE_WRITE_DENIED" }, { status: 403 });
    const value = z.object({ dailyUnitLimit: z.number().int().min(0).max(100000000), runUnitLimit: z.number().int().min(0).max(10000000), runLimitEnabled: z.boolean().optional(), bookChunkConcurrency: z.number().int().min(1).max(4).optional() }).strict().parse(await request.json());
    await prisma.$executeRaw`INSERT INTO "WorkspaceResourcePolicy" ("workspaceId","dailyUnitLimit","runUnitLimit","runLimitEnabled","bookChunkConcurrency") VALUES (${identity.workspaceId},${value.dailyUnitLimit},${value.runUnitLimit},${value.runLimitEnabled ?? true},${value.bookChunkConcurrency ?? 2}) ON CONFLICT ("workspaceId") DO UPDATE SET "dailyUnitLimit"=EXCLUDED."dailyUnitLimit","runUnitLimit"=EXCLUDED."runUnitLimit","runLimitEnabled"=COALESCE(${value.runLimitEnabled ?? null}::boolean,"WorkspaceResourcePolicy"."runLimitEnabled"),"bookChunkConcurrency"=COALESCE(${value.bookChunkConcurrency ?? null}::integer,"WorkspaceResourcePolicy"."bookChunkConcurrency")`;
    return NextResponse.json({ ok: true });
  } catch { return NextResponse.json({ error: "BUDGET_UPDATE_FAILED" }, { status: 400 }); }
}
