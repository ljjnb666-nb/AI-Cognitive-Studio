import {createHash,randomUUID} from "node:crypto";
import {prisma,Prisma} from "@ai-cognitive/db";
import {OCR_MODEL_REVIEW_JOB,OCR_MODEL_REVIEW_CONSENT,lockOcrReviewEvidence,lockOcrReviewMember,readOcrStructureReviewEvidence,renderOcrReviewSourcePage,type OcrReviewPageKey} from "@ai-cognitive/ingestion";
import {createGatewayOcrModelReviewer,validateOcrModelReview,type ProviderGateway,type ProviderExecutionRepository,type ResolvedRoute} from "@ai-cognitive/provider-gateway";
import type {StorageProvider} from "@ai-cognitive/storage";
type Payload=OcrReviewPageKey & {receiptId:string;sourcePdfSha256:string;textSha256:string;consent:string;expiresAt:string;pinnedRoute:ResolvedRoute;claimToken?:string;maxAttempts:number;maxImageBytes:number;maxInputTokens:number;maxOutputTokens:number};
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function processNextOcrStructureReview(deps:{gateway:ProviderGateway;repository:ProviderExecutionRepository;storage:StorageProvider;privateTempRoot:string},jobId?:string) {
 const job=await prisma.job.findFirst({where:{type:OCR_MODEL_REVIEW_JOB,status:"QUEUED",...(jobId?{id:jobId}:{})},orderBy:{createdAt:"asc"}});if(!job)return "IDLE";
 const payload=job.payload as unknown as Payload,token=randomUUID();
 const claim=await prisma.job.updateMany({where:{id:job.id,type:OCR_MODEL_REVIEW_JOB,status:"QUEUED"},data:{status:"RUNNING",startedAt:new Date(),attemptCount:{increment:1},payload:json({...payload,claimToken:token})}});
 if(claim.count!==1)return "IDLE";
 const fence={id:job.id,status:"RUNNING" as const,payload:{path:["claimToken"],equals:token}};
 try {
  if(!job.userId||payload.workspaceId!==job.workspaceId||payload.consent!==OCR_MODEL_REVIEW_CONSENT||!Number.isFinite(Date.parse(payload.expiresAt))||Date.parse(payload.expiresAt)<=Date.now()||payload.maxAttempts!==1||payload.maxImageBytes!==8_000_000||payload.maxInputTokens!==15000||payload.maxOutputTokens!==1600)throw new Error("OCR_REVIEW_AUTHORIZATION_INVALID");
  const authorize=()=>prisma.$transaction(async tx=>{await lockOcrReviewMember(tx,payload.workspaceId,job.userId!);const e=await lockOcrReviewEvidence(tx,payload);if(e.receiptId!==payload.receiptId||e.textSha256!==payload.textSha256||e.sourcePdfSha256!==payload.sourcePdfSha256)throw new Error("OCR_REVIEW_EVIDENCE_STALE");return e;});
  await authorize();
  const evidence=await readOcrStructureReviewEvidence(payload,deps.storage);
  const image=await renderOcrReviewSourcePage(evidence,deps.storage,deps.privateTempRoot);
  await authorize();
  if(Date.parse(payload.expiresAt)<=Date.now())throw new Error("OCR_REVIEW_AUTHORIZATION_EXPIRED");
  const reviewed=await createGatewayOcrModelReviewer({gateway:deps.gateway,workspaceId:payload.workspaceId,userId:job.userId,sourceDocumentId:payload.sourceDocumentId,ingestionRunId:payload.ingestionRunId,reviewRequestId:job.id,pinnedRoute:payload.pinnedRoute}).review({...image,receiptId:evidence.receiptId,ocrText:evidence.text,ocrTextSha256:evidence.textSha256});
  const fingerprint=createHash("sha256").update(JSON.stringify([job.id,evidence.receiptId,evidence.sourcePdfSha256,image.pngSha256,evidence.textSha256])).digest("hex");
  await deps.repository.consumeTextResult({workspaceId:payload.workspaceId,invocationId:reviewed.invocationId,snapshotId:reviewed.snapshotId,consumerKind:"OCR_STRUCTURE_REVIEW",consumerKey:job.id,consumerFingerprint:fingerprint},async({tx,response})=>{
   const held=await tx.job.findFirst({where:fence});if(!held)throw new Error("OCR_REVIEW_CLAIM_LOST");
   await lockOcrReviewMember(tx,payload.workspaceId,job.userId!);
   const current=await lockOcrReviewEvidence(tx,payload);
   if(current.receiptId!==evidence.receiptId||current.textSha256!==evidence.textSha256||current.sourcePdfSha256!==evidence.sourcePdfSha256||Date.parse(payload.expiresAt)<=Date.now())throw new Error("OCR_REVIEW_EVIDENCE_STALE");
   if(response.type!=="STRUCTURED"||response.finishReason!=="STOP")throw new Error("OCR_REVIEW_RESPONSE_INVALID");
   const decision=validateOcrModelReview(response.structured,{sourceSha256:evidence.sourcePdfSha256,physicalPageIndex:payload.physicalPageIndex,ocrTextSha256:evidence.textSha256});
   const usage=await tx.providerUsageEvent.findMany({where:{workspaceId:payload.workspaceId,invocationId:reviewed.invocationId},select:{id:true,status:true,inputTokens:true,outputTokens:true,createdAt:true}});
   await tx.ocrModelReviewEvent.create({data:{jobId:job.id,workspaceId:payload.workspaceId,sourceDocumentId:payload.sourceDocumentId,ingestionRunId:payload.ingestionRunId,physicalPageIndex:payload.physicalPageIndex,receiptId:evidence.receiptId,sourcePdfSha256:evidence.sourcePdfSha256,sourcePngSha256:image.pngSha256,ocrTextSha256:evidence.textSha256,evidenceSha256:fingerprint,invocationId:reviewed.invocationId,snapshotId:reviewed.snapshotId,providerKey:reviewed.providerKey,modelId:reviewed.modelId,reportedModelId:response.providerModel??null,decision:decision.status,reasons:json(decision.axes),usage:json({status:"UNPRICED",ledger:usage})}});
   const committed=await tx.job.updateMany({where:fence,data:{status:"SUCCEEDED",completedAt:new Date(),result:json({decision:decision.status,approvedForPodcast:false})}});if(committed.count!==1)throw new Error("OCR_REVIEW_CLAIM_LOST");
  });
  return "DONE";
 } catch {
  // A paid/uncertain RUNNING outcome is never automatically retried. Gateway
  // retains its encrypted receipt and usage for operator reconciliation.
  await prisma.job.updateMany({where:fence,data:{status:"FAILED",completedAt:new Date(),error:{code:"OCR_STRUCTURE_REVIEW_FAILED_RECONCILIATION_REQUIRED"}}});
  return "FAILED";
 }
}
