import { z } from "zod";

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
