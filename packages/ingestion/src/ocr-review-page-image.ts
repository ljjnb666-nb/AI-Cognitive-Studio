import {mkdtemp,mkdir,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {createWriteStream} from "node:fs";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
import type {StorageProvider} from "@ai-cognitive/storage";
import {spawnBounded} from "./mineru/mineru-process.js";
export async function renderOcrReviewSourcePage(input:{sourceStorageKey:string;sourceSizeBytes:number;sourcePdfSha256:string;physicalPageIndex:number},storage:Pick<StorageProvider,"getObjectStream">,privateTempRoot:string) {
 if(!privateTempRoot||!Number.isSafeInteger(input.sourceSizeBytes)||input.sourceSizeBytes<5||input.sourceSizeBytes>512_000_000)throw new Error("OCR_REVIEW_IMAGE_BOUNDS");
 await mkdir(privateTempRoot,{recursive:true});const dir=await mkdtemp(join(privateTempRoot,"ocr-review-"));
 try{
  const pdf=join(dir,"source.pdf"),png=join(dir,"page.png");
  let size=0;const digest=createHash("sha256");const source=await storage.getObjectStream(input.sourceStorageKey);
  await pipeline(Readable.from((async function*(){for await(const part of source){size+=part.byteLength;if(size>input.sourceSizeBytes)throw new Error("OCR_REVIEW_SOURCE_CHANGED");digest.update(part);yield part;}})()),createWriteStream(pdf,{flags:"wx",mode:0o600}));
  if(size!==input.sourceSizeBytes||digest.digest("hex")!==input.sourcePdfSha256)throw new Error("OCR_REVIEW_SOURCE_CHANGED");
  const result=await spawnBounded(process.execPath,["--max-old-space-size=384",fileURLToPath(new URL("./pdf-mixed-page-render-child.mjs",import.meta.url)),pdf,String(input.physicalPageIndex),png,"4000000"],{env:{...process.env,HTTP_PROXY:"http://127.0.0.1:9",HTTPS_PROXY:"http://127.0.0.1:9",ALL_PROXY:"http://127.0.0.1:9",NO_PROXY:"",http_proxy:"http://127.0.0.1:9",https_proxy:"http://127.0.0.1:9",all_proxy:"http://127.0.0.1:9",no_proxy:""},timeoutMs:60000,maxOutputBytes:4096});
  if(result.code!==0||result.aborted||result.timedOut||result.outputOverflow)throw new Error("OCR_REVIEW_RENDER_FAILED");
  const reply=JSON.parse(result.stdout) as {status:string;sourceSha256:string;physicalPageIndex:number;pngSha256:string;width:number;height:number};
  const pngBytes=await readFile(png);if(reply.status!=="PREVIEW_ONLY"||reply.sourceSha256!==input.sourcePdfSha256||reply.physicalPageIndex!==input.physicalPageIndex||createHash("sha256").update(pngBytes).digest("hex")!==reply.pngSha256)throw new Error("OCR_REVIEW_IMAGE_IDENTITY");
  return {pngBytes,pngSha256:reply.pngSha256,sourceSha256:reply.sourceSha256,physicalPageIndex:input.physicalPageIndex,width:reply.width,height:reply.height};
 }finally{await rm(dir,{recursive:true,force:true});}
}
