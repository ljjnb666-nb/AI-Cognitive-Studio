import { ProviderGatewayError } from "../errors.js";
import type { ExecutionSnapshot } from "../types.js";

export type PlatformCredentialResolver = { resolve(snapshot: ExecutionSnapshot): Promise<string | undefined> };
export async function resolvePlatformCredential(resolver: PlatformCredentialResolver | undefined, snapshot: ExecutionSnapshot): Promise<string> {
  const credential = await resolver?.resolve(snapshot);
  if (!credential) throw new ProviderGatewayError("AUTHENTICATION_FAILED", "Platform credential is unavailable");
  return credential;
}
