import { z } from "zod";
import { productIdentityMutationOriginAllowed } from "./product-identity-api-policy";

/** No implied/legacy consent: both scopes are mandatory and literal true. */
export const pdfVisualRequestConsentSchema = z.strictObject({
  mode: z.literal("FIRST_MIXED_PAGE"),
  consentToExternalImageProcessing: z.literal(true),
  consentToProviderCharges: z.literal(true),
});

/** Browser POST Origin must match the request origin; absent Origin is denied. */
export function isSameOriginPdfVisualRequest(requestUrl: string, headerOrigin: string | null): boolean {
  if (!headerOrigin) return false;
  try {
    return new URL(requestUrl).origin === new URL(headerOrigin).origin &&
      headerOrigin === new URL(headerOrigin).origin;
  } catch { return false; }
}

/** A bootstrap/fallback workspace identity is never enough for a billed model request. */
export function isAuthenticatedPdfVisualRequest(sessionUserId: string | null | undefined, identityUserId: string): boolean {
  return typeof sessionUserId === "string" && sessionUserId.length > 0 && sessionUserId === identityUserId;
}

/** A browser Host header is not an authority for a billed image request. */
export function isTrustedPdfVisualRequestOrigin(requestUrl: string, headerOrigin: string | null, canonicalBaseUrl: string | undefined): boolean {
  return isSameOriginPdfVisualRequest(requestUrl, headerOrigin) &&
    productIdentityMutationOriginAllowed(headerOrigin, canonicalBaseUrl);
}
