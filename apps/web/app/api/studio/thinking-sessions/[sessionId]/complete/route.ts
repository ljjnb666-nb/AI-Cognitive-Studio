import { NextResponse } from "next/server";
import { resolveWebIdentity } from "@/lib/identity";
import { completeThinkingSession } from "@/lib/thinking";
export async function POST(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) { try { const [{ sessionId }, identity] = await Promise.all([params, resolveWebIdentity()]); await completeThinkingSession(identity, sessionId); return NextResponse.json({ status: "COMPLETED" }); } catch (error) { const code = error instanceof Error ? error.message.split(":")[0] : "THINKING_SESSION_COMPLETE_FAILED"; return NextResponse.json({ error: code }, { status: code === "THINKING_SESSION_NOT_FOUND" ? 404 : 400 }); } }
