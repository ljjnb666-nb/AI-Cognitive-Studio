import { describe, expect, it } from "vitest";
import {
  productIdentityMutationOriginAllowed,
  productIdentityPromotionHttpStatus,
  productIdentityApiError,
} from "../lib/product-identity-api-policy";

describe("product identity API mutation boundary", () => {
  it("accepts only the canonical browser origin", () => {
    expect(productIdentityMutationOriginAllowed("https://studio.example.com", "https://studio.example.com")).toBe(true);
    expect(productIdentityMutationOriginAllowed("http://localhost:3001", "http://localhost:3001")).toBe(true);
    expect(productIdentityMutationOriginAllowed("https://evil.example.com", "https://studio.example.com")).toBe(false);
    expect(productIdentityMutationOriginAllowed(null, "https://studio.example.com")).toBe(false);
    expect(productIdentityMutationOriginAllowed("null", "https://studio.example.com")).toBe(false);
    expect(productIdentityMutationOriginAllowed("https://studio.example.com/path", "https://studio.example.com")).toBe(false);
    expect(productIdentityMutationOriginAllowed("http://studio.example.com", "http://studio.example.com")).toBe(false);
    expect(productIdentityMutationOriginAllowed("https://studio.example.com", undefined)).toBe(false);
  });

  it.each([
    ["APPLIED", 200],
    ["NOOP", 200],
    ["STALE", 409],
    ["SUPERSEDED", 409],
    ["CONFLICT", 409],
    ["BLOCKED", 422],
  ] as const)("does not report %s as a successful write unless appropriate", (status, expected) => {
    expect(productIdentityPromotionHttpStatus(status)).toBe(expected);
  });

  it("maps access failures without revealing tenant existence or internals", () => {
    expect(productIdentityApiError(new Error("WEB_IDENTITY_REQUIRED"))).toEqual({ error: "WEB_IDENTITY_REQUIRED", status: 401 });
    expect(productIdentityApiError(new Error("WORKSPACE_WRITE_ACCESS_DENIED"))).toEqual({ error: "PRODUCT_IDENTITY_ACCESS_DENIED", status: 403 });
    expect(productIdentityApiError(new Error("SOURCE_DOCUMENT_ACCESS_DENIED"))).toEqual({ error: "PRODUCT_IDENTITY_NOT_FOUND", status: 404 });
    expect(productIdentityApiError(new Error("PRODUCT_IDENTITY_CANDIDATE_INVALID"))).toEqual({ error: "PRODUCT_IDENTITY_NOT_PROMOTABLE", status: 409 });
    expect(productIdentityApiError(new Error("database secret password=XYZ"))).toEqual({ error: "PRODUCT_IDENTITY_REQUEST_FAILED", status: 500 });
  });
});
