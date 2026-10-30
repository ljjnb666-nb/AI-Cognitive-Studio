import {randomUUID,createHash} from "node:crypto";
import {mkdtemp,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll,afterEach,expect,it} from "vitest";
import {prisma,Prisma} from "@ai-cognitive/db";
import {S3CompatibleStorageProvider} from "@ai-cognitive/storage";
import {requestOcrModelReview,OCR_MODEL_REVIEW_CONSENT} from "@ai-cognitive/ingestion";
import {PDF_ROUTING_PLAN_SCHEMA_VERSION,PDF_INSPECTOR_VERSION} from "../../../packages/ingestion/src/pdf-routing.js";
import {APPROVED_MINERU_MANIFEST_SHA256,MINERU_MODEL_REVISION} from "../../../packages/ingestion/src/mineru/mineru-approved-inventory.js";
import {OCR_REVIEW_AXES,ProviderGatewayRepository,parseKeyring,DeterministicProviderHttpTransport,createProviderAdapterResolver} from "@ai-cognitive/provider-gateway";
import {createBookProductionGatewayRuntime} from "../src/provider-gateway-runtime.js";
import {processNextOcrStructureReview} from "../src/ocr-structure-review.js";

// Real PostgreSQL, MinIO, PNG renderer and production encrypted Gateway
// repository. Only provider HTTP is deterministic; never sends book data out.
const keyring=JSON.stringify({activeVersion:"review-test",keys:{"review-test":Buffer.alloc(32,31).toString("base64")}});
const source={...process.env,PROVIDER_GATEWAY_KEYRING:keyring};
const storage=new S3CompatibleStorageProvider({endpoint:process.env.S3_ENDPOINT!,region:process.env.S3_REGION!,bucket:process.env.S3_BUCKET!,accessKey:process.env.S3_ACCESS_KEY!,secretKey:process.env.S3_SECRET_KEY!,forcePathStyle:true});
const owned:Array<{workspaceId:string;userId:string;keys:string[];root:string}>=[];
const sha=(s:Uint8Array|string)=>createHash("sha256").update(s).digest("hex");
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const text="Independent OCR paragraph.";
function pdf(){
 const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Count 1 /Kids [3 0 R] >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Contents 4 0 R >>","<< /Length 0 >>\nstream\n\nendstream"];
 let output="%PDF-1.4\n";const offsets=[0];for(const [i,o]of objects.entries()){offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${o}\nendobj\n`;}
 const start=Buffer.byteLength(output);output+="xref\n0 5\n0000000000 65535 f \n"+offsets.slice(1).map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")+`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(output);
}
async function fixture(){
 const user=await prisma.user.create({data:{email:randomUUID()+"@review.test"}}),ws=await prisma.workspace.create({data:{name:"model-review-test"}});
 const root=await mkdtemp(join(tmpdir(),"ocr-review-test-")),prefix="review-test/"+ws.id;
 const keys=[prefix+"/source.pdf",prefix+"/ocr.txt"];owned.push({workspaceId:ws.id,userId:user.id,keys,root});
 const context={workspaceId:ws.id,userId:user.id};await prisma.workspaceMember.create({data:{...context,role:"OWNER"}});
 const bytes=pdf();await storage.putObject({key:keys[0]!,body:bytes,contentType:"application/pdf"});await storage.putObject({key:keys[1]!,body:Buffer.from(text),contentType:"text/plain"});
 const blob=await prisma.sourceBlob.create({data:{workspaceId:ws.id,sha256:sha(bytes),sizeBytes:bytes.length,storageKey:keys[0]!,mediaType:"application/pdf"}});
 const origin=await prisma.source.create({data:{workspaceId:ws.id,kind:"FILE",displayName:"synthetic review page"}});
 const doc=await prisma.sourceDocument.create({data:{workspaceId:ws.id,sourceId:origin.id,sourceBlobId:blob.id,sha256:blob.sha256,sizeBytes:blob.sizeBytes,storageKey:blob.storageKey,mediaType:blob.mediaType,version:1}});
 const job=await prisma.job.create({data:{...context,type:"source.ingest",payload:{}}});
 const plan={schemaVersion:PDF_ROUTING_PLAN_SCHEMA_VERSION,inspector:{version:PDF_INSPECTOR_VERSION},parser:{name:"test",version:"1"},pageCount:1,pages:[{physicalPageIndex:0,route:"OCR_REQUIRED",contentEvidence:"NON_TEXT_CONTENT",reasonCodes:["IMAGE_CONTENT_WITHOUT_TEXT"]}]};
 const run=await prisma.ingestionRun.create({data:{workspaceId:ws.id,sourceDocumentId:doc.id,jobId:job.id,parserVersion:"1",normalizationVersion:"1",status:"OCR_REQUIRED",errorCode:"SOURCE_OCR_REVIEW_REQUIRED",routingGeneration:1,routingPlan:plan}});
 const identity={sourceBlobId:blob.id,sourceDocumentId:doc.id,sourceSha256:blob.sha256,sourceSizeBytes:bytes.length,storageKey:blob.storageKey,planSha256:sha(JSON.stringify(run.routingPlan))};
 const claim=randomUUID();const page=await prisma.ocrPageAttempt.create({data:{workspaceId:ws.id,sourceDocumentId:doc.id,ingestionRunId:run.id,physicalPageIndex:0,routingGeneration:1,status:"SUCCEEDED",claimToken:claim,actualTier:"standard",executionStatus:"SUCCEEDED",qualityStatus:"REVIEW_REQUIRED",sourceIdentity:identity,textSha256:sha(text),authoritativeArtifactKey:keys[1]!}});
 const receipt=await prisma.ocrPageExecution.create({data:{pageAttemptId:page.id,pageClaimToken:claim,runExecutionToken:randomUUID(),actualTier:"standard",modelRevision:MINERU_MODEL_REVISION,manifestDigest:APPROVED_MINERU_MANIFEST_SHA256,executionStatus:"SUCCEEDED",sourceIdentity:identity,resultTextSha256:sha(text),qualityDecision:{status:"REVIEW_REQUIRED"}}});
 const store=new ProviderGatewayRepository(prisma,parseKeyring(keyring)!);const connection=await store.createConnection(context,{providerKey:"zhipu",protocol:"OPENAI_COMPATIBLE",displayName:"Synthetic HTTP only"});await store.rotateCredential(context,connection.id,"synthetic-secret");await store.setRoute(context,{routeSlot:"PDF_VISUAL_STRUCTURE",connectionId:connection.id,modelId:"glm-4.6v"});
 const input={...context,sourceDocumentId:doc.id,ingestionRunId:run.id,physicalPageIndex:0,receiptId:receipt.id,textSha256:sha(text),sourcePdfSha256:blob.sha256,consent:OCR_MODEL_REVIEW_CONSENT};
 const requested=await requestOcrModelReview(input);return {...context,root,keys,blob,doc,run,page,receipt,input,jobId:requested.jobId};
}
function runtime(options:{status?:"CLEAR"|"ISSUE"|"UNKNOWN";duringRemote?:()=>Promise<unknown>;malformed?:boolean;finishReason?:string}={}){
 const transport=new DeterministicProviderHttpTransport(async req=>{
  const body=JSON.parse(req.body);expect(body.max_tokens).toBe(1600);expect(body.thinking).toEqual({type:"disabled"});
  const user=body.messages.find((m:{role:string})=>m.role==="user");expect(user.content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  const identity=JSON.parse(user.content[0].text.split("\n")[0]);await options.duringRemote?.();
  return {status:200,headers:{},body:JSON.stringify({model:"glm-4.6v-reported-test",usage:{prompt_tokens:25,completion_tokens:50},choices:[{finish_reason:options.finishReason??"stop",message:{content:options.malformed?"not JSON":JSON.stringify({schemaVersion:1,...identity,axes:Object.fromEntries(OCR_REVIEW_AXES.map(a=>[a,{status:options.status??"CLEAR",reason:"Synthetic visible evidence."}]))})}}]})};
 });
 const r=createBookProductionGatewayRuntime(source,{adapterResolver:createProviderAdapterResolver(transport),validateEndpoint:async()=>undefined,circuit:{admit:async()=>undefined,recordSuccess:async()=>undefined,recordRetryableFailure:async()=>undefined},rate:{admit:async()=>undefined},concurrency:{acquire:async key=>({key,token:"test"}),release:async()=>true}});
 return {...r,transport};
}
async function execute(f:Awaited<ReturnType<typeof fixture>>,r:ReturnType<typeof runtime>){return processNextOcrStructureReview({gateway:r.gateway,repository:r.repository,storage,privateTempRoot:f.root},f.jobId);}
afterEach(async()=>{
 for(const f of owned.splice(0)){
  const where={workspaceId:f.workspaceId};await prisma.ocrModelReviewEvent.deleteMany({where});
  await prisma.providerUsageEvent.deleteMany({where});await prisma.providerInvocationAttempt.deleteMany({where});await prisma.providerInvocation.deleteMany({where});await prisma.providerExecutionSnapshot.deleteMany({where});
  await prisma.providerRouteBinding.deleteMany({where});await prisma.providerCredentialVersion.deleteMany({where});await prisma.providerConnection.deleteMany({where});
  await prisma.ocrPageAttempt.deleteMany({where});await prisma.ingestionRun.deleteMany({where});await prisma.job.deleteMany({where});await prisma.sourceDocument.deleteMany({where});await prisma.source.deleteMany({where});await prisma.sourceBlob.deleteMany({where});await prisma.workspaceMember.deleteMany({where});await prisma.workspace.delete({where:{id:f.workspaceId}});await prisma.user.delete({where:{id:f.userId}});
  for(const key of f.keys)await storage.deleteObject(key);await rm(f.root,{recursive:true,force:true});
 }
});
afterAll(async()=>{storage.close();await prisma.$disconnect();});
it.each([["CLEAR","PASSED"],["ISSUE","REJECTED"],["UNKNOWN","REVIEW_REQUIRED"]] as const)("persists independent %s judgement without canonical publication",async(status,decision)=>{
 const f=await fixture(),r=runtime({status});try{
 expect(await execute(f,r)).toBe("DONE");const event=await prisma.ocrModelReviewEvent.findUniqueOrThrow({where:{jobId:f.jobId}});
 expect(event).toMatchObject({receiptId:f.receipt.id,sourcePdfSha256:f.blob.sha256,ocrTextSha256:sha(text),decision,reportedModelId:"glm-4.6v-reported-test"});expect(event.sourcePngSha256).toMatch(/^[a-f0-9]{64}$/);
 expect(await prisma.providerUsageEvent.count({where:{invocationId:event.invocationId}})).toBe(1);expect(await prisma.providerTextResult.findUnique({where:{invocationId:event.invocationId}})).toMatchObject({consumerKey:f.jobId,ciphertext:null});
 expect(await prisma.documentExtraction.count({where:{ingestionRunId:f.run.id}})).toBe(0);expect(await prisma.currentDocumentExtraction.count({where:{sourceDocumentId:f.doc.id}})).toBe(0);expect(await readdir(f.root)).toEqual([]);
 expect(await requestOcrModelReview(f.input)).toEqual({jobId:f.jobId,status:"SUCCEEDED"});expect(await execute(f,r)).toBe("IDLE");expect(r.transport.calls).toHaveLength(1);
 await expect(prisma.ocrModelReviewEvent.update({where:{id:event.id},data:{decision:"PASSED"}})).rejects.toThrow();
 }finally{await r.close();}
});
it("two concurrent workers claim one page once",async()=>{
 const f=await fixture(),r=runtime();try{const outcomes=await Promise.all([execute(f,r),execute(f,r)]);expect(outcomes.sort()).toEqual(["DONE","IDLE"]);expect(r.transport.calls).toHaveLength(1);expect(await prisma.ocrModelReviewEvent.count({where:{jobId:f.jobId}})).toBe(1);}finally{await r.close();}
});
it.each(["expired","revoked","source-replaced","page-changed"])("rejects %s before HTTP",async fault=>{
 const f=await fixture(),r=runtime();try{
 if(fault==="expired"){const j=await prisma.job.findUniqueOrThrow({where:{id:f.jobId}});await prisma.job.update({where:{id:f.jobId},data:{payload:json({...j.payload as object,expiresAt:new Date(0).toISOString()})}});}
 if(fault==="revoked")await prisma.workspaceMember.update({where:{workspaceId_userId:{workspaceId:f.workspaceId,userId:f.userId}},data:{role:"VIEWER"}});
 if(fault==="source-replaced")await storage.putObject({key:f.keys[0]!,body:Buffer.from("%PDF-replaced"),contentType:"application/pdf"});
 if(fault==="page-changed")await prisma.ocrPageAttempt.update({where:{id:f.page.id},data:{claimToken:randomUUID()}});
 expect(await execute(f,r)).toBe("FAILED");expect(r.transport.calls).toHaveLength(0);expect(await execute(f,r)).toBe("IDLE");expect(await prisma.ocrModelReviewEvent.count({where:{jobId:f.jobId}})).toBe(0);
 }finally{await r.close();}
});
it.each(["revoked","plan-changed","successor-run","claim-lost"])("rejects late result after %s during remote call and never charges twice",async fault=>{
 const f=await fixture(),r=runtime({duringRemote:async()=>{
 if(fault==="revoked")await prisma.workspaceMember.update({where:{workspaceId_userId:{workspaceId:f.workspaceId,userId:f.userId}},data:{role:"VIEWER"}});
 if(fault==="plan-changed")await prisma.ingestionRun.update({where:{id:f.run.id},data:{routingPlan:{changed:true}}});
 if(fault==="claim-lost")await prisma.job.update({where:{id:f.jobId},data:{status:"CANCELLED"}});
 if(fault==="successor-run"){const job=await prisma.job.create({data:{workspaceId:f.workspaceId,userId:f.userId,type:"source.ingest",payload:{}}});await prisma.ingestionRun.create({data:{workspaceId:f.workspaceId,sourceDocumentId:f.doc.id,jobId:job.id,parserVersion:"1",normalizationVersion:"1"}});}
 }});try{expect(await execute(f,r)).toBe("FAILED");expect(await prisma.ocrModelReviewEvent.count({where:{jobId:f.jobId}})).toBe(0);expect(await prisma.providerUsageEvent.count({where:{workspaceId:f.workspaceId}})).toBe(1);expect(await execute(f,r)).toBe("IDLE");expect(r.transport.calls).toHaveLength(1);expect(await prisma.documentExtraction.count({where:{ingestionRunId:f.run.id}})).toBe(0);}finally{await r.close();}
});
it("malformed paid response retains usage and safe diagnostics without retry",async()=>{const f=await fixture(),r=runtime({malformed:true});try{expect(await execute(f,r)).toBe("FAILED");expect(await execute(f,r)).toBe("IDLE");expect(r.transport.calls).toHaveLength(1);expect(await prisma.ocrModelReviewEvent.count({where:{jobId:f.jobId}})).toBe(0);const usage=await prisma.providerUsageEvent.findFirstOrThrow({where:{workspaceId:f.workspaceId}});expect(usage).toMatchObject({inputTokens:25,outputTokens:50,status:"FAILED"});expect(JSON.stringify(usage.metadata)).toContain("contentCharacters");expect(JSON.stringify(usage.metadata)).not.toContain("not JSON");}finally{await r.close();}});
it.each(["length","content_filter"])("never accepts even valid JSON when finish_reason is %s",async finishReason=>{const f=await fixture(),r=runtime({finishReason});try{expect(await execute(f,r)).toBe("FAILED");expect(await prisma.ocrModelReviewEvent.count({where:{jobId:f.jobId}})).toBe(0);expect(await execute(f,r)).toBe("IDLE");expect(r.transport.calls).toHaveLength(1);}finally{await r.close();}});
it("requires explicit renewed consent, preserves failed Job and converges concurrent requests on one fresh child",async()=>{
 const f=await fixture(),bad=runtime({malformed:true}),good=runtime();try{
 await expect(requestOcrModelReview({...f.input,previousFailedJobId:f.jobId})).rejects.toThrow("OCR_REVIEW_REAUTHORIZATION_INVALID");
 expect(await execute(f,bad)).toBe("FAILED");expect(await requestOcrModelReview(f.input)).toEqual({jobId:f.jobId,status:"FAILED"});
 const input={...f.input,previousFailedJobId:f.jobId};const [a,b]=await Promise.all([requestOcrModelReview(input),requestOcrModelReview(input)]);expect(a.jobId).toBe(b.jobId);expect(a.jobId).not.toBe(f.jobId);
 expect(await execute({...f,jobId:a.jobId},good)).toBe("DONE");expect(await prisma.job.findUnique({where:{id:f.jobId}})).toMatchObject({status:"FAILED",attemptCount:1});expect(await prisma.job.findUnique({where:{id:a.jobId}})).toMatchObject({status:"SUCCEEDED",attemptCount:1});expect(bad.transport.calls).toHaveLength(1);expect(good.transport.calls).toHaveLength(1);
 await expect(requestOcrModelReview({...f.input,previousFailedJobId:a.jobId})).rejects.toThrow("OCR_REVIEW_REAUTHORIZATION_INVALID");
 }finally{await bad.close();await good.close();}
});
