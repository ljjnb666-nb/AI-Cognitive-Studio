import type { ProductIdentityPromotionOutcome } from "@ai-cognitive/ingestion";

export function productIdentityMutationOriginAllowed(origin: string | null, canonicalBaseUrl: string | undefined): boolean {
  if (!origin || !canonicalBaseUrl) return false;
  try {
    const supplied = new URL(origin);
    const canonical = new URL(canonicalBaseUrl);
    // Origin is an origin, not an arbitrary URL or an untrusted forwarded host.
    return supplied.origin === canonical.origin &&
      supplied.pathname === "/" && !supplied.search && !supplied.hash &&
      (supplied.protocol === "https:" || (supplied.protocol === "http:" && ["localhost", "127.0.0.1"].includes(supplied.hostname)));
  } catch {
    return false;
  }
}

export function productIdentityPromotionHttpStatus(status: ProductIdentityPromotionOutcome["status"]): number {
  if (status === "APPLIED" || status === "NOOP") return 200;
  if (status === "BLOCKED") return 422;
  return 409; // STALE, SUPERSEDED and CONFLICT are not successful writes.
}

export function productIdentityApiError(error: unknown): { error: string; status: number } {
  const code = error instanceof Error ? error.message : "";
  if (code === "WEB_IDENTITY_REQUIRED") return { error: code, status: 401 };
  if (code === "WORKSPACE_ACCESS_DENIED" || code === "WORKSPACE_WRITE_ACCESS_DENIED" || code === "BETA_ACCESS_REQUIRED") {
    return { error: "PRODUCT_IDENTITY_ACCESS_DENIED", status: 403 };
  }
  if (code === "SOURCE_DOCUMENT_ACCESS_DENIED") return { error: "PRODUCT_IDENTITY_NOT_FOUND", status: 404 };
  if (code === "PRODUCT_IDENTITY_CORRECTION_INVALID") return { error: "PRODUCT_IDENTITY_INVALID_REQUEST", status: 400 };
  if ([
    "PRODUCT_IDENTITY_NO_BOUND_EDITION",
    "PRODUCT_IDENTITY_SOURCE_FORMAT_NOT_PROMOTABLE",
    "PRODUCT_IDENTITY_EXTRACTION_NOT_PROMOTABLE",
    "PRODUCT_IDENTITY_CANDIDATE_INVALID",
    "PRODUCT_IDENTITY_SOURCE_BINDING_INVALID",
  ].includes(code)) return { error: "PRODUCT_IDENTITY_NOT_PROMOTABLE", status: 409 };
  return { error: "PRODUCT_IDENTITY_REQUEST_FAILED", status: 500 };
}