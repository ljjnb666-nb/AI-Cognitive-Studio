/** VF02: opt-in immutable PDF page PNG storage. NOT called by production routing.
 * Provenance is caller-provided; byte equality NEVER proves the page comes from
 * the claimed PDF or that any text, figure, or curve is understood.
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { ConditionalPutResult, PutObjectInput } from "@ai-cognitive/storage";

export const PDF_VISUAL_ASSET_SCHEMA = "pdf-source-visual-asset-v1";
const INVALID = "SOURCE_PDF_VISUAL_ASSET_INVALID";
const STORAGE = "SOURCE_PDF_VISUAL_ASSET_STORAGE_FAILED";
const MISMATCH = "SOURCE_PDF_VISUAL_ASSET_REPLAY_MISMATCH";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 4_000_000;
const SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
const safeId = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const safeSha = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const digest = (x: Uint8Array): string => createHash("sha256").update(x).digest("hex");

export type VisualWriteOnceStore = {
  putObjectIfAbsent(input: PutObjectInput): Promise<ConditionalPutResult>;
  headObject(key: string): Promise<{ size: number; contentType?: string } | null>;
  getObjectBytes(key: string): Promise<Uint8Array>;
};
export type PdfPageVisualInput = {
  workspaceId: string; sourceDocumentId: string;
  originalPdfSha256: string; physicalPageIndex: number;
  pngBytes: Uint8Array;
};
export type PdfPageVisualReceipt = {
  schemaVersion: typeof PDF_VISUAL_ASSET_SCHEMA;
  workspaceId: string; sourceDocumentId: string;
  originalPdfSha256: string; physicalPageIndex: number;
  privateObjectKey: string; imageSha256: string;
  byteSize: number; width: number; height: number;
  contentType: "image/png";
  storageDisposition: ConditionalPutResult;
  storedBytesVerified: true;
  sourcePdfToPageImageVerified: false;
  imageToTextAnchorsVerified: false;
  figureSemanticsVerified: false;
  independentImageGoldAvailable: false;
};

function crc32(bytes: Uint8Array): number {
  let s = 0xffffffff;
  for (const c of bytes) {
    s ^= c;
    for (let bit = 0; bit < 8; bit++) s = (s >>> 1) ^ ((s & 1) ? 0xedb88320 : 0);
  }
  return (s ^ 0xffffffff) >>> 0;
}

/** Bounded PNG structure, CRC and decompression verification, no image content logging. */
export function inspectSourcePagePng(bytes: Uint8Array): { width: number; height: number } {
  if (!(bytes instanceof Uint8Array) || bytes.length < 57 || bytes.length > MAX_BYTES ||
      !Buffer.from(bytes.subarray(0,8)).equals(SIGNATURE)) throw new Error(INVALID);
  const b = Buffer.from(bytes);
  let at=8, width=0, height=0, channels=0, gotHeader=false, gotData=false, ended=false;
  const compressed: Buffer[]=[];
  while (at+12<=b.length) {
    const n=b.readUInt32BE(at), tag=b.toString("ascii",at+4,at+8);
    if (n>MAX_BYTES || n>b.length-at-12) throw new Error(INVALID);
    const next=at+12+n;
    if (crc32(b.subarray(at+4,next-4))!==b.readUInt32BE(next-4)) throw new Error(INVALID);
    if (!gotHeader) {
      if (tag!=="IHDR" || n!==13) throw new Error(INVALID);
      width=b.readUInt32BE(at+8); height=b.readUInt32BE(at+12);
      const depth=b[at+16], color=b[at+17];
      if (!width || !height || width*height>MAX_PIXELS || depth!==8 ||
          (color!==0 && color!==2 && color!==6) ||
          b[at+18]!==0 || b[at+19]!==0 || b[at+20]!==0) throw new Error(INVALID);
      channels=color===0?1:color===2?3:4; gotHeader=true;
    } else if (tag==="IDAT") {
      compressed.push(b.subarray(at+8,next-4)); gotData=true;
    } else if (tag==="IEND") {
      if (n!==0 || !gotData || next!==b.length) throw new Error(INVALID);
      ended=true;break;
    } else if (!/^[a-zA-Z]{4}$/.test(tag) || tag[0]===tag[0]?.toUpperCase()) {
      throw new Error(INVALID); // Unsupported critical PNG chunks.
    }
    at=next;
  }
  if (!ended) throw new Error(INVALID);
  const stride=1+width*channels, count=stride*height;
  if (count>17_000_000) throw new Error(INVALID);
  let inflated: Buffer;
  try { inflated=inflateSync(Buffer.concat(compressed),{maxOutputLength:count+1}); }
  catch { throw new Error(INVALID); }
  if (inflated.length!==count) throw new Error(INVALID);
  for(let row=0;row<height;row++) if(inflated[row*stride]!>4) throw new Error(INVALID);
  return {width,height};
}

