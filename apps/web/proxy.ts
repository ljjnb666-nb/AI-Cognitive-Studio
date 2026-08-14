import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { testHarnessCredentialValid } from "./lib/identity-policy";

export function proxy(request: NextRequest) {
  const phase6Harness = testHarnessCredentialValid(request.cookies.get("acs_phase6_harness")?.value);
  if (!getSessionCookie(request.headers) && !phase6Harness) {
    const callbackUrl = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    const url = new URL("/sign-in", request.url);
    url.searchParams.set("callbackUrl", callbackUrl);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/studio/:path*"] };
