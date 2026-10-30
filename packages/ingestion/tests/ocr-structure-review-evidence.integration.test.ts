import { afterAll,expect,it } from "vitest";
import { randomUUID,createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { PDF_ROUTING_PLAN_SCHEMA_VERSION,PDF_INSPECTOR_VERSION } from "../src/pdf-routing.js";
import type { OcrSourceKey } from "../src/ocr-source-authority.js";
import { APPROVED_MINERU_MANIFEST_SHA256,MINERU_MODEL_REVISION } from "../src/mineru/mineru-approved-inventory.js";
import { readOcrStructureReviewEvidence } from "../src/ocr-structure-review-evidence.js";
// Real PostgreSQL; storage stream and OCR receipt are synthetic test fixtures.
const workspaces:string[]=[]; const users:string[]=[];
async function fixture() {
  const u=await prisma.user.create({data:{email:`authority-${randomUUID()}@test`,name:"test"}});users.push(u.id);
  const w=await prisma.workspace.create({data:{name:"authority"}}); workspaces.push(w.id);
  const sha=createHash("sha256").update("actual PDF bytes").digest("hex");
  const b=await prisma.sourceBlob.create({data:{workspaceId:w.id,sha256:sha,sizeBytes:16,mediaType:"application/pdf",storageKey:randomUUID()}});
  const s=await prisma.source.create({data:{workspaceId:w.id,kind:"FILE",displayName:"synthetic"}});
  const d=await prisma.sourceDocument.create({data:{workspaceId:w.id,sourceId:s.id,sourceBlobId:b.id,version:1,sha256:sha,sizeBytes:16,mediaType:"application/pdf",storageKey:b.storageKey}});
  const j=await prisma.job.create({data:{workspaceId:w.id,userId:u.id,type:"source.ingest",status:"RUNNING",payload:{}}});
  const plan={schemaVersion:PDF_ROUTING_PLAN_SCHEMA_VERSION,inspector:{version:PDF_INSPECTOR_VERSION},parser:{name:"router",version:"1"},pageCount:1,pages:[{physicalPageIndex:0,route:"OCR_REQUIRED",contentEvidence:"NON_TEXT_CONTENT",reasonCodes:["IMAGE_CONTENT_WITHOUT_TEXT"]}]};
  const r=await prisma.ingestionRun.create({data:{workspaceId:w.id,sourceDocumentId:d.id,jobId:j.id,parserVersion:"1",normalizationVersion:"1",status:"RUNNING",executionClaimToken:randomUUID(),executionLeaseUntil:new Date(Date.now()+60000),routingGeneration:1,routingPlan:plan}});
  const p=await prisma.ocrPageAttempt.create({data:{workspaceId:w.id,sourceDocumentId:d.id,ingestionRunId:r.id,physicalPageIndex:0,routingGeneration:1,status:"RUNNING",claimToken:randomUUID(),leaseUntil:new Date(Date.now()+60000)}});
  const key:OcrSourceKey={workspaceId:w.id,sourceDocumentId:d.id,ingestionRunId:r.id,physicalPageIndex:0,routingGeneration:1,runExecutionToken:r.executionClaimToken!,pageClaimToken:p.claimToken!,sourceSha256:sha,sourceSizeBytes:16};
  return {key,b,d,j,r,p,plan};
}
afterAll(async()=>{
 await prisma.ocrPageAttempt.deleteMany({where:{workspaceId:{in:workspaces}}});
 await prisma.ingestionRun.deleteMany({where:{workspaceId:{in:workspaces}}});
 await prisma.job.deleteMany({where:{workspaceId:{in:workspaces}}});
 await prisma.sourceDocument.deleteMany({where:{workspaceId:{in:workspaces}}});
 await prisma.source.deleteMany({where:{workspaceId:{in:workspaces}}});
 await prisma.sourceBlob.deleteMany({where:{workspaceId:{in:workspaces}}});
 await prisma.workspace.deleteMany({where:{id:{in:workspaces}}});
 await prisma.user.deleteMany({where:{id:{in:users}}});
 await prisma.$disconnect();
});

const text="OCR paragraph one.\n\nOCR paragraph two.";
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
async function pending() {
 const f=await fixture();
 const sourceIdentity={sourceBlobId:f.b.id,sourceDocumentId:f.d.id,sourceSha256:f.b.sha256,sourceSizeBytes:16,storageKey:f.b.storageKey,planSha256:hash(JSON.stringify(f.r.routingPlan))};
 await prisma.ocrPageExecution.create({data:{pageAttemptId:f.p.id,pageClaimToken:f.p.claimToken!,runExecutionToken:f.r.executionClaimToken!,actualTier:"standard",modelRevision:MINERU_MODEL_REVISION,manifestDigest:APPROVED_MINERU_MANIFEST_SHA256,executionStatus:"SUCCEEDED",sourceIdentity,resultTextSha256:hash(text),qualityDecision:{status:"REVIEW_REQUIRED",reasons:["STRUCTURE_UNATTESTED"]}}});
 await prisma.ocrPageAttempt.update({where:{id:f.p.id},data:{status:"SUCCEEDED",actualTier:"standard",executionStatus:"SUCCEEDED",qualityStatus:"REVIEW_REQUIRED",sourceIdentity,textSha256:hash(text),authoritativeArtifactKey:"fixture/ocr-text"}});
 await prisma.ingestionRun.update({where:{id:f.r.id},data:{status:"OCR_REQUIRED",errorCode:"SOURCE_OCR_REVIEW_REQUIRED"}});
 return {...f,review:{workspaceId:f.key.workspaceId,sourceDocumentId:f.d.id,ingestionRunId:f.r.id,physicalPageIndex:0}};
}
const stream=(value:string,before?:()=>Promise<unknown>)=>({async getObjectStream(){return (async function*(){await before?.();yield Buffer.from(value);})();}});
const storage=stream(text);
it("reads pending standard evidence without manufacturing canonical pages or model authority",async()=>{
 const f=await pending();const evidence=await readOcrStructureReviewEvidence(f.review,storage);
 expect(evidence.text).toBe(text);expect(evidence.blocks).toHaveLength(2);
 expect(evidence.structure).toMatchObject({boundingBoxes:"UNKNOWN",readingOrder:"UNVERIFIED",tables:"UNKNOWN"});
 expect(evidence.approvedForPodcast).toBe(false);
 expect(await prisma.documentExtraction.count({where:{ingestionRunId:f.r.id}})).toBe(0);
});
it.each(["workspaceId","sourceDocumentId","ingestionRunId","physicalPageIndex"] as const)("rejects cross-source/page key %s",async field=>{
 const f=await pending();const key={...f.review,[field]:field==="physicalPageIndex"?1:randomUUID()};
 await expect(readOcrStructureReviewEvidence(key,storage)).rejects.toThrow("OCR_REVIEW_EVIDENCE_STALE");
});
it("rejects replaced artifacts",async()=>{
 const f=await pending();await expect(readOcrStructureReviewEvidence(f.review,stream("replaced"))).rejects.toThrow("OCR_REVIEW_ARTIFACT_CHANGED");
});
it("rejects source replacement across object IO",async()=>{
 const f=await pending();await expect(readOcrStructureReviewEvidence(f.review,stream(text,()=>prisma.sourceBlob.update({where:{id:f.b.id},data:{sha256:"a".repeat(64)}})))).rejects.toThrow("OCR_REVIEW_EVIDENCE_STALE");
});
it("rejects evidence superseded by a new run",async()=>{
 const f=await pending();const job=await prisma.job.create({data:{workspaceId:f.key.workspaceId,userId:f.j.userId,type:"source.ingest",status:"QUEUED",payload:{}}});
 await prisma.ingestionRun.create({data:{workspaceId:f.key.workspaceId,sourceDocumentId:f.d.id,jobId:job.id,parserVersion:"1",normalizationVersion:"1",status:"QUEUED",createdAt:new Date(Date.now()+1000)}});
 await expect(readOcrStructureReviewEvidence(f.review,storage)).rejects.toThrow("OCR_REVIEW_EVIDENCE_STALE");
});
