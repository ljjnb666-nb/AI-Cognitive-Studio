import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebMutationIdentity } from "@/lib/identity";
import { recordManualCognitionReview } from "@/lib/personalized-cognition";

const body = z.object({ eventId: z.string().uuid() });

export async function POST(request: Request, { params }: { params: Promise<{ cognitionId: string }> }) {
  try {
    const [{ cognitionId }, identity, input] = await Promise.all([params, resolveWebMutationIdentity(), request.json().then(body.parse)]);
    return NextResponse.json(await recordManualCognitionReview(identity, { memoryItemId: cognitionId, eventId: input.eventId }));
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "COGNITION_REVIEW_FAILED";
    return NextResponse.json({ error: code }, { status: code === "COGNITION_NOT_FOUND" ? 404 : code === "WORKSPACE_WRITE_DENIED" ? 403 : code === "WEB_IDENTITY_REQUIRED" ? 401 : 400 });
  }
}
