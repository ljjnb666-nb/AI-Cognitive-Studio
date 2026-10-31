import { recordOcrExecution } from "../src/ocr-execution-receipt.js";
import { acquireOcrHostLease, releaseOcrHostLease, claimOcrPageAttempt } from "../src/ocr-durability.js";
import { APPROVED_MINERU_MANIFEST_SHA256, MINERU_MODEL_REVISION } from "../src/mineru/mineru-approved-inventory.js";
import type { PdfOcrExecutionFacts } from "../src/pdf-routing.js";
import { afterAll, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { PDF_ROUTING_PLAN_SCHEMA_VERSION, PDF_INSPECTOR_VERSION } from "../src/pdf-routing.js";
import { verifyOcrSourceAuthority, verifyOcrCheckpointSource, lockOcrPublicationSources, type OcrSourceKey } from "../src/ocr-source-authority.js";
import { completeOcrPageAttempt } from "../src/ocr-durability.js";
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
function completion(key:OcrSourceKey,sourceAuthority:NonNullable<Awaited<ReturnType<typeof verifyOcrSourceAuthority>>>) {
 return completeOcrPageAttempt({...key,claimToken:key.pageClaimToken,qualityStatus:"ACCEPTED",sourceAuthority,authoritativeArtifactKey:"synthetic/result",textSha256:createHash("sha256").update("receipt text").digest("hex"),durationMs:1});
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
it("authorizes database blob/document/run/plan/page and commits under the same authority",async()=>{
 const f=await fixture();const a=await verifyOcrSourceAuthority(f.key);expect(a?.sourceBlobId).toBe(f.b.id); await receipt(a!);expect(await completion(f.key,a!)).toBe(true);
 expect(await completion(f.key,a!)).toBe(false);
});
it.each(["workspaceId","sourceDocumentId","ingestionRunId","runExecutionToken","pageClaimToken","sourceSha256"] as const)("rejects wrong %s",async field=>{
 const f=await fixture();expect(await verifyOcrSourceAuthority({...f.key,[field]:field==="sourceSha256"?"b".repeat(64):randomUUID()})).toBeNull();
});
it("rejects wrong size, page, generation, missing claim and a native-text plan",async()=>{
 const f=await fixture();
 for(const change of [{sourceSizeBytes:17},{physicalPageIndex:1},{routingGeneration:2},{pageClaimToken:""}]) expect(await verifyOcrSourceAuthority({...f.key,...change})).toBeNull();
 await prisma.ingestionRun.update({where:{id:f.r.id},data:{routingPlan:{...f.plan,pages:[{...f.plan.pages[0],route:"NATIVE_TEXT"}]}}});
 expect(await verifyOcrSourceAuthority(f.key)).toBeNull();
});
it.each(["run","page","job","source","plan"])("rejects late completion after %s authority changes",async what=>{
 const f=await fixture();const a=(await verifyOcrSourceAuthority(f.key))!;await receipt(a);
 if(what==="run") await prisma.ingestionRun.update({where:{id:f.r.id},data:{executionClaimToken:randomUUID()}});
 if(what==="page") await prisma.ocrPageAttempt.update({where:{id:f.p.id},data:{claimToken:randomUUID()}});
 if(what==="job") await prisma.job.update({where:{id:f.j.id},data:{status:"CANCELLED"}});
 if(what==="source") await prisma.sourceBlob.update({where:{id:f.b.id},data:{sha256:"c".repeat(64)}});
 if(what==="plan") await prisma.ingestionRun.update({where:{id:f.r.id},data:{routingPlan:{...f.plan,parser:{name:"other",version:"2"}}}});
 expect(await completion(f.key,a)).toBe(false);
 expect((await prisma.ocrPageAttempt.findUniqueOrThrow({where:{id:f.p.id}})).status).toBe("RUNNING");
});
it.each(["run","page"])("rejects expired %s lease",async what=>{
 const f=await fixture();const a=(await verifyOcrSourceAuthority(f.key))!;await receipt(a);
 if(what==="run") await prisma.ingestionRun.update({where:{id:f.r.id},data:{executionLeaseUntil:new Date(0)}});
 else await prisma.ocrPageAttempt.update({where:{id:f.p.id},data:{leaseUntil:new Date(0)}});
 expect(await completion(f.key,a)).toBe(false);
});
it("rechecks committed source replacement after waiting on a real PostgreSQL row lock",async()=>{
 const f=await fixture();const a=(await verifyOcrSourceAuthority(f.key))!;await receipt(a);
 let release!:()=>void; const gate=new Promise<void>(r=>{release=r;});
 let ready!:(pid:number)=>void;const locked=new Promise<number>(r=>{ready=r;});
 const mutation=prisma.$transaction(async tx=>{
  await tx.$executeRaw`UPDATE "SourceBlob" SET "sha256"=${"d".repeat(64)} WHERE "id"=${f.b.id}`;
  const pids=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;
  ready(pids[0]!.pid);await gate;
 },{timeout:10000});
 const pid=await locked;const commit=completion(f.key,a);
 try {
  let observed=false;const end=Date.now()+5000;
  while(Date.now()<end) {
   const rows=await prisma.$queryRaw<Array<{blocked:boolean}>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))) AS blocked`;
   if(rows[0]?.blocked){observed=true;break;}
   await new Promise(r=>setTimeout(r,10));
  }
  expect(observed).toBe(true);
 } finally {release();}
 await mutation;expect(await commit).toBe(false);
});

// SQL integration tests synthesize executor facts; they do not claim real OCR.
async function receipt(a:NonNullable<Awaited<ReturnType<typeof verifyOcrSourceAuthority>>>,tier:string|null="flash",status:"SUCCEEDED"|"FAILED"="SUCCEEDED") {
 const hostId=`receipt-${randomUUID()}`;const lease=(await acquireOcrHostLease(hostId))!;
 const facts:PdfOcrExecutionFacts={engine:"mineru",engineVersion:"4.0.3",proposedTier:"standard",admittedTier:tier??"standard",actualTier:tier,tierAdmission:tier==="flash"?"STANDARD_REFUSED":"STANDARD_ADMITTED",tierRefusalCode:tier==="flash"?"MEMORY_INSUFFICIENT":null,modelManifestSha256:tier==="standard"?APPROVED_MINERU_MANIFEST_SHA256:null,sourceAuthority:a,qualityDecision:{status:"ACCEPTED",reasons:[]},hostId,hostClaimToken:lease.claimToken,serverIdentity:{pid:process.pid,serverId:randomUUID()}};
 const result=status==="SUCCEEDED"?{status,text:"receipt text"} as const:{status,errorCode:"SOURCE_OCR_TIMEOUT",kind:"transient"} as const;
 const ok=await recordOcrExecution(facts,result);
 await releaseOcrHostLease(hostId,lease.claimToken);
 await prisma.ocrHostLease.delete({where:{hostId}});
 return ok;
}
it.each(["standard","flash",null])("persists actual tier %s and never fabricates model identity for flash or no invocation",async tier=>{
 const f=await fixture();const a=(await verifyOcrSourceAuthority(f.key))!;
 expect(await receipt(a,tier,tier===null?"FAILED":"SUCCEEDED")).toBe(true);
 const row=await prisma.ocrPageAttempt.findUniqueOrThrow({where:{id:f.p.id}});
 const history=await prisma.ocrPageExecution.findUniqueOrThrow({where:{pageClaimToken:f.key.pageClaimToken}});
 expect(row.actualTier).toBe(tier);expect(history.actualTier).toBe(tier);
 expect(history.executionStatus).toBe(tier===null?"FAILED":"SUCCEEDED");
 expect(row.modelRevision).toBe(tier==="standard"?MINERU_MODEL_REVISION:null);
 expect(history.manifestDigest).toBe(tier==="standard"?APPROVED_MINERU_MANIFEST_SHA256:null);
 expect(history.fallbackReason).toBe(tier==="flash"?"MEMORY_INSUFFICIENT":null);
 expect(await receipt(a,tier,tier===null?"FAILED":"SUCCEEDED")).toBe(false);
});
it("does not commit a receipt-less or different-text result",async()=>{
 const f=await fixture();const a=(await verifyOcrSourceAuthority(f.key))!;
 expect(await completion(f.key,a)).toBe(false);
 await receipt(a);
 expect(await completeOcrPageAttempt({...f.key,sourceAuthority:a,qualityStatus:"ACCEPTED",claimToken:f.key.pageClaimToken,authoritativeArtifactKey:"wrong",textSha256:"b".repeat(64),durationMs:1})).toBe(false);
});

it("the database refuses rewriting immutable execution history",async()=>{
 const f=await fixture();const a=(await verifyOcrSourceAuthority(f.key))!;await receipt(a);
 await expect(prisma.ocrPageExecution.update({where:{pageClaimToken:f.key.pageClaimToken},data:{actualTier:"standard"}})).rejects.toThrow("OCR_EXECUTION_RECEIPT_IMMUTABLE");
 expect((await prisma.ocrPageExecution.findUniqueOrThrow({where:{pageClaimToken:f.key.pageClaimToken}})).actualTier).toBe("flash");
});

it("a failed standard attempt is retained while a new flash attempt clears and replaces only checkpoint facts",async()=>{
 const f=await fixture();const a=(await verifyOcrSourceAuthority(f.key))!;
 expect(await receipt(a,"standard","FAILED")).toBe(true);
 await prisma.ocrPageAttempt.update({where:{id:f.p.id},data:{leaseUntil:new Date(0)}});
 const claim=(await claimOcrPageAttempt({...f.key,parserName:"mineru",parserVersion:"4.0.3",parserMode:"flash"}))!;
 const pending=await prisma.ocrPageAttempt.findUniqueOrThrow({where:{id:f.p.id}});
 expect(pending.executionStatus).toBeNull();expect(pending.actualTier).toBeNull();
 const next={...f.key,pageClaimToken:claim.claimToken};const fresh=(await verifyOcrSourceAuthority(next))!;
 expect(await receipt(fresh,"flash")).toBe(true);
 const history=await prisma.ocrPageExecution.findMany({where:{pageAttemptId:f.p.id},orderBy:{createdAt:"asc"}});
 expect(history.map(r=>[r.actualTier,r.executionStatus])).toEqual([["standard","FAILED"],["flash","SUCCEEDED"]]);
 expect((await prisma.ocrPageAttempt.findUniqueOrThrow({where:{id:f.p.id}})).modelRevision).toBeNull();
});
it("concurrent execution receipts for one page claim have exactly one winner",async()=>{
 const f=await fixture();const a=(await verifyOcrSourceAuthority(f.key))!;
 const results=await Promise.all([receipt(a,"standard"),receipt(a,"flash")]);
 expect(results.filter(Boolean)).toHaveLength(1);
 expect(await prisma.ocrPageExecution.count({where:{pageAttemptId:f.p.id}})).toBe(1);
});

it("revalidates source and current run authority when resuming a completed checkpoint",async()=>{
 const f=await fixture();const a=(await verifyOcrSourceAuthority(f.key))!;await receipt(a);expect(await completion(f.key,a)).toBe(true);
 expect(await verifyOcrCheckpointSource(f.key,a)).toBe(true);
 const token=randomUUID();await prisma.ingestionRun.update({where:{id:f.r.id},data:{executionClaimToken:token}});
 expect(await verifyOcrCheckpointSource(f.key,a)).toBe(false);
 expect(await verifyOcrCheckpointSource({...f.key,runExecutionToken:token},a)).toBe(true);
 await prisma.sourceBlob.update({where:{id:f.b.id},data:{sha256:"e".repeat(64)}});
 expect(await verifyOcrCheckpointSource({...f.key,runExecutionToken:token},a)).toBe(false);
 await prisma.sourceDocument.update({where:{id:f.d.id},data:{sha256:"e".repeat(64)}});
 expect(await verifyOcrCheckpointSource({...f.key,runExecutionToken:token,sourceSha256:"e".repeat(64)},a)).toBe(false);
});

it("blocks final canonical publication if source changes after a valid checkpoint commit",async()=>{
 const f=await fixture();const a=(await verifyOcrSourceAuthority(f.key))!;await receipt(a);expect(await completion(f.key,a)).toBe(true);
 expect(await prisma.$transaction(tx=>lockOcrPublicationSources(tx,f.key))).toBe(true);
 await prisma.sourceBlob.update({where:{id:f.b.id},data:{sha256:"f".repeat(64)}});
 await prisma.sourceDocument.update({where:{id:f.d.id},data:{sha256:"f".repeat(64)}});
 expect(await prisma.$transaction(tx=>lockOcrPublicationSources(tx,{...f.key,sourceSha256:"f".repeat(64)}))).toBe(false);
});
