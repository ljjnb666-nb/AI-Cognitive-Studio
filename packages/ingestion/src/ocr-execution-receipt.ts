import { createHash } from "node:crypto";
import { prisma, Prisma } from "@ai-cognitive/db";
import type { PdfOcrExecutionFacts, PdfOcrPageResult } from "./pdf-routing.js";
import { lockOcrSourceAuthority } from "./ocr-source-authority.js";
import { MINERU_MODEL_REVISION, APPROVED_MINERU_MANIFEST_SHA256 } from "./mineru/mineru-approved-inventory.js";
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** Append-only history under the existing page/run/source authority. This is
 * evidence, not a second retry scheduler or a second execution authority. */
export async function recordOcrExecution(facts:PdfOcrExecutionFacts,result:PdfOcrPageResult):Promise<boolean> {
 const source=facts.sourceAuthority;
 if(!source) return false;
 return prisma.$transaction(async tx=>{
  if(!await lockOcrSourceAuthority(tx,source,source)) return false;
  const page=await tx.ocrPageAttempt.findUniqueOrThrow({where:{ingestionRunId_physicalPageIndex_routingGeneration:{ingestionRunId:source.ingestionRunId,physicalPageIndex:source.physicalPageIndex,routingGeneration:source.routingGeneration}}});
  if(await tx.ocrPageExecution.findUnique({where:{pageClaimToken:source.pageClaimToken}})) return false;
  if(result.status==="SUCCEEDED") {
   if(!facts.actualTier || !facts.hostClaimToken || !facts.hostId || !facts.serverIdentity) return false;
   const live=await tx.$queryRaw<Array<{hostId:string}>>`SELECT "hostId" FROM "OcrHostLease" WHERE "hostId"=${facts.hostId} AND "claimToken"=${facts.hostClaimToken} AND "leaseUntil">clock_timestamp() FOR SHARE`;
   if(live.length!==1) return false;
  }
  if(!await lockOcrSourceAuthority(tx,source,source)) return false;
  const modelRevision=facts.actualTier==="standard"?MINERU_MODEL_REVISION:null;
  const manifestDigest=facts.actualTier==="standard"?APPROVED_MINERU_MANIFEST_SHA256:null;
  if(facts.actualTier==="standard" && facts.modelManifestSha256!==manifestDigest) return false;
  const sourceIdentity=json({sourceBlobId:source.sourceBlobId,sourceDocumentId:source.sourceDocumentId,sourceSha256:source.sourceSha256,sourceSizeBytes:source.sourceSizeBytes,storageKey:source.storageKey,planSha256:source.planSha256});
  const claimIdentity=json({pageClaimToken:source.pageClaimToken,runExecutionToken:source.runExecutionToken,hostClaimToken:facts.hostClaimToken??null,serverIdentity:facts.serverIdentity??null});
  const qualityStatus=facts.qualityDecision?.status??null;
  await tx.ocrPageExecution.create({data:{
   pageAttemptId:page.id,pageClaimToken:source.pageClaimToken,runExecutionToken:source.runExecutionToken,
   hostClaimToken:facts.hostClaimToken??null,serverIdentity:facts.serverIdentity?json(facts.serverIdentity):Prisma.DbNull,
   proposedTier:facts.proposedTier,admittedTier:facts.admittedTier??null,actualTier:facts.actualTier,
   modelRevision,manifestDigest,executionStatus:result.status,fallbackReason:facts.tierRefusalCode,
   errorCode:result.status==="FAILED"?result.errorCode:null,
   resultTextSha256:result.status==="SUCCEEDED"?createHash("sha256").update(result.text,"utf8").digest("hex"):null,
   sourceIdentity,qualityDecision:facts.qualityDecision?json(facts.qualityDecision):Prisma.DbNull,
  }});
  await tx.ocrPageAttempt.update({where:{id:page.id},data:{proposedTier:facts.proposedTier,admittedTier:facts.admittedTier??null,actualTier:facts.actualTier,
    parserMode:facts.actualTier,modelRevision,manifestDigest,executionStatus:result.status,fallbackReason:facts.tierRefusalCode,sourceIdentity,claimIdentity,qualityStatus}});
  return true;
 });
}
