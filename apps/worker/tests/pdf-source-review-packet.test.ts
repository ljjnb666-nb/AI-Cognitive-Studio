import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPdfSourceReviewPacket, PDF_SOURCE_REVIEW_TEXT_LIMIT } from "../src/pdf-source-review-packet.js";

const bytes=new TextEncoder().encode("%PDF-1.7\nSYNTHETIC");
const sha=(raw:Uint8Array)=>createHash("sha256").update(raw).digest("hex");
const hash=sha(bytes);
const pngSha="a".repeat(64);

function fixture() {
  const native={
    pageCount:2,
    routingPlan:{pages:[{physicalPageIndex:0,route:"NATIVE_TEXT"},{physicalPageIndex:1,route:"NATIVE_TEXT"}]},
    pages:[
      {physicalPageIndex:0,inspection:{hasTextEvidence:true},
       blocks:[{text:"Synthetic heading"},{text:"Synthetic body"}]},
      {physicalPageIndex:1,inspection:{hasTextEvidence:true},blocks:[{text:"Other page"}]},
    ],
  };
  const vision={
    pageCount:2,examinedPageCount:1,authority:"UNVERIFIED_VISUAL_CANDIDATE",
    goldApproved:false,productionRoutingChanged:false,nativeTextUnchanged:true,
    pages:[{
      physicalPageIndex:0,sourceSha256:hash,pngSha256:pngSha,
      authority:"UNVERIFIED_VISUAL_CANDIDATE",figureSemantics:"UNVERIFIED",
      status:"CANDIDATE_AVAILABLE",figures:[{
        id:"diagram1",kind:"DIAGRAM",bbox:[10,20,100,120],caption:"Synthetic diagram",
        nodes:[{id:"x",label:"first"},{id:"y",label:"second"}],
        edges:[{from:"x",to:"y",label:"next",direction:"DIRECTED"}],
      }],
    }],
  };
  return {native,vision};
}
type Native=Parameters<typeof buildPdfSourceReviewPacket>[1];
type Vision=Parameters<typeof buildPdfSourceReviewPacket>[2];
function make(native:unknown,vision:unknown) {
  return buildPdfSourceReviewPacket(bytes,native as Native,vision as Vision);
}

describe("source-bound PDF native + visual review packet",()=>{
  it("joins native text and graph from exactly the same PDF and physical page without approval",()=>{
    const f=fixture();
    const r=make(f.native,f.vision);
    expect(r).toMatchObject({
      authority:"SOURCE_BOUND_REVIEW_ONLY",sourcePdfSha256:hash,
      totalPhysicalPages:2,examinedPages:1,independentGoldApproved:false,
      approvedForBookIntelligence:false,approvedForPodcast:false,
      persistedReviewCandidate:false,canonicalTextUpdated:false,
    });
    expect(r.pages[0]).toMatchObject({
      physicalPageIndex:0,sourcePdfSha256:hash,sourcePngSha256:pngSha,
      nativeText:{status:"EXTRACTED_UNVERIFIED",sourceMethod:"PDFJS_NATIVE",
                  excerpt:"Synthetic heading\nSynthetic body",excerptTruncated:false,sourceBlockCount:2},
      visual:{status:"CANDIDATE_UNVERIFIED",failureReason:null},
      reviewRequired:true,approvedForBookIntelligence:false,approvedForPodcast:false,
    });
    expect(r.pages[0]?.visual.figures[0]?.edges[0]?.direction).toBe("DIRECTED");
  });
  it("refuses cross-document SHA, wrong page and duplicate page",()=>{
    const f=fixture();
    f.vision.pages[0]!.sourceSha256="0".repeat(64);
    expect(()=>make(f.native,f.vision)).toThrow("PDF_REVIEW_PACKET_SOURCE_OR_AUTHORITY_INVALID");
    f.vision.pages[0]!.sourceSha256=hash;
    f.vision.pages[0]!.physicalPageIndex=3;
    expect(()=>make(f.native,f.vision)).toThrow("PDF_REVIEW_PACKET_SOURCE_OR_AUTHORITY_INVALID");
    f.vision.pages[0]!.physicalPageIndex=0;
    f.vision.pages.push({...f.vision.pages[0]!});
    f.vision.examinedPageCount=2;
    expect(()=>make(f.native,f.vision)).toThrow("PDF_REVIEW_PACKET_SOURCE_OR_AUTHORITY_INVALID");
  });
  it("rejects OCR-routed page masquerading as native",()=>{
    const f=fixture();
    f.native.routingPlan.pages[0]!.route="OCR_REQUIRED";
    expect(()=>make(f.native,f.vision)).toThrow("PDF_REVIEW_PACKET_SOURCE_OR_AUTHORITY_INVALID");
  });
  it("bounds native preview and marks a truncated excerpt",()=>{
    const f=fixture();
    f.native.pages[0]!.blocks=[{text:"X".repeat(PDF_SOURCE_REVIEW_TEXT_LIMIT+250)}];
    const r=make(f.native,f.vision);
    expect(r.pages[0]?.nativeText.excerpt.length).toBe(PDF_SOURCE_REVIEW_TEXT_LIMIT);
    expect(r.pages[0]?.nativeText.excerptTruncated).toBe(true);
  });
  it("preserves model failure and never transforms it into empty verified chart",()=>{
    const f=fixture();
    f.vision.pages[0]!.status="REVIEW_REQUIRED";
    const raw=f.vision.pages[0] as typeof f.vision.pages[0] & {failureReason?:string};
    raw.failureReason="VISION_REJECTED";
    raw.figures=[];
    const r=make(f.native,f.vision);
    expect(r.pages[0]?.visual).toMatchObject({
      status:"REVIEW_REQUIRED",figures:[],failureReason:"VISION_REJECTED",
    });
    expect(r.pages[0]?.approvedForPodcast).toBe(false);
  });
  it("rejects claimed Gold or inconsistent failure status",()=>{
    const f=fixture();
    f.vision.goldApproved=true;
    expect(()=>make(f.native,f.vision)).toThrow("PDF_REVIEW_PACKET_SOURCE_OR_AUTHORITY_INVALID");
    f.vision.goldApproved=false;
    f.vision.pages[0]!.status="REVIEW_REQUIRED";
    expect(()=>make(f.native,f.vision)).toThrow("PDF_REVIEW_PACKET_SOURCE_OR_AUTHORITY_INVALID");
  });
  it("rejects textless native blocks to avoid inventing substantive source text",()=>{
    const f=fixture();
    f.native.pages[0]!.blocks=[{text:"   "}];
    expect(()=>make(f.native,f.vision)).toThrow("PDF_REVIEW_PACKET_SOURCE_OR_AUTHORITY_INVALID");
  });
});
