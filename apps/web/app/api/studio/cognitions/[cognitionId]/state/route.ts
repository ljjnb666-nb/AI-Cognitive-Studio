import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebIdentity } from "@/lib/identity";
import { updateCognitionUserState } from "@/lib/cognitions";

const bodySchema = z.object({ saved: z.boolean() });

export async function POST(request: Request, { params }: { params: Promise<{ cognitionId: string }> }) {
  try {
    const [{ cognitionId }, body, identity] = await Promise.all([params, request.json(), resolveWebIdentity()]);
    const result = await updateCognitionUserState(identity, { cognitionId, ...bodySchema.parse(body) });
    return NextResponse.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "COGNITION_STATE_UPDATE_FAILED";
    return NextResponse.json({ error: code }, { status: code === "COGNITION_NOT_FOUND" ? 404 : code === "WEB_IDENTITY_REQUIRED" ? 401 : 400 });
  }
}
