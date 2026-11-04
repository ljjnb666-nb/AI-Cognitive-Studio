import { NextResponse } from "next/server";
import { withdrawBetaParticipant } from "@ai-cognitive/product-analytics";
import { resolveSessionUserId } from "@/lib/identity";
export async function POST() {
  try { await withdrawBetaParticipant(await resolveSessionUserId()); return NextResponse.json({ ok: true }); }
  catch { return NextResponse.json({ error: "BETA_WITHDRAWAL_FAILED" }, { status: 400 }); }
}
