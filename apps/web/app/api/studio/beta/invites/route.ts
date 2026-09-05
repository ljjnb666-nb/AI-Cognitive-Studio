import { NextResponse } from "next/server";
import { z } from "zod";
import { assertBetaOperator, createBetaInvite } from "@ai-cognitive/product-analytics";
import { resolveWebIdentity } from "@/lib/identity";

const createSchema = z.object({ cohort: z.string().trim().min(1).max(80), expiresAt: z.coerce.date() }).strict();
export async function GET() {
  try { const identity = await resolveWebIdentity(); await assertBetaOperator(identity.userId); const invites = await (await import("@ai-cognitive/db")).prisma.betaInvite.findMany({ select: { id: true, cohort: true, expiresAt: true, revokedAt: true, redeemedAt: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 100 }); return NextResponse.json({ invites }); }
  catch { return NextResponse.json({ error: "BETA_OPERATOR_REQUIRED" }, { status: 403 }); }
}
export async function POST(request: Request) {
  try { const identity = await resolveWebIdentity(); await assertBetaOperator(identity.userId); const input = createSchema.parse(await request.json()); if (input.expiresAt <= new Date()) throw new Error("BETA_INVITE_EXPIRY_INVALID"); const { invite, token } = await createBetaInvite(input); return NextResponse.json({ invite: { id: invite.id, cohort: invite.cohort, expiresAt: invite.expiresAt }, token }, { status: 201 }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "BETA_INVITE_CREATE_FAILED" }, { status: 400 }); }
}
