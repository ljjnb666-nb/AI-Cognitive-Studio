import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebIdentity } from "@/lib/identity";
import { createOrAssessTeachBackAttempt } from "@/lib/teach-back";

const body = z.object({ memoryItemId: z.string().cuid(), attemptId: z.string().uuid(), content: z.string().min(1).max(6_000) });
export async function POST(request: Request) { try { const [identity, input] = await Promise.all([resolveWebIdentity(), request.json().then(body.parse)]); const result = await createOrAssessTeachBackAttempt(identity, input); return NextResponse.json({ ...result, href: result.pending ? undefined : `/studio/teach-back/${result.id}` }, { status: result.pending ? 202 : 200 }); } catch (error) { const code = error instanceof Error ? error.message.split(":")[0] : "TEACH_BACK_REQUEST_FAILED"; return NextResponse.json({ error: code, message: code === "AI_PROVIDER_CONFIGURATION_REQUIRED" ? "复述评估尚未就绪，请先配置 Provider。" : undefined }, { status: code === "COGNITION_NOT_CURRENT" || code === "TEACH_BACK_ATTEMPT_NOT_FOUND" ? 404 : code === "WEB_IDENTITY_REQUIRED" ? 401 : code === "TEACH_BACK_IDEMPOTENCY_CONFLICT" ? 409 : 400 }); } }
