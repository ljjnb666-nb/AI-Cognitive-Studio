import { createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import type { StorageProvider } from "@ai-cognitive/storage";
import { parseRoutingPlan, type PdfRoutingPlan } from "../pdf-routing.js";
import {
  DOCLING_LAYOUT_ID, DOCLING_LAYOUT_VERSION, type DoclingLayoutCandidate,
  type DoclingLayoutHandle,
} from "./docling-layout-executor.js";

export const DOCLING_LAYOUT_SIDECAR_SCHEMA = "docling-layout-sidecar-v1";
const SOURCE_MAX_BYTES = 110_000_000;
const CANDIDATE_MAX_CHARS = 160_000;
const CANDIDATE_MAX_BYTES = 800_000;

function sha256(bytes:Uint8Array):string {
  return createHash("sha256").update(bytes).digest("hex");
}
function validDigest(value:string):boolean {return /^[a-f0-9]{64}$/.test(value);}

/** Pure, bounded condition selector. No automatic full-book Docling fanout. */
export function selectDoclingLayoutPages(plan:PdfRoutingPlan,limit=2):number[] {
  const validated=parseRoutingPlan(plan);
  if(!Number.isSafeInteger(limit)||limit<0||limit>3)
    throw new Error("DOCLING_LAYOUT_PAGE_BUDGET_INVALID");
  return validated.pages
    .filter(page=>page.route==="OCR_REQUIRED"&&page.contentEvidence==="NON_TEXT_CONTENT" &&
      page.reasonCodes.some(reason=>reason==="IMAGE_CONTENT_WITHOUT_TEXT"||
        reason==="VECTOR_CONTENT_WITHOUT_TEXT"))
    .slice(0,limit).map(page=>page.physicalPageIndex);
}
export type DoclingSidecarInput = {
  workspaceId:string;sourceDocumentId:string;ingestionRunId:string;
  physicalPageIndex:number;pdfBytes:Uint8Array;
  storage:StorageProvider;executor:DoclingLayoutHandle;
  /** Optional PostgreSQL owner fence for queue-managed execution. */
  claim?:{id:string;token:string};
};
export type DoclingSidecarReceipt = {
  authority:"NON_AUTHORITATIVE_LAYOUT_CANDIDATE";
  id:string;physicalPageIndex:number;
  parserName:typeof DOCLING_LAYOUT_ID;
  parserVersion:typeof DOCLING_LAYOUT_VERSION;
  modelSha256:string;markdownSha256:string;markdownStorageKey:string;reused:boolean;
};
type Stored = {
  id:string;workspaceId:string;sourceDocumentId:string;ingestionRunId:string;
  physicalPageIndex:number;routingGeneration:number;sourceSha256:string;
  parserName:string;parserVersion:string;modelSha256:string;
  markdownSha256:string;markdownStorageKey:string;
  textItemCount:number;pictureItemCount:number;tableItemCount:number;
};
function storageKey(input:DoclingSidecarInput,generation:number,modelSha:string,markdownSha:string):string {
  return "workspaces/"+input.workspaceId+"/extractions/"+input.ingestionRunId+
    "/docling-layout-candidates/v1/pages/"+input.physicalPageIndex+
    "/generations/"+generation+"/models/"+modelSha+"/"+markdownSha+".md";
}
function isUniqueConflict(error:unknown):boolean {
  return typeof error==="object"&&error!==null&&"code" in error&&error.code==="P2002";
}
async function validatedStoredSnapshot(
  existing:Stored,input:DoclingSidecarInput,generation:number,sourceSha:string,
):Promise<DoclingSidecarReceipt> {
  if(existing.workspaceId!==input.workspaceId||existing.sourceDocumentId!==input.sourceDocumentId||
     existing.ingestionRunId!==input.ingestionRunId||
     existing.physicalPageIndex!==input.physicalPageIndex||
     existing.routingGeneration!==generation||existing.sourceSha256!==sourceSha||
     existing.parserName!==DOCLING_LAYOUT_ID||
     existing.parserVersion!==DOCLING_LAYOUT_VERSION||
     existing.modelSha256!==input.executor.modelSha256||
     !validDigest(existing.markdownSha256)||
     existing.markdownStorageKey!==storageKey(input,generation,existing.modelSha256,existing.markdownSha256))
    throw new Error("DOCLING_LAYOUT_REPLAY_CONFLICT");
  const bytes=await input.storage.getObjectBytes(existing.markdownStorageKey);
  if(bytes.length>CANDIDATE_MAX_BYTES||sha256(bytes)!==existing.markdownSha256)
    throw new Error("DOCLING_LAYOUT_REPLAY_ARTIFACT_INVALID");
  return {
    authority:"NON_AUTHORITATIVE_LAYOUT_CANDIDATE",id:existing.id,
    physicalPageIndex:existing.physicalPageIndex,parserName:DOCLING_LAYOUT_ID,
    parserVersion:DOCLING_LAYOUT_VERSION,modelSha256:existing.modelSha256,
    markdownSha256:existing.markdownSha256,
    markdownStorageKey:existing.markdownStorageKey,reused:true,
  };
}
function candidateIsValid(value:DoclingLayoutCandidate,input:DoclingSidecarInput):boolean {
  return value.authority==="NON_AUTHORITATIVE_LAYOUT_CANDIDATE"&&
    value.sourceMethod==="DOCLING_LAYOUT_CANDIDATE_ONLY"&&
    value.ocrUsed===false&&value.fullPageReference===false&&
    value.physicalPageIndex===input.physicalPageIndex&&
    value.parserName===DOCLING_LAYOUT_ID&&value.parserVersion===DOCLING_LAYOUT_VERSION&&
    value.artifactSha256===input.executor.modelSha256&&
    typeof value.markdown==="string"&&value.markdown.length<=CANDIDATE_MAX_CHARS&&
    !value.markdown.includes("\0")&&
    [value.textItemCount,value.pictureItemCount,value.tableItemCount].every(n=>
      Number.isSafeInteger(n)&&n>=0&&n<=100000);
}

/**
 * Explicit post-ingestion operation, NOT the critical PDF publication path.
 * Content-addressed sidecar metadata has no link to current extraction, text
 * blocks or downstream analysis, and cannot promote a candidate into gold.
 * Duplicate calls reuse a hash-verified snapshot without further model runs.
 */
export async function inspectAndPersistDoclingLayoutSidecar(
  input:DoclingSidecarInput,
):Promise<DoclingSidecarReceipt> {
  if(!input.workspaceId||!input.sourceDocumentId||!input.ingestionRunId||
     !Number.isSafeInteger(input.physicalPageIndex)||input.physicalPageIndex<0||
     input.pdfBytes.length<5||input.pdfBytes.length>SOURCE_MAX_BYTES||
     !validDigest(input.executor.modelSha256))
    throw new Error("DOCLING_LAYOUT_INPUT_INVALID");

  const run=await prisma.ingestionRun.findUnique({
    where:{id:input.ingestionRunId},
    include:{sourceDocument:true,extraction:true},
  });
  const sourceSha=sha256(input.pdfBytes);
  if(!run||run.status!=="SUCCEEDED"||run.workspaceId!==input.workspaceId||
     run.sourceDocumentId!==input.sourceDocumentId||
     run.sourceDocument.sha256!==sourceSha||
     run.sourceDocument.workspaceId!==input.workspaceId||
     run.sourceDocument.mediaType!=="application/pdf"||
     run.extraction?.status!=="SUCCEEDED"||
     run.extraction.workspaceId!==input.workspaceId||
     run.extraction.sourceDocumentId!==input.sourceDocumentId||
     run.routingGeneration===null||run.routingPlan===null)
    throw new Error("DOCLING_LAYOUT_SOURCE_AUTHORITY_MISMATCH");

  const plan=parseRoutingPlan(run.routingPlan);
  if(!selectDoclingLayoutPages(plan,3).includes(input.physicalPageIndex))
    throw new Error("DOCLING_LAYOUT_PAGE_NOT_ELIGIBLE");
  const generation=run.routingGeneration;
  const key={
    ingestionRunId:input.ingestionRunId,physicalPageIndex:input.physicalPageIndex,
    routingGeneration:generation,parserName:DOCLING_LAYOUT_ID,
    parserVersion:DOCLING_LAYOUT_VERSION,modelSha256:input.executor.modelSha256,
  };
  const where={byPageAndModel:key};
  const previous=await prisma.doclingLayoutSnapshot.findUnique({where});
  if(previous)return validatedStoredSnapshot(previous,input,generation,sourceSha);

  const result=await input.executor.inspect({
    pdfBytes:input.pdfBytes,physicalPageIndex:input.physicalPageIndex,
  });
  if(result.status!=="SUCCEEDED"||!candidateIsValid(result.candidate,input))
    throw new Error("DOCLING_LAYOUT_CANDIDATE_REJECTED");

  const markdownBytes=Buffer.from(result.candidate.markdown,"utf8");
  if(markdownBytes.length>CANDIDATE_MAX_BYTES)
    throw new Error("DOCLING_LAYOUT_ARTIFACT_BUDGET_EXCEEDED");
  const markdownSha256=sha256(markdownBytes);
  const markdownStorageKey=storageKey(input,generation,input.executor.modelSha256,markdownSha256);
  await input.storage.putObject({key:markdownStorageKey,body:markdownBytes,contentType:"text/markdown; charset=utf-8"});
  const data={
    workspaceId:input.workspaceId,sourceDocumentId:input.sourceDocumentId,
    ingestionRunId:input.ingestionRunId,physicalPageIndex:input.physicalPageIndex,
    routingGeneration:generation,sourceSha256:sourceSha,
    parserName:DOCLING_LAYOUT_ID,parserVersion:DOCLING_LAYOUT_VERSION,
    modelSha256:input.executor.modelSha256,markdownSha256,markdownStorageKey,
    textItemCount:result.candidate.textItemCount,
    pictureItemCount:result.candidate.pictureItemCount,
    tableItemCount:result.candidate.tableItemCount,
  };
  try{
    const created=input.claim
      ? await prisma.$transaction(async tx=>{
          // Row lock and snapshot INSERT share one transaction. A reclaimed or
          // expired previous owner may leave an unreferenced S3 blob, but it
          // cannot persist a metadata record under a stale claim token.
          const alive=await tx.$queryRaw<Array<{id:string}>>`
            SELECT "id" FROM "DoclingLayoutTask"
            WHERE "id" = ${input.claim!.id}
              AND "claimToken" = ${input.claim!.token}
              AND "status" = 'RUNNING'::"DoclingLayoutTaskStatus"
              AND "leaseUntil" > NOW()
              AND "ingestionRunId" = ${input.ingestionRunId}
              AND "workspaceId" = ${input.workspaceId}
              AND "sourceDocumentId" = ${input.sourceDocumentId}
              AND "physicalPageIndex" = ${input.physicalPageIndex}
              AND "routingGeneration" = ${generation}
              AND "modelSha256" = ${input.executor.modelSha256}
            FOR UPDATE
          `;
          if(alive.length!==1)throw new Error("DOCLING_LAYOUT_STALE_OWNER");
          return tx.doclingLayoutSnapshot.create({data});
        })
      : await prisma.doclingLayoutSnapshot.create({data});
    return {
      authority:"NON_AUTHORITATIVE_LAYOUT_CANDIDATE",id:created.id,
      physicalPageIndex:created.physicalPageIndex,parserName:DOCLING_LAYOUT_ID,
      parserVersion:DOCLING_LAYOUT_VERSION,modelSha256:created.modelSha256,
      markdownSha256:created.markdownSha256,
      markdownStorageKey:created.markdownStorageKey,reused:false,
    };
  }catch(error){
    if(!isUniqueConflict(error))throw error;
    const winner=await prisma.doclingLayoutSnapshot.findUnique({where});
    if(!winner)throw new Error("DOCLING_LAYOUT_RACE_WITHOUT_WINNER");
    if(winner.markdownSha256!==markdownSha256)
      throw new Error("DOCLING_LAYOUT_REPLAY_CONFLICT");
    return validatedStoredSnapshot(winner,input,generation,sourceSha);
  }
}
