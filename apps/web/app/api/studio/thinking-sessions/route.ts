import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebIdentity } from "@/lib/identity";
import { createThinkingSession } from "@/lib/thinking";
const body = z.object({ memoryItemId: z.string().cuid(), sessionId: z.string().uuid() });
export async function POST(request: Request) { try { const [identity, input] = await Promise.all([resolveWebIdentity(), request.json().then(body.parse)]); const result = await createThinkingSession(identity, input.memoryItemId, input.sessionId); return NextResponse.json(result.pending ? result : { ...result, href: `/studio/thinking/${result.id}` }, { status: result.pending ? 202 : 200 }); } catch (error) { const code = error instanceof Error ? error.message.split(":")[0] : "THINKING_SESSION_CREATE_FAILED"; return NextResponse.json({ error: code, message: code === "AI_PROVIDER_CONFIGURATION_REQUIRED" ? "思考会话尚未就绪，请先配置 Provider。" : undefined }, { status: code === "COGNITION_NOT_CURRENT" ? 404 : code === "WEB_IDENTITY_REQUIRED" ? 401 : 400 }); } }
