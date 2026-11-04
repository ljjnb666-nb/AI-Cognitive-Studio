import { NextResponse } from "next/server";
import { workspaceProductionDiagnostics } from "@ai-cognitive/product-analytics";
import { resolveWebIdentity, trustedRequestContext } from "@/lib/identity";

export async function GET() {
  try { return NextResponse.json(await workspaceProductionDiagnostics(trustedRequestContext(await resolveWebIdentity())), { headers: { "cache-control": "no-store" } }); }
  catch { return NextResponse.json({ error: "DIAGNOSTICS_UNAVAILABLE" }, { status: 503 }); }
}
