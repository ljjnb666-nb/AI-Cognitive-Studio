import { NextResponse } from "next/server";
import { withdrawBetaParticipant } from "@ai-cognitive/product-analytics";
import { resolveWebIdentity } from "@/lib/identity";
export async function POST() {
  try { await withdrawBetaParticipant((await resolveWebIdentity()).userId); return NextResponse.json({ ok: true }); }
  catch { return NextResponse.json({ error: "BETA_WITHDRAWAL_FAILED" }, { status: 400 }); }
}
