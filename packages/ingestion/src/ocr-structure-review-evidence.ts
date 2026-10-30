import { createHash } from "node:crypto";
import { prisma, type Prisma } from "@ai-cognitive/db";
import type { StorageProvider } from "@ai-cognitive/storage";
import { APPROVED_MINERU_MANIFEST_SHA256, MINERU_MODEL_REVISION } from "./mineru/mineru-approved-inventory.js";

export type OcrReviewPageKey = { workspaceId:string; sourceDocumentId:string; ingestionRunId:string; physicalPageIndex:number };
const identityOnly=(key:OcrReviewPageKey):OcrReviewPageKey=>({workspaceId:key.workspaceId,sourceDocumentId:key.sourceDocumentId,ingestionRunId:key.ingestionRunId,physicalPageIndex:key.physicalPageIndex});
const hash=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
const reject=():never=>{throw new Error("OCR_REVIEW_EVIDENCE_STALE");};

/** Read authority only. This does not revive an execution lease, publish a
 * SourceBlock, or grant model/billing permission. Latest run supersedes older
 * evidence even when no CurrentDocumentExtraction has ever existed. */
export async function lockOcrReviewEvidence(tx:Prisma.TransactionClient,key:OcrReviewPageKey) {
 key=identityOnly(key);
 if(!Number.isSafeInteger(key.physicalPageIndex)||key.physicalPageIndex<0)return reject();
 await tx.$queryRaw`SELECT "id" FROM "IngestionRun" WHERE "id"=${key.ingestionRunId} AND "workspaceId"=${key.workspaceId} FOR SHARE`;
 await tx.$queryRaw`SELECT "id" FROM "SourceDocument" WHERE "id"=${key.sourceDocumentId} AND "workspaceId"=${key.workspaceId} FOR SHARE`;
 const doc=await tx.sourceDocument.findFirst({where:{id:key.sourceDocumentId,workspaceId:key.workspaceId},include:{sourceBlob:true,ingestionRuns:{orderBy:[{createdAt:"desc"},{id:"desc"}],take:1}}});
 const run=doc?.ingestionRuns[0];
 if(!doc||!run||run.id!==key.ingestionRunId||run.status!=="OCR_REQUIRED"||run.errorCode!=="SOURCE_OCR_REVIEW_REQUIRED"||doc.mediaType!=="application/pdf")return reject();
 const blob=doc.sourceBlob;
 await tx.$queryRaw`SELECT "id" FROM "SourceBlob" WHERE "id"=${blob.id} FOR SHARE`;
 const fresh=await tx.sourceBlob.findUniqueOrThrow({where:{id:blob.id}});
 if(fresh.workspaceId!==key.workspaceId||fresh.sha256!==doc.sha256||fresh.sizeBytes!==doc.sizeBytes||fresh.storageKey!==doc.storageKey||fresh.mediaType!==doc.mediaType)return reject();
 const page=await tx.ocrPageAttempt.findFirst({where:{...key,routingGeneration:run.routingGeneration??-1,status:"SUCCEEDED",actualTier:"standard",executionStatus:"SUCCEEDED",qualityStatus:"REVIEW_REQUIRED"},include:{executions:{where:{executionStatus:"SUCCEEDED"}}}});
 if(!page||!page.claimToken||!page.textSha256||!page.authoritativeArtifactKey)return reject();
 const receipt=page.executions.find(r=>r.pageClaimToken===page.claimToken);
 if(!receipt||receipt.actualTier!=="standard"||receipt.modelRevision!==MINERU_MODEL_REVISION||receipt.manifestDigest!==APPROVED_MINERU_MANIFEST_SHA256||receipt.resultTextSha256!==page.textSha256)return reject();
 const source=receipt.sourceIdentity as Record<string,unknown>;
 if(source.sourceBlobId!==blob.id||source.sourceDocumentId!==doc.id||source.sourceSha256!==doc.sha256||source.sourceSizeBytes!==Number(doc.sizeBytes)||source.storageKey!==doc.storageKey||source.planSha256!==hash(JSON.stringify(run.routingPlan))||JSON.stringify(page.sourceIdentity)!==JSON.stringify(receipt.sourceIdentity))return reject();
 return {receiptId:receipt.id,pageClaimToken:page.claimToken,routingGeneration:page.routingGeneration,sourcePdfSha256:doc.sha256,sourceSizeBytes:Number(doc.sizeBytes),sourceStorageKey:doc.storageKey,artifactKey:page.authoritativeArtifactKey,textSha256:page.textSha256,actualTier:receipt.actualTier,modelRevision:receipt.modelRevision,manifestDigest:receipt.manifestDigest,qualityDecision:receipt.qualityDecision};
}

export async function readOcrStructureReviewEvidence(key:OcrReviewPageKey,storage:Pick<StorageProvider,"getObjectStream">) {
 key=identityOnly(key);
 const before=await prisma.$transaction(tx=>lockOcrReviewEvidence(tx,key));
 const chunks:Uint8Array[]=[];let size=0;
 for await(const chunk of await storage.getObjectStream(before.artifactKey)) {
  size+=chunk.byteLength;if(size>8_000_000)throw new Error("OCR_REVIEW_ARTIFACT_TOO_LARGE");chunks.push(chunk);
 }
 const bytes=Buffer.concat(chunks);
 if(hash(bytes)!==before.textSha256)throw new Error("OCR_REVIEW_ARTIFACT_CHANGED");
 const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
 const after=await prisma.$transaction(tx=>lockOcrReviewEvidence(tx,key));
 if(JSON.stringify(before)!==JSON.stringify(after))return reject();
 return {...key,...after,text,
  blocks:text.split(/\n\s*\n/u).filter(b=>b.trim()).map((text,ordinal)=>({ordinal,text,orderAuthority:"OCR_OUTPUT_SEQUENCE_UNVERIFIED" as const,bbox:null})),
  structure:{readingOrder:"UNVERIFIED",tables:"UNKNOWN",charts:"UNKNOWN",formulas:"UNKNOWN",boundingBoxes:"UNKNOWN"} as const,
  authority:"OCR_REVIEW_EVIDENCE_ONLY" as const,approvedForPodcast:false as const,approvedForBookIntelligence:false as const};
}
