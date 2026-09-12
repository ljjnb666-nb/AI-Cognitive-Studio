import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebIdentity } from "@/lib/identity";
import { createThinkingSession } from "@/lib/thinking";
import { thinkingSessionFailureForCode } from "@/lib/thinking-session-errors";

const body = z.object({ memoryItemId: z.string().cuid(), sessionId: z.string().uuid() });

function thinkingSessionFailure(error: unknown) {
  const raw = error instanceof Error ? error.message.split(":")[0] : undefined;
  if (error instanceof z.ZodError) return { error: "THINKING_SESSION_REQUEST_INVALID", message: "请求参数无效。", status: 400 };
  return thinkingSessionFailureForCode(raw);
}

export async function POST(request: Request) {
  try {
    const [identity, input] = await Promise.all([resolveWebIdentity(), request.json().then(body.parse)]);
    const result = await createThinkingSession(identity, input.memoryItemId, input.sessionId);
    return NextResponse.json(result.pending ? result : { ...result, href: `/studio/thinking/${result.id}` }, { status: result.pending ? 202 : 200 });
  } catch (error) {
    const failure = thinkingSessionFailure(error);
    return NextResponse.json({ error: failure.error, message: failure.message }, { status: failure.status });
  }
}
