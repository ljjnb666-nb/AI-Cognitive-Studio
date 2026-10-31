import { describe, expect, it } from "vitest";
import { isAuthenticatedPdfVisualRequest, isSameOriginPdfVisualRequest, isTrustedPdfVisualRequestOrigin, pdfVisualRequestConsentSchema } from "../lib/pdf-visual-request-policy";

const valid={
  mode:"FIRST_MIXED_PAGE",
  consentToExternalImageProcessing:true,
  consentToProviderCharges:true,
};

describe("paid PDF vision consent and CSRF policy",()=>{
  it("requires live session identity matching the resolved workspace identity",()=>{
    expect(isAuthenticatedPdfVisualRequest("real-user","real-user")).toBe(true);
    expect(isAuthenticatedPdfVisualRequest("real-user","dev-user-01")).toBe(false);
    expect(isAuthenticatedPdfVisualRequest(null,"dev-user-01")).toBe(false);
    expect(isAuthenticatedPdfVisualRequest(undefined,"real-user")).toBe(false);
    expect(isAuthenticatedPdfVisualRequest("","")).toBe(false);
  });
  it("only accepts explicit image AND provider-charge consents",()=>{
    expect(pdfVisualRequestConsentSchema.parse(valid)).toEqual(valid);
    expect(pdfVisualRequestConsentSchema.safeParse({...valid,consentToProviderCharges:false}).success).toBe(false);
    expect(pdfVisualRequestConsentSchema.safeParse({...valid,consentToExternalImageProcessing:false}).success).toBe(false);
    expect(pdfVisualRequestConsentSchema.safeParse({...valid,mode:"CURRENT_PAGE"}).success).toBe(false);
    expect(pdfVisualRequestConsentSchema.safeParse({mode:"FIRST_MIXED_PAGE"}).success).toBe(false);
  });
  it("rejects fabricated/legacy extra fields and implicit body consent",()=>{
    expect(pdfVisualRequestConsentSchema.safeParse({...valid,force:true}).success).toBe(false);
    expect(pdfVisualRequestConsentSchema.safeParse({...valid,consentToProviderCharges:"true"}).success).toBe(false);
  });
  it("rejects DNS rebinding and wrong canonical origin for cost-bearing requests",()=>{
    const request = "https://studio.example/api/studio/pdf-visual-review/d/mixed-graph";
    expect(isTrustedPdfVisualRequestOrigin(request,"https://studio.example","https://studio.example")).toBe(true);
    expect(isTrustedPdfVisualRequestOrigin(request,"https://studio.example",undefined)).toBe(false);
    expect(isTrustedPdfVisualRequestOrigin(request,"https://studio.example","https://other.example")).toBe(false);
    expect(isTrustedPdfVisualRequestOrigin("https://attacker.example/route","https://attacker.example","https://studio.example")).toBe(false);
    expect(isTrustedPdfVisualRequestOrigin("http://studio.example/route","http://studio.example","http://studio.example")).toBe(false);
    expect(isTrustedPdfVisualRequestOrigin("http://localhost:3001/api","http://localhost:3001","http://localhost:3001")).toBe(true);
  });
  it("requires exact same origin for a cost-sensitive POST",()=>{
    expect(isSameOriginPdfVisualRequest("https://studio.example/api/studio/pdf-visual-review/x","https://studio.example")).toBe(true);
    expect(isSameOriginPdfVisualRequest("https://studio.example/api/studio/pdf-visual-review/x","https://other.example")).toBe(false);
    expect(isSameOriginPdfVisualRequest("https://studio.example/api/studio/pdf-visual-review/x",null)).toBe(false);
    expect(isSameOriginPdfVisualRequest("https://studio.example/api/studio/pdf-visual-review/x","null")).toBe(false);
    expect(isSameOriginPdfVisualRequest("https://studio.example/api/studio/pdf-visual-review/x","https://studio.example.evil.test")).toBe(false);
    expect(isSameOriginPdfVisualRequest("http://localhost:3001/api/studio/pdf-visual-review/x","http://localhost:3001")).toBe(true);
    expect(isSameOriginPdfVisualRequest("http://localhost:3001/api/studio/pdf-visual-review/x","http://localhost:3002")).toBe(false);
    expect(isSameOriginPdfVisualRequest("https://studio.example/api/studio/pdf-visual-review/x","https://studio.example/extra")).toBe(false);
  });
});
