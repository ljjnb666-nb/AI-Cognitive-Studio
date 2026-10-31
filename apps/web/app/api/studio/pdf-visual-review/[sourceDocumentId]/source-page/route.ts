import {NextResponse} from "next/server";
import {sourceDetail} from "@/lib/product";
import {storage} from "@/lib/storage";
import {readOcrStructureReviewEvidence,renderOcrReviewSourcePage} from "@ai-cognitive/ingestion";
export const runtime="nodejs";
const headers={"Cache-Control":"private, no-store, max-age=0","X-Content-Type-Options":"nosniff","Cross-Origin-Resource-Policy":"same-origin"};
/** Local bounded raster of the authoritative source page, never a model image
 * or OCR reconstruction. Avoid depending on an embedded browser PDF viewer's
 * scrolling/zoom state when comparing a single physical page. */
export async function GET(request:Request,{params}:{params:Promise<{sourceDocumentId:string}>}){
 try{
  const root=process.env.PDF_REVIEW_PRIVATE_TEMP_ROOT;if(!root)throw Error();
  const {sourceDocumentId}=await params,source=await sourceDetail(sourceDocumentId);
  const query=new URL(request.url).searchParams,page=query.get("page"),run=source.ingestionRuns[0];
  if(!page||!/^(0|[1-9]\d{0,3})$/.test(page)||Number(page)>1999||!run||query.get("run")!==run.id||query.get("sha")!==source.sha256)throw Error();
  const key={workspaceId:source.workspaceId,sourceDocumentId:source.id,ingestionRunId:run.id,physicalPageIndex:Number(page)};
  const evidence=await readOcrStructureReviewEvidence(key,storage());if(query.get("receipt")!==evidence.receiptId)throw Error();
  const image=await renderOcrReviewSourcePage(evidence,storage(),root);
  const current=await readOcrStructureReviewEvidence(key,storage());if(current.receiptId!==evidence.receiptId||current.sourcePdfSha256!==image.sourceSha256||current.textSha256!==evidence.textSha256)throw Error();
  return new Response(image.pngBytes,{headers:{...headers,"Content-Type":"image/png","Content-Length":String(image.pngBytes.byteLength),"X-Source-Pdf-Sha256":image.sourceSha256,"X-Source-Physical-Page":String(image.physicalPageIndex),"X-Source-Png-Sha256":image.pngSha256}});
 }catch(error){console.warn("pdf.ocr.source-page.unavailable",{code:error instanceof Error&&/^OCR_REVIEW_[A-Z_]+$/.test(error.message)?error.message:"SOURCE_PAGE_UNAVAILABLE"});return NextResponse.json({error:"PDF_SOURCE_PAGE_UNAVAILABLE"},{status:404,headers});}
}
