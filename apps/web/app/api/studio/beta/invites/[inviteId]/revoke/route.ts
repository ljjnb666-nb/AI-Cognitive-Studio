import { NextResponse } from "next/server";
import { assertBetaOperator, revokeBetaInvite } from "@ai-cognitive/product-analytics";
import { resolveWebIdentity } from "@/lib/identity";
export async function POST(_request: Request, context: { params: Promise<{ inviteId: string }> }) {
  try { const identity = await resolveWebIdentity(); await assertBetaOperator(identity.userId); await revokeBetaInvite((await context.params).inviteId); return NextResponse.json({ ok: true }); }
  catch { return NextResponse.json({ error: "BETA_INVITE_NOT_REVOCABLE" }, { status: 400 }); }
}
