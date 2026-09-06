import { cookies } from "next/headers";
import { auth } from "./auth";

/** Authentication-only lookup for the redemption flow: intentionally no workspace provisioning. */
export async function requireAuthenticatedUserId() {
  const jar = await cookies();
  const session = await auth.api.getSession({ headers: new Headers({ cookie: jar.toString() }), query: { disableCookieCache: true } }).catch(() => null);
  if (!session?.user?.id) throw new Error("WEB_IDENTITY_REQUIRED");
  return session.user.id;
}
