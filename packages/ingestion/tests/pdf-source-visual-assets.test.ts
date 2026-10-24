import { describe, expect, it } from "vitest";
import { auditPdfSourcePageVisual, inspectSourcePagePng, persistPdfSourcePageVisual, planPdfSourcePageVisual, type VisualWriteOnceStore } from "../src/pdf-source-visual-assets.js";

// Public synthetic single-pixel PNG, not book content or OCR text.
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
const sourceHash="a".repeat(64);
const args=()=>({workspaceId:"tenantA",sourceDocumentId:"bookOne",originalPdfSha256:sourceHash,physicalPageIndex:109,pngBytes:new Uint8Array(png)});

class WriteOnceFake implements VisualWriteOnceStore {
  readonly objects=new Map<string,{bytes:Uint8Array;contentType:string}>();
  readonly events: string[]=[];
  async putObjectIfAbsent(input:{key:string;body:Uint8Array;contentType:string}) {
    this.events.push("CONDITIONAL_PUT");
    if(this.objects.has(input.key)) return "ALREADY_EXISTS" as const;
    this.objects.set(input.key,{bytes:new Uint8Array(input.body),contentType:input.contentType});
    return "CREATED" as const;
  }
  async headObject(key:string) {
    const x=this.objects.get(key);
    return x?{size:x.bytes.length,contentType:x.contentType}:null;
  }
  async getObjectBytes(key:string) {
    const x=this.objects.get(key);
    if(!x) throw Error("NOT_FOUND");
    return new Uint8Array(x.bytes);
  }
}

describe("VF02 opt-in PDF source page visual asset",()=>{
  it("parses the bounded synthetic source PNG without inventing source authority",()=>{
    const d=inspectSourcePagePng(png);
    expect(d).toEqual({width:1,height:1});
    const a=planPdfSourcePageVisual(args());
    expect(a.privateObjectKey).toMatch(/^workspaces\/tenantA\/sources\/bookOne\/pdf-visuals\//);
    expect(a.privateObjectKey).toContain("/p109/");
    expect(a.sourcePdfToPageImageVerified).toBe(false);
    expect(a.figureSemanticsVerified).toBe(false);
    expect(a.imageToTextAnchorsVerified).toBe(false);
  });

  it("creates exactly once, replays immutable bytes and never overwrites",async()=>{
    const store=new WriteOnceFake();
    const one=await persistPdfSourcePageVisual(store,args());
    const again=await persistPdfSourcePageVisual(store,args());
    expect(one.storageDisposition).toBe("CREATED");
    expect(again.storageDisposition).toBe("ALREADY_EXISTS");
    expect(one.privateObjectKey).toBe(again.privateObjectKey);
    expect(store.objects.size).toBe(1);
    expect(one.storedBytesVerified).toBe(true);
    await expect(auditPdfSourcePageVisual(store,one)).resolves.toBeUndefined();
    expect(store.events).toEqual(["CONDITIONAL_PUT","CONDITIONAL_PUT"]);
  });

  it("rejects content tampering even when the existing key and size remain valid",async()=>{
    const store=new WriteOnceFake();
    const receipt=await persistPdfSourcePageVisual(store,args());
    const entity=store.objects.get(receipt.privateObjectKey)!;
    entity.bytes[entity.bytes.length-1]! ^= 0x3;
    await expect(auditPdfSourcePageVisual(store,receipt)).rejects.toThrow("SOURCE_PDF_VISUAL_ASSET_REPLAY_MISMATCH");
    await expect(persistPdfSourcePageVisual(store,args())).rejects.toThrow("SOURCE_PDF_VISUAL_ASSET_REPLAY_MISMATCH");
  });

  it("strictly separates tenant/document/page/PDF hashes in object identity",()=>{
    const base=planPdfSourcePageVisual(args()).privateObjectKey;
    const tenant=planPdfSourcePageVisual({...args(),workspaceId:"tenantB"}).privateObjectKey;
    const document=planPdfSourcePageVisual({...args(),sourceDocumentId:"bookTwo"}).privateObjectKey;
    const page=planPdfSourcePageVisual({...args(),physicalPageIndex:110}).privateObjectKey;
    const source=planPdfSourcePageVisual({...args(),originalPdfSha256:"b".repeat(64)}).privateObjectKey;
    expect(new Set([base,tenant,document,page,source]).size).toBe(5);
  });

  it("fail-closes path traversal, malformed metadata and corrupt/truncated PNGs before write",()=>{
    const badInputs=[
      {...args(),workspaceId:"../tenant"},
      {...args(),workspaceId:"a/b"},
      {...args(),sourceDocumentId:"book\\two"},
      {...args(),originalPdfSha256:"bad"},
      {...args(),physicalPageIndex:-1},
      {...args(),physicalPageIndex:2000},
      {...args(),pngBytes:new Uint8Array([1,2,3])},
      {...args(),pngBytes:png.subarray(0,png.length-5)},
    ];
    for(const bad of badInputs) expect(()=>planPdfSourcePageVisual(bad)).toThrow("SOURCE_PDF_VISUAL_ASSET_INVALID");
  });

  it("cannot turn the storage receipt into figure verification",async()=>{
    const store=new WriteOnceFake();
    const receipt=await persistPdfSourcePageVisual(store,args());
    await expect(auditPdfSourcePageVisual(store,{...receipt,figureSemanticsVerified:true as false})).rejects.toThrow("SOURCE_PDF_VISUAL_ASSET_INVALID");
    await expect(auditPdfSourcePageVisual(store,{...receipt,sourcePdfToPageImageVerified:true as false})).rejects.toThrow("SOURCE_PDF_VISUAL_ASSET_INVALID");
    await expect(auditPdfSourcePageVisual(store,{...receipt,privateObjectKey:"workspaces/other/source.png"})).rejects.toThrow("SOURCE_PDF_VISUAL_ASSET_INVALID");
  });

  it("concurrent identical attempts never create two objects",async()=>{
    const store=new WriteOnceFake();
    const reports=await Promise.all(Array.from({length:6},()=>persistPdfSourcePageVisual(store,args())));
    expect(store.objects.size).toBe(1);
    expect(reports.filter(r=>r.storageDisposition==="CREATED")).toHaveLength(1);
    expect(reports.filter(r=>r.storageDisposition==="ALREADY_EXISTS")).toHaveLength(5);
  });

  it("storage failures are stable and do not leak private keys or original error messages",async()=>{
    const store=new WriteOnceFake();
    store.putObjectIfAbsent=async()=>{throw Error("SECRET_BUCKET_TOKEN_DO_NOT_LOG");};
    await expect(persistPdfSourcePageVisual(store,args())).rejects.toThrow("SOURCE_PDF_VISUAL_ASSET_STORAGE_FAILED");
    try { await persistPdfSourcePageVisual(store,args()); }
    catch(error) {
      expect(String(error)).not.toContain("SECRET_BUCKET_TOKEN");
      expect(String(error)).not.toContain("tenantA");
    }
  });
});
