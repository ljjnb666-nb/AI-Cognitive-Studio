import { NextResponse } from "next/server";
import { z } from "zod";
import { redeemBetaInvite } from "@ai-cognitive/product-analytics";
import { requireAuthenticatedUserId } from "@/lib/beta-session";

const schema = z.object({ code: z.string().min(20).max(200), consent: z.literal(true) }).strict();
export async function POST(request: Request) {
  try {
    const userId = await requireAuthenticatedUserId();
    const { code, consent } = schema.parse(await request.json());
    await redeemBetaInvite({ token: code, consent, userId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : "BETA_INVITATION_INVALID";
    return NextResponse.json({ error: code === "BETA_CONSENT_REQUIRED" ? code : "BETA_INVITATION_INVALID" }, { status: code === "WEB_IDENTITY_REQUIRED" ? 401 : 400 });
  }
}
