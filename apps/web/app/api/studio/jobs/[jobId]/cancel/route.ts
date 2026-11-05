import { NextResponse } from "next/server";
import { cancelWorkspaceJob } from "@ai-cognitive/db";
import { resolveWebMutationIdentity, trustedRequestContext } from "@/lib/identity";
export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try { return NextResponse.json(await cancelWorkspaceJob(trustedRequestContext(await resolveWebMutationIdentity()), (await params).jobId)); }
  catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code === "WEB_IDENTITY_REQUIRED" ? 401
      : ["WORKSPACE_WRITE_DENIED", "WORKSPACE_ACCESS_DENIED", "BETA_ACCESS_REQUIRED"].includes(code) ? 403
      : code === "CANCELLABLE_OPERATION_NOT_FOUND" ? 404
      : code === "OPERATION_ALREADY_TERMINAL" ? 409 : 503;
    return NextResponse.json({ error: status === 503 ? "CANCEL_UNAVAILABLE" : code }, { status, headers: { "cache-control": "private, no-store" } });
  }
}
