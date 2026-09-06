import { NextResponse } from "next/server";
import { feedbackSchema, submitBetaFeedback } from "@ai-cognitive/product-analytics";
import { resolveWebIdentity, trustedRequestContext } from "@/lib/identity";
export async function POST(request: Request) {
  try {
    const feedback = await submitBetaFeedback(feedbackSchema.parse(await request.json()), trustedRequestContext(await resolveWebIdentity()));
    return NextResponse.json({ id: feedback.id }, { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "FEEDBACK_REJECTED";
    return NextResponse.json({ error: code }, { status: code.includes("ACCESS") ? 403 : 400 });
  }
}
