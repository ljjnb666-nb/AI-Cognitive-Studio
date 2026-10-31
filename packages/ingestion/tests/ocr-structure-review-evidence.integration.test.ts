import { afterAll,expect,it } from "vitest";
import { randomUUID,createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { PDF_ROUTING_PLAN_SCHEMA_VERSION,PDF_INSPECTOR_VERSION } from "../src/pdf-routing.js";
import type { OcrSourceKey } from "../src/ocr-source-authority.js";
import { APPROVED_MINERU_MANIFEST_SHA256,MINERU_MODEL_REVISION } from "../src/mineru/mineru-approved-inventory.js";
import { readOcrStructureReviewEvidence,lockOcrReviewEvidence } from "../src/ocr-structure-review-evidence.js";
import {requestOcrModelReview,OCR_MODEL_REVIEW_CONSENT} from "../src/ocr-model-review-request.js";
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
 await prisma.providerRouteBinding.deleteMany({where:{workspaceId:{in:workspaces}}});
 await prisma.providerCredentialVersion.deleteMany({where:{workspaceId:{in:workspaces}}});
 await prisma.providerConnection.deleteMany({where:{workspaceId:{in:workspaces}}});
 await prisma.workspaceMember.deleteMany({where:{workspaceId:{in:workspaces}}});
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
async function consentFixture(){
 const f=await pending();const userId=f.j.userId!;
 await prisma.workspaceMember.create({data:{workspaceId:f.key.workspaceId,userId,role:"OWNER"}});
 const connection=await prisma.providerConnection.create({data:{workspaceId:f.key.workspaceId,providerKey:"zhipu",protocol:"OPENAI_COMPATIBLE",displayName:"Synthetic consent route",endpoint:"https://open.bigmodel.cn/api/paas/v4/chat/completions"}});
 await prisma.providerCredentialVersion.create({data:{workspaceId:f.key.workspaceId,connectionId:connection.id,credentialVersion:1,ciphertext:"synthetic-not-decrypted",iv:"synthetic",authTag:"synthetic",keyVersion:"test"}});
 await prisma.providerRouteBinding.create({data:{workspaceId:f.key.workspaceId,connectionId:connection.id,routeSlot:"PDF_VISUAL_STRUCTURE",modelId:"glm-4.6v"}});
 const receipt=await prisma.ocrPageExecution.findUniqueOrThrow({where:{pageClaimToken:f.p.claimToken!}});
 return {...f,input:{...f.review,userId,receiptId:receipt.id,textSha256:hash(text),sourcePdfSha256:f.b.sha256,consent:OCR_MODEL_REVIEW_CONSENT}};
}
it("concurrent authorized clicks create exactly one one-time Job",async()=>{
 const f=await consentFixture();const outcomes=await Promise.all([requestOcrModelReview(f.input),requestOcrModelReview(f.input),requestOcrModelReview(f.input)]);
 expect(new Set(outcomes.map(r=>r.jobId)).size).toBe(1);
 const job=await prisma.job.findUniqueOrThrow({where:{id:outcomes[0]!.jobId}});
 expect(job.payload).toMatchObject({receiptId:f.input.receiptId,maxAttempts:1,maxOutputTokens:1600,pinnedRoute:{modelId:"glm-4.6v"}});
 await prisma.job.update({where:{id:job.id},data:{status:"RUNNING"}});
 expect((await requestOcrModelReview(f.input)).status).toBe("RUNNING");
 expect(await prisma.documentExtraction.count({where:{ingestionRunId:f.r.id}})).toBe(0);
});
it("requires exact consent and rechecks revoked paid-action role",async()=>{
 const f=await consentFixture();await expect(requestOcrModelReview({...f.input,consent:""})).rejects.toThrow("OCR_REVIEW_CONSENT_REQUIRED");
 await prisma.workspaceMember.update({where:{workspaceId_userId:{workspaceId:f.key.workspaceId,userId:f.input.userId}},data:{role:"VIEWER"}});
 await expect(requestOcrModelReview(f.input)).rejects.toThrow("OCR_REVIEW_FORBIDDEN");
});
it("cannot authorize the wrong page, text or receipt",async()=>{
 const f=await consentFixture();
 for(const input of [{...f.input,physicalPageIndex:1},{...f.input,textSha256:"a".repeat(64)},{...f.input,receiptId:randomUUID()}])await expect(requestOcrModelReview(input)).rejects.toThrow("OCR_REVIEW_EVIDENCE_STALE");
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
it.each(["successor-run","page-claim"])("serializes final evidence validation against concurrent %s mutation",async mutation=>{
 const f=await pending();const newJob=await prisma.job.create({data:{workspaceId:f.key.workspaceId,userId:f.j.userId,type:"source.ingest",payload:{}}});
 let release!:()=>void,held!:()=>void,writerReady!:()=>void;
 const barrier=new Promise<void>(resolve=>{release=resolve;}),locked=new Promise<void>(resolve=>{held=resolve;}),ready=new Promise<void>(resolve=>{writerReady=resolve;});
 const reader=prisma.$transaction(async tx=>{await lockOcrReviewEvidence(tx,f.review);held();await barrier;},{timeout:10000});await locked;
 let writerPid=0;
 const writer=prisma.$transaction(async tx=>{const rows=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;writerPid=rows[0]!.pid;writerReady();if(mutation==="successor-run")await tx.ingestionRun.create({data:{workspaceId:f.key.workspaceId,sourceDocumentId:f.d.id,jobId:newJob.id,parserVersion:"1",normalizationVersion:"1"}});else await tx.ocrPageAttempt.update({where:{id:f.p.id},data:{claimToken:randomUUID()}});},{timeout:10000});
 try{
 await ready;let waiting=false;const deadline=Date.now()+3000;
 while(Date.now()<deadline){const rows=await prisma.$queryRaw<Array<{waiting:boolean}>>`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=${writerPid}`;if(rows[0]?.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
 expect(waiting).toBe(true);
 }finally{release();await Promise.all([reader,writer]);}
 await expect(readOcrStructureReviewEvidence(f.review,storage)).rejects.toThrow("OCR_REVIEW_EVIDENCE_STALE");
});
