import { NextResponse } from "next/server";
import { clientEventSchema, recordClientEvent } from "@ai-cognitive/product-analytics";
import { resolveWebIdentity, trustedRequestContext } from "@/lib/identity";
export async function POST(request: Request) {
  try {
    const event = await recordClientEvent(clientEventSchema.parse(await request.json()), trustedRequestContext(await resolveWebIdentity()));
    return NextResponse.json(event);
  } catch (error) {
    const code = error instanceof Error ? error.message : "EVENT_REJECTED";
    return NextResponse.json({ error: code }, { status: code.includes("ACCESS") || code.includes("IDENTITY") ? 403 : 400 });
  }
}
