import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebIdentity } from "@/lib/identity";
import { appendThinkingResponse } from "@/lib/thinking";
const body = z.object({ clientMessageId: z.string().uuid(), content: z.string().trim().min(1).max(4000) });
export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) { try { const [{ sessionId }, identity, input] = await Promise.all([params, resolveWebIdentity(), request.json().then(body.parse)]); const result = await appendThinkingResponse(identity, sessionId, input.clientMessageId, input.content); return NextResponse.json(result, { status: result.pending ? 202 : 200 }); } catch (error) { const code = error instanceof Error ? error.message.split(":")[0] : "THINKING_SESSION_MESSAGE_FAILED"; return NextResponse.json({ error: code }, { status: code === "THINKING_SESSION_NOT_FOUND" ? 404 : code === "WEB_IDENTITY_REQUIRED" ? 401 : 400 }); } }
