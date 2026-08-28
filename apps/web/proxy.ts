import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { auth } from "./lib/auth";
import { testHarnessCredentialValid } from "./lib/identity-policy";

export async function proxy(request: NextRequest) {
  const phase6Harness = testHarnessCredentialValid(request.cookies.get("acs_phase6_harness")?.value);
  const session = phase6Harness ? null : await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } }).catch(() => null);
  if ((!getSessionCookie(request.headers) || !session?.user?.id) && !phase6Harness) {
    const callbackUrl = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    const url = new URL("/sign-in", request.url);
    url.searchParams.set("callbackUrl", callbackUrl);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/studio/:path*"] };
