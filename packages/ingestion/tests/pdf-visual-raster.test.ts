import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import type { PutObjectInput } from "@ai-cognitive/storage";
import { auditPdfSourcePageVisual, inspectSourcePagePng, type VisualWriteOnceStore } from "../src/pdf-source-visual-assets.js";
import { renderAndStorePdfSourcePage } from "../src/pdf-visual-raster.js";

class MemoryStore implements VisualWriteOnceStore {
  public readonly data=new Map<string,{raw:Uint8Array;type:string}>();
  async putObjectIfAbsent(input:PutObjectInput) {
    if(this.data.has(input.key))return "ALREADY_EXISTS" as const;
    this.data.set(input.key,{raw:new Uint8Array(input.body),type:input.contentType});
    return "CREATED" as const;
  }
  async headObject(key:string) {
    const item=this.data.get(key);
    return item?{size:item.raw.length,contentType:item.type}:null;
  }
  async getObjectBytes(key:string) {
    const item=this.data.get(key);
    if(!item)throw Error("missing");
    return new Uint8Array(item.raw);
  }
}
async function syntheticPdf():Promise<Uint8Array> {
  const doc=new PDFDocument({autoFirstPage:false,compress:false});
  const out=new PassThrough();
  const parts:Buffer[]=[];
  out.on("data",(chunk:Buffer)=>parts.push(chunk));
  const ready=new Promise<Uint8Array>((resolve,reject)=>{
    out.on("end",()=>resolve(new Uint8Array(Buffer.concat(parts))));
    out.on("error",reject);
  });
  doc.pipe(out);
  doc.addPage({size:[300,360]});
  doc.fontSize(18).text("SYNTHETIC PAGE ONE",32,35);
  doc.fillColor("#d00000").rect(32,100,170,100).fill();
  doc.addPage({size:[300,360]});
  doc.fontSize(18).text("SYNTHETIC PAGE TWO",32,35);
  doc.fillColor("#0000d0").circle(115,165,65).fill();
  doc.end();
  return await ready;
}
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");

describe("VF03 isolated PDF source page renderer (synthetic-only)",()=>{
  it("renders an actual PDF.js page into a SHA-pinned private immutable PNG and safely replays it",async()=>{
    const pdf=await syntheticPdf();
    const store=new MemoryStore();
    const input={workspaceId:"tenantA",sourceDocumentId:"syntheticBook",pdfBytes:pdf,
      expectedOriginalPdfSha256:sha(pdf),physicalPageIndex:0};
    const first=await renderAndStorePdfSourcePage(store,input);
    expect(first.storageDisposition).toBe("CREATED");
    expect(first.privateObjectKey).toContain("pdf-visuals/"+sha(pdf)+"/p0/");
    expect(first.width).toBe(300);
    expect(first.height).toBe(360);
    expect(first.sourcePdfToPageImageVerified).toBe(false);
    expect(first.imageToTextAnchorsVerified).toBe(false);
    expect(first.figureSemanticsVerified).toBe(false);
    expect(first.independentImageGoldAvailable).toBe(false);
    expect(inspectSourcePagePng(await store.getObjectBytes(first.privateObjectKey))).toEqual({width:300,height:360});
    await expect(auditPdfSourcePageVisual(store,first)).resolves.toBeUndefined();
    const replay=await renderAndStorePdfSourcePage(store,input);
    expect(replay.storageDisposition).toBe("ALREADY_EXISTS");
    expect(replay.imageSha256).toBe(first.imageSha256);
    expect(store.data.size).toBe(1);
  },60_000);

  it("keeps different source physical pages at distinct immutable locations",async()=>{
    const pdf=await syntheticPdf();
    const store=new MemoryStore();
    const base={workspaceId:"tenantA",sourceDocumentId:"syntheticBook",pdfBytes:pdf,
      expectedOriginalPdfSha256:sha(pdf)};
    const first=await renderAndStorePdfSourcePage(store,{...base,physicalPageIndex:0});
    const second=await renderAndStorePdfSourcePage(store,{...base,physicalPageIndex:1});
    expect(first.privateObjectKey).not.toBe(second.privateObjectKey);
    expect(first.imageSha256).not.toBe(second.imageSha256);
    expect(store.data.size).toBe(2);
  },60_000);

  it("blocks mismatched original PDF identity before any page render or storage mutation",async()=>{
    const pdf=await syntheticPdf();
    const store=new MemoryStore();
    await expect(renderAndStorePdfSourcePage(store,{
      workspaceId:"tenantA",sourceDocumentId:"syntheticBook",pdfBytes:pdf,
      expectedOriginalPdfSha256:"f".repeat(64),physicalPageIndex:0,
    })).rejects.toThrow("SOURCE_PDF_VISUAL_RENDER_SOURCE_MISMATCH");
    expect(store.data.size).toBe(0);
  },30_000);

  it("fails closed on invalid page bounds without creating a private image",async()=>{
    const pdf=await syntheticPdf();
    const store=new MemoryStore();
    const common={workspaceId:"tenantA",sourceDocumentId:"syntheticBook",pdfBytes:pdf,
      expectedOriginalPdfSha256:sha(pdf)};
    await expect(renderAndStorePdfSourcePage(store,{...common,physicalPageIndex:9}))
      .rejects.toThrow("SOURCE_PDF_VISUAL_RENDER_FAILED");
    await expect(renderAndStorePdfSourcePage(store,{...common,physicalPageIndex:-1}))
      .rejects.toThrow("SOURCE_PDF_VISUAL_RENDER_FAILED");
    expect(store.data.size).toBe(0);
  },30_000);

  it("never publishes document parsing diagnostics or untrusted source content in thrown errors",async()=>{
    const source=new Uint8Array(Buffer.from("%PDF-SECRET_CHINESE_PAGE_TEXT_DO_NOT_LOG"));
    const store=new MemoryStore();
    try {
      await renderAndStorePdfSourcePage(store,{
        workspaceId:"tenantA",sourceDocumentId:"syntheticBook",
        pdfBytes:source,expectedOriginalPdfSha256:sha(source),physicalPageIndex:0,
      });
      throw Error("INCORRECTLY_ACCEPTED");
    } catch(error) {
      expect(String(error)).toContain("SOURCE_PDF_VISUAL_RENDER_FAILED");
      expect(String(error)).not.toContain("SECRET_CHINESE_PAGE_TEXT");
      expect(String(error)).not.toContain("tenantA");
    }
    expect(store.data.size).toBe(0);
  },30_000);
});
