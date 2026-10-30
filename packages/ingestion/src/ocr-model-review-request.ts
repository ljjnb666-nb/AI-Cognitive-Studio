import {createHash} from "node:crypto";
import {prisma,type Prisma} from "@ai-cognitive/db";
import {lockOcrReviewEvidence,type OcrReviewPageKey} from "./ocr-structure-review-evidence.js";
export const OCR_MODEL_REVIEW_JOB="pdf.ocr.structure-review";
export const OCR_MODEL_REVIEW_CONSENT="send-one-original-page-and-ocr-to-workspace-vision-model-v1";
export async function lockOcrReviewMember(tx:Prisma.TransactionClient,workspaceId:string,userId:string) {
 const rows=await tx.$queryRaw<Array<{role:string}>>`SELECT "role" FROM "WorkspaceMember" WHERE "workspaceId"=${workspaceId} AND "userId"=${userId} FOR SHARE`;
 if(rows.length!==1||!["OWNER","EDITOR"].includes(rows[0]!.role))throw new Error("OCR_REVIEW_FORBIDDEN");
}
/** Existing Job is the sole one-time request/claim authority. Repeated clicks
 * return the same job, including uncertain RUNNING or failed paid outcomes. */
export async function requestOcrModelReview(input:OcrReviewPageKey & {userId:string;receiptId:string;textSha256:string;sourcePdfSha256:string;consent:string}) {
 if(input.consent!==OCR_MODEL_REVIEW_CONSENT)throw new Error("OCR_REVIEW_CONSENT_REQUIRED");
 return prisma.$transaction(async tx=>{
  await lockOcrReviewMember(tx,input.workspaceId,input.userId);
  const evidence=await lockOcrReviewEvidence(tx,input);
  if(evidence.receiptId!==input.receiptId||evidence.textSha256!==input.textSha256||evidence.sourcePdfSha256!==input.sourcePdfSha256)throw new Error("OCR_REVIEW_EVIDENCE_STALE");
  const binding=await tx.providerRouteBinding.findUnique({where:{workspaceId_routeSlot:{workspaceId:input.workspaceId,routeSlot:"PDF_VISUAL_STRUCTURE"}},include:{connection:{include:{credentialVersions:{where:{status:"ACTIVE"},orderBy:{credentialVersion:"desc"},take:1}}}}});
  const connection=binding?.connection,credential=connection?.credentialVersions[0];
  if(!binding||!connection||!credential||connection.status!=="ACTIVE"||connection.providerKey!=="zhipu"||connection.protocol!=="OPENAI_COMPATIBLE"||binding.modelId!=="glm-4.6v")throw new Error("OCR_REVIEW_ROUTE_NOT_READY");
  const pinnedRoute={source:"WORKSPACE",providerKey:connection.providerKey,protocol:connection.protocol,modelId:binding.modelId,adapterVersion:"builtin-v1",connectionId:connection.id,credentialVersionId:credential.id,endpoint:connection.endpoint,region:connection.region,configuration:binding.configuration,capability:{modelId:binding.modelId,families:["TEXT_GENERATION"],confidence:"EXPERIMENTAL",structuredOutput:"JSON_MODE",visionInput:true}};
  const idempotencyKey="ocr-model-review-v1:"+createHash("sha256").update(JSON.stringify([input.workspaceId,input.receiptId])).digest("hex");
  const job=await tx.job.upsert({where:{idempotencyKey},update:{},create:{workspaceId:input.workspaceId,userId:input.userId,type:OCR_MODEL_REVIEW_JOB,idempotencyKey,payload:{
   workspaceId:input.workspaceId,sourceDocumentId:input.sourceDocumentId,ingestionRunId:input.ingestionRunId,physicalPageIndex:input.physicalPageIndex,
   receiptId:evidence.receiptId,sourcePdfSha256:evidence.sourcePdfSha256,textSha256:evidence.textSha256,
   pinnedRoute,
   consent:OCR_MODEL_REVIEW_CONSENT,expiresAt:new Date(Date.now()+15*60_000).toISOString(),maxAttempts:1,maxImageBytes:8_000_000,maxInputTokens:15_000,maxOutputTokens:1600,
  }}});
  return {jobId:job.id,status:job.status};
 });
}