export function planPdfSourcePageVisual(input: PdfPageVisualInput):
  Omit<PdfPageVisualReceipt,"storageDisposition"|"storedBytesVerified"> {
  if (!input || !safeId(input.workspaceId) || !safeId(input.sourceDocumentId) ||
      !safeSha(input.originalPdfSha256) ||
      !Number.isSafeInteger(input.physicalPageIndex) ||
      input.physicalPageIndex<0 || input.physicalPageIndex>=2000) throw new Error(INVALID);
  const png=inspectSourcePagePng(input.pngBytes);
  const sha=digest(input.pngBytes);
  const key=["workspaces",input.workspaceId,"sources",input.sourceDocumentId,
             "pdf-visuals",input.originalPdfSha256,
             "p"+input.physicalPageIndex,sha+".png"].join("/");
  return {
    schemaVersion:PDF_VISUAL_ASSET_SCHEMA,workspaceId:input.workspaceId,
    sourceDocumentId:input.sourceDocumentId,originalPdfSha256:input.originalPdfSha256,
    physicalPageIndex:input.physicalPageIndex,privateObjectKey:key,
    imageSha256:sha,byteSize:input.pngBytes.length,width:png.width,height:png.height,
    contentType:"image/png",sourcePdfToPageImageVerified:false,
    imageToTextAnchorsVerified:false,figureSemanticsVerified:false,
    independentImageGoldAvailable:false,
  };
}

export async function persistPdfSourcePageVisual(
  store: VisualWriteOnceStore, input: PdfPageVisualInput,
): Promise<PdfPageVisualReceipt> {
  const plan=planPdfSourcePageVisual(input);
  let disposition: ConditionalPutResult;
  try {
    disposition=await store.putObjectIfAbsent({
      key:plan.privateObjectKey,body:input.pngBytes,contentType:"image/png",
    });
    if(disposition!=="CREATED" && disposition!=="ALREADY_EXISTS") throw new Error(STORAGE);
    const head=await store.headObject(plan.privateObjectKey);
    if(!head || head.size!==plan.byteSize || head.contentType!=="image/png") throw new Error(MISMATCH);
    const actual=await store.getObjectBytes(plan.privateObjectKey);
    if(actual.length!==plan.byteSize || digest(actual)!==plan.imageSha256) throw new Error(MISMATCH);
  } catch(error) {
    if(error instanceof Error && error.message===MISMATCH) throw error;
    throw new Error(STORAGE); // Never include private object keys or upstream exceptions.
  }
  return {...plan,storageDisposition:disposition,storedBytesVerified:true};
}

export async function auditPdfSourcePageVisual(
  store: Pick<VisualWriteOnceStore,"headObject"|"getObjectBytes">,
  record: PdfPageVisualReceipt,
): Promise<void> {
  if(!record || record.schemaVersion!==PDF_VISUAL_ASSET_SCHEMA ||
     record.storedBytesVerified!==true ||
     record.sourcePdfToPageImageVerified!==false ||
     record.imageToTextAnchorsVerified!==false ||
     record.figureSemanticsVerified!==false ||
     record.independentImageGoldAvailable!==false ||
     !safeId(record.workspaceId) || !safeId(record.sourceDocumentId) ||
     !safeSha(record.originalPdfSha256) || !safeSha(record.imageSha256) ||
     !Number.isSafeInteger(record.physicalPageIndex) ||
     record.physicalPageIndex<0 || record.physicalPageIndex>=2000 ||
     record.byteSize<57 || record.byteSize>MAX_BYTES ||
     record.contentType!=="image/png" ||
     record.privateObjectKey!==["workspaces",record.workspaceId,"sources",record.sourceDocumentId,
      "pdf-visuals",record.originalPdfSha256,"p"+record.physicalPageIndex,
      record.imageSha256+".png"].join("/")) throw new Error(INVALID);
  try {
    const head=await store.headObject(record.privateObjectKey);
    if(!head || head.size!==record.byteSize || head.contentType!=="image/png") throw new Error(MISMATCH);
    const stored=await store.getObjectBytes(record.privateObjectKey);
    if(stored.length!==record.byteSize || digest(stored)!==record.imageSha256) throw new Error(MISMATCH);
    const png=inspectSourcePagePng(stored);
    if(png.width!==record.width || png.height!==record.height) throw new Error(MISMATCH);
  } catch { throw new Error(MISMATCH); }
}
