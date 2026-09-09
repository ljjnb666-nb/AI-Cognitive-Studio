import { NextResponse } from "next/server";
import { checkReadiness } from "@/lib/readiness";

export async function GET() {
  const readiness = await checkReadiness();
  return NextResponse.json(readiness, { status: readiness.status === "ready" ? 200 : 503 });
}
