import { claimBookAnalysisRun, withOwnedAnalysisTransaction } from "@ai-cognitive/book-intelligence";
import { afterEach, expect, it, vi } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { stableHash } from "@ai-cognitive/provider-gateway";
import { activateBookPaidGrant, bindBookPaidGrant, cancelBookPaidGrant, BOOK_PAID_GRANT_TYPE, bookPaidExposureMicroCny, createBookPaidResolver, type BookPaidGrant } from "../src/book-paid-authorization.js";
const owned: Array<{ workspaceId: string; userId: string }> = [];
async function fixture(maxMicroCny = 5_000_000) {
  const w = await prisma.workspace.create({ data: { name: "paid-book-fixture" } }), u = await prisma.user.create({ data: { email: crypto.randomUUID()+"@book-budget.test" } });
  owned.push({workspaceId:w.id,userId:u.id});
  await prisma.workspaceMember.create({ data: { workspaceId:w.id,userId:u.id,role:"OWNER" } });
  const source = await prisma.source.create({ data: { workspaceId:w.id,kind:"FILE",displayName:"fixture" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId:w.id,sha256:crypto.randomUUID(),sizeBytes:1,mediaType:"text/plain",storageKey:"fixture" } });
  const doc = await prisma.sourceDocument.create({data:{workspaceId:w.id,sourceId:source.id,sourceBlobId:blob.id,version:1,sha256:blob.sha256,sizeBytes:1,mediaType:blob.mediaType,storageKey:blob.storageKey}});
  const job = await prisma.job.create({data:{workspaceId:w.id,userId:u.id,type:"fixture",payload:{}}});
  const run = await prisma.ingestionRun.create({data:{workspaceId:w.id,sourceDocumentId:doc.id,jobId:job.id,status:"SUCCEEDED",parserVersion:"fixture",normalizationVersion:"fixture"}});
  const extraction = await prisma.documentExtraction.create({data:{workspaceId:w.id,sourceDocumentId:doc.id,ingestionRunId:run.id,status:"SUCCEEDED",parserName:"fixture",parserVersion:"fixture",normalizationVersion:"fixture"}});
  await prisma.currentDocumentExtraction.create({data:{workspaceId:w.id,sourceDocumentId:doc.id,extractionId:extraction.id}});
  let payload: BookPaidGrant={version:1,sourceDocumentId:doc.id,extractionId:extraction.id,sha256:doc.sha256,bootstrapId:"fixture",expiresAt:new Date(Date.now()+60000).toISOString(),credentialIds:["fixture-key-version"],maxMicroCny,reservedMicroCny:0,textCalls:0,embeddingCalls:0,entries:[]};
  const grant=await prisma.job.create({data:{workspaceId:w.id,userId:u.id,type:BOOK_PAID_GRANT_TYPE,payload:payload as never}});
  const bookJob=await prisma.job.create({data:{workspaceId:w.id,userId:u.id,type:"book.analysis",payload:{}}});
  const chunkSet=await prisma.chunkSet.create({data:{workspaceId:w.id,sourceDocumentId:doc.id,extractionId:extraction.id,chunkingVersion:"fixture",configuration:{},configurationHash:crypto.randomUUID(),status:"SUCCEEDED"}});
  const bookRun=await prisma.bookAnalysisRun.create({data:{workspaceId:w.id,sourceDocumentId:doc.id,extractionId:extraction.id,chunkSetId:chunkSet.id,jobId:bookJob.id,pipelineVersion:"fixture",promptVersion:"fixture",provider:"zhipu",model:"glm-5.3-flash",modelVersionKey:"fixture",idempotencyKey:crypto.randomUUID(),analysisIdentityHash:crypto.randomUUID()}});
  await bindBookPaidGrant(grant.id,bookRun.id,{workspaceId:w.id,userId:u.id});
  payload=(await prisma.job.findUniqueOrThrow({where:{id:grant.id}})).payload as unknown as BookPaidGrant;
  const context={analysisRunId:bookRun.id,jobId:bookJob.id,dispatchGeneration:0,claimToken:crypto.randomUUID(),userId:u.id,workspaceId:w.id};
  await prisma.bookAnalysisRun.update({where:{id:bookRun.id},data:{status:"RUNNING",executionClaimToken:context.claimToken,executionLeaseUntil:new Date(Date.now()+120000)}});
  await prisma.job.update({where:{id:bookJob.id},data:{status:"RUNNING"}});
  const wire=vi.fn(async()=>({status:200,headers:{},body:JSON.stringify({model:"glm-5.3-flash",choices:[{message:{content:'{"summary":"ok"}'},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:10}})}));
  const resolver=createBookPaidResolver(grant.id,{execute:wire,executeBinary:vi.fn()});
  const adapter=resolver({providerKey:"zhipu",protocol:"OPENAI_COMPATIBLE",family:"TEXT_GENERATION",modelId:"glm-5.3-flash"})!;
  const input={snapshot:{id:crypto.randomUUID(),workspaceId:w.id,providerKey:"zhipu",protocol:"OPENAI_COMPATIBLE",modelId:"glm-5.3-flash",routeSlot:"BOOK_CHUNK_ANALYSIS",credentialVersionId:"fixture-key-version",endpoint:"https://open.bigmodel.cn/api/paas/v4/chat/completions",capability:{families:["TEXT_GENERATION"]}},request:{workspaceId:w.id,bookExecution:context,idempotencyKey:`book-analysis-text:${bookRun.id}:${bookJob.id}:CHUNK:fixture`,requestFingerprint:"a".repeat(64),capability:{family:"TEXT_GENERATION"},text:{messages:[{role:"user",content:"original test"}],structuredOutput:{mode:"JSON_MODE"}}},signal:new AbortController().signal,credential:"fake-key"} as unknown as Parameters<typeof adapter.execute>[0];
  return {w,u,source,doc,grant,payload,wire,adapter,input,context,bookRun,bookJob};
}
afterEach(async()=>{for(const item of owned.splice(0)){const where={workspaceId:item.workspaceId};await prisma.bookAnalysisRun.deleteMany({where});await prisma.chunkSet.deleteMany({where});await prisma.currentDocumentExtraction.deleteMany({where});await prisma.documentExtraction.deleteMany({where});await prisma.ingestionRun.deleteMany({where});await prisma.job.deleteMany({where});await prisma.sourceDocument.deleteMany({where});await prisma.source.deleteMany({where});await prisma.sourceBlob.deleteMany({where});await prisma.workspaceMember.deleteMany({where});await prisma.workspace.delete({where:{id:item.workspaceId}});await prisma.user.delete({where:{id:item.userId}});}});
async function mergeFixture(){
 const f=await fixture();
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,providerPolicy:"MINIMAX_M3_CN_MERGE_V1",maxMicroCny:10_000_000,maxTextCalls:65,maxEmbeddingCalls:9} as never}});
 await prisma.job.update({where:{id:f.bookJob.id},data:{payload:{bookPaidGrantId:f.grant.id,frozenChunks:{hash:"fixture"}}}});
 await prisma.bookAnalysisRun.update({where:{id:f.bookRun.id},data:{analysisStage:"SECTION_ANALYSIS"}});
 f.wire.mockResolvedValue({status:200,headers:{},body:JSON.stringify({model:"MiniMax-M3",choices:[{finish_reason:"stop",message:{content:'{"summary":"derived"}'}}],usage:{prompt_tokens:10,completion_tokens:10}})});
 const adapter=createBookPaidResolver(f.grant.id,{execute:f.wire,executeBinary:vi.fn()})({providerKey:"minimax",protocol:"OPENAI_COMPATIBLE",family:"TEXT_GENERATION",modelId:"MiniMax-M3"})!;
 const input={...f.input,snapshot:{...f.input.snapshot,providerKey:"minimax",modelId:"MiniMax-M3",routeSlot:"BOOK_REDUCTION_ANALYSIS",endpoint:"https://api.minimax.cn/v1/chat/completions"},request:{...f.input.request,idempotencyKey:`book-analysis-text:${f.bookRun.id}:${f.bookJob.id}:SECTION:${"a".repeat(64)}`}} as typeof f.input;
 await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});return {...f,adapter,input};
}
async function mergeContinuationFixture(){
 const f=await mergeFixture(),payload=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;
 const prior=await prisma.job.create({data:{workspaceId:f.w.id,userId:f.u.id,type:BOOK_PAID_GRANT_TYPE,status:"FAILED",payload:{...f.payload,reservedMicroCny:618735,stopped:true}}});
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...payload,maxMicroCny:9381265,mergeContinuation:{maxOutputTokens:16000,priorReservedMicroCny:618735,cumulativeMaxMicroCny:10000000,carryForward:[{grantId:prior.id,digest:stableHash(prior.payload),reservedMicroCny:618735}]}} as never}});
 return {...f,prior};
}
it.each(["valid","changed-prior","no-budget","timeout"])("full merge continuation %s preserves prior ledgers and accounts bounded exposure",async fault=>{
 const f=await mergeContinuationFixture();
 if(fault==="changed-prior")await prisma.job.update({where:{id:f.prior.id},data:{payload:{...f.payload,reservedMicroCny:618736,stopped:true}}});
 if(fault==="no-budget"){const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload;await prisma.job.update({where:{id:f.grant.id},data:{payload:{...(p as object),maxMicroCny:1}}});}
 if(fault==="timeout")f.wire.mockRejectedValueOnce(new Error("CONTINUATION_TIMEOUT"));
 if(fault!=="valid"){await expect(f.adapter.execute(f.input)).rejects.toThrow();expect(f.wire).toHaveBeenCalledTimes(fault==="timeout"?1:0);const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;if(fault==="timeout")expect(bookPaidExposureMicroCny(p)).toBe(p.reservedMicroCny);return;}
 await f.adapter.execute(f.input);const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant,body=JSON.parse((f.wire.mock.calls[0] as unknown as [{body:string}])[0].body);
 expect(body.max_completion_tokens).toBe(16000);expect(p.reservedMicroCny).toBeGreaterThan(134400);expect(p.entries[0]).toMatchObject({reportedInputTokens:10,reportedOutputTokens:10});expect(bookPaidExposureMicroCny(p)).toBe(105);expect((await prisma.job.findUniqueOrThrow({where:{id:f.prior.id}})).payload).toEqual(f.prior.payload);
});
it("full merge continuation records bounded embedding usage separately from its immutable reservation",async()=>{
 const f=await mergeContinuationFixture();await prisma.bookAnalysisRun.update({where:{id:f.bookRun.id},data:{analysisStage:"EMBEDDINGS"}});
 f.wire.mockResolvedValue({status:200,headers:{},body:JSON.stringify({model:"embedding-3",data:[{index:0,embedding:Array.from({length:2048},(_,i)=>i===0?1:0)}],usage:{prompt_tokens:10,total_tokens:10}})});
 const adapter=createBookPaidResolver(f.grant.id,{execute:f.wire,executeBinary:vi.fn()})({providerKey:"zhipu",protocol:"OPENAI_EMBEDDINGS",family:"EMBEDDING",modelId:"embedding-3"})!;
 const input={...f.input,snapshot:{...f.input.snapshot,providerKey:"zhipu",protocol:"OPENAI_EMBEDDINGS",modelId:"embedding-3",routeSlot:"EMBEDDING",endpoint:"https://open.bigmodel.cn/api/paas/v4/embeddings",configuration:{},capability:{families:["EMBEDDING"],embeddingDimensions:2048}},request:{workspaceId:f.w.id,bookExecution:f.context,idempotencyKey:`book-analysis-embeddings:${f.bookRun.id}`,requestFingerprint:"b".repeat(64),capability:{family:"EMBEDDING"},embedding:{texts:["source"],purpose:"DOCUMENT"}}} as unknown as typeof f.input;
 await adapter.execute(input);const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(p.reservedMicroCny).toBe(1536);expect(p.entries[0]).toMatchObject({reportedInputTokens:10,inputCount:1});expect(bookPaidExposureMicroCny(p)).toBe(5);
});
it("continuation preserves stage limits already consumed by a prior execution",async()=>{
 const f=await mergeContinuationFixture(),p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...p,maxTextCalls:64,mergeContinuation:{...p.mergeContinuation!,priorStageCounts:{SECTION:46,CHAPTER:0,BOOK:0,EMBEDDINGS:0},priorEmbeddingInputCount:0}} as never}});
 await expect(f.adapter.execute(f.input)).rejects.toThrow();expect(f.wire).not.toHaveBeenCalled();
});
it.each(["SECTION","CHAPTER","BOOK"])("uses the explicitly approved direct-response mode only for SECTION, current stage %s",async stage=>{
 const f=await mergeContinuationFixture(),p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...p,mergeContinuation:{...p.mergeContinuation!,sectionThinking:"disabled",sectionOutputLimit:4096}} as never}});
 await prisma.bookAnalysisRun.update({where:{id:f.bookRun.id},data:{analysisStage:stage==="BOOK"?"BOOK_SYNTHESIS":stage==="CHAPTER"?"CHAPTER_ANALYSIS":"SECTION_ANALYSIS"}});
 const input={...f.input,snapshot:{...f.input.snapshot,routeSlot:stage==="BOOK"?"BOOK_SYNTHESIS":"BOOK_REDUCTION_ANALYSIS"},request:{...f.input.request,idempotencyKey:`book-analysis-text:${f.bookRun.id}:${f.bookJob.id}:${stage}:${"c".repeat(64)}`}} as typeof f.input;
 await f.adapter.execute(input);const body=JSON.parse((f.wire.mock.calls[0] as unknown as [{body:string}])[0].body);expect(body.thinking).toEqual(stage==="SECTION"?{type:"disabled"}:undefined);expect(body.max_completion_tokens).toBe(stage==="SECTION"?4096:16000);
});
it.each(["valid","wrong-operation","changed-input","changed-prior"])("one-shot 16K merge probe %s obeys its exact approved input and prior reservation",async fault=>{
 const f=await mergeFixture(),prior=await prisma.job.create({data:{workspaceId:f.w.id,userId:f.u.id,type:BOOK_PAID_GRANT_TYPE,status:"FAILED",payload:{...f.payload,stopped:true,reservedMicroCny:103845}}}),p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;
 const originalBodyHash=stableHash({model:"MiniMax-M3",messages:[{role:"user",content:"original test"}],max_completion_tokens:8000,reasoning_split:true,stream:false});
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...p,maxMicroCny:203213,maxTextCalls:1,maxEmbeddingCalls:0,mergeProbe:{operationKey:"a".repeat(64),originalBodyHash,priorGrantId:prior.id,priorReservedMicroCny:103845,cumulativeMaxMicroCny:10000000}} as never}});
 const input=structuredClone(f.input);if(fault==="wrong-operation")input.request.idempotencyKey=input.request.idempotencyKey.replace(/a{64}$/,"b".repeat(64));if(fault==="changed-input")input.request.text!.messages[0]!.content="changed input";
 if(fault==="changed-prior")await prisma.job.update({where:{id:prior.id},data:{payload:{...f.payload,stopped:true,reservedMicroCny:103846}}});
 if(fault!=="valid"){await expect(f.adapter.execute(input)).rejects.toThrow();expect(f.wire).not.toHaveBeenCalled();return;}
 await f.adapter.execute(input);const body=JSON.parse((f.wire.mock.calls[0] as unknown as [{body:string}])[0].body);expect(body.max_completion_tokens).toBe(16000);
 await expect(f.adapter.execute(input)).rejects.toThrow();expect(f.wire).toHaveBeenCalledTimes(1);const stored=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(stored.textCalls).toBe(1);expect(stored.embeddingCalls).toBe(0);expect(stored.reservedMicroCny).toBeLessThanOrEqual(203213);expect((await prisma.job.findUniqueOrThrow({where:{id:prior.id}})).payload).toEqual(prior.payload);
});
it("merge authorization reserves once, caps M3 output at 8000 and refuses CHUNK requests",async()=>{
 const f=await mergeFixture();await f.adapter.execute(f.input);expect(f.wire).toHaveBeenCalledTimes(1);
 const body=JSON.parse((f.wire.mock.calls[0] as unknown as [{body:string}])[0].body);expect(body.max_completion_tokens).toBe(8000);
 const stored=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(stored.textCalls).toBe(1);expect(stored.entries[0]).toMatchObject({stage:"SECTION",state:"RESPONSE_RECEIVED"});expect(stored.reservedMicroCny).toBeLessThanOrEqual(136013);
 await expect(f.adapter.execute({...f.input,request:{...f.input.request,idempotencyKey:`book-analysis-text:${f.bookRun.id}:${f.bookJob.id}:CHUNK:chunk:x:y`}})).rejects.toThrow();expect(f.wire).toHaveBeenCalledTimes(1);
});
it.each(["stage-cap","no-budget","wrong-stage","missing-frozen"])("merge blocks %s before the transport",async fault=>{
 const f=await mergeFixture(),p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;
 if(fault==="stage-cap"){const entries=Array.from({length:46},(_,i)=>({ordinal:i+1,kind:"TEXT" as const,stage:"SECTION",reservedMicroCny:1,inputUpper:1,outputMax:1,state:"RESPONSE_RECEIVED",operationKey:String(i)}));await prisma.job.update({where:{id:f.grant.id},data:{payload:{...p,entries,reservedMicroCny:46,textCalls:46} as never}});}
 if(fault==="no-budget")await prisma.job.update({where:{id:f.grant.id},data:{payload:{...p,maxMicroCny:1} as never}});
 if(fault==="wrong-stage")await prisma.bookAnalysisRun.update({where:{id:f.bookRun.id},data:{analysisStage:"BOOK_SYNTHESIS"}});
 if(fault==="missing-frozen")await prisma.job.update({where:{id:f.bookJob.id},data:{payload:{bookPaidGrantId:f.grant.id}}});
 await expect(f.adapter.execute(f.input)).rejects.toThrow();expect(f.wire).not.toHaveBeenCalled();
});
it("merge retains the complete reservation and stops on a timeout without retry",async()=>{
 const f=await mergeFixture();f.wire.mockRejectedValueOnce(new Error("MERGE_TIMEOUT"));await expect(f.adapter.execute(f.input)).rejects.toThrow("MERGE_TIMEOUT");await expect(f.adapter.execute(f.input)).rejects.toThrow();expect(f.wire).toHaveBeenCalledTimes(1);
 const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(p.stopped).toBe(true);expect(p.reservedMicroCny).toBeGreaterThan(0);expect(p.entries[0]?.state).toBe("REMOTE_OUTCOME_UNKNOWN");
});
it("merge keeps supplier usage for a truncated JSON response without releasing its reservation or retrying",async()=>{
 const f=await mergeFixture();f.wire.mockResolvedValueOnce({status:200,headers:{},body:JSON.stringify({model:"MiniMax-M3",choices:[{finish_reason:"length",message:{content:'{"summary":"unfinished'}}],usage:{prompt_tokens:3446,completion_tokens:8000,total_tokens:11446}})});
 await expect(f.adapter.execute(f.input)).rejects.toThrow();const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;
 expect(p.entries[0]).toMatchObject({reportedInputTokens:3446,reportedOutputTokens:8000,outputMax:8000,state:"RESPONSE_RECEIVED"});expect(p.stopped).toBe(true);expect(bookPaidExposureMicroCny(p)).toBe(p.reservedMicroCny);await expect(f.adapter.execute(f.input)).rejects.toThrow();expect(f.wire).toHaveBeenCalledTimes(1);
});
it.each(["valid","too-many-items","too-long","wrong-dimensions"])("merge embedding %s is checked before spending",async fault=>{
 const f=await mergeFixture();await prisma.bookAnalysisRun.update({where:{id:f.bookRun.id},data:{analysisStage:"EMBEDDINGS"}});
 const texts=fault==="too-many-items"?Array(65).fill("text"):fault==="too-long"?["中".repeat(3073)]:["source"];
 f.wire.mockResolvedValue({status:200,headers:{},body:JSON.stringify({model:"embedding-3",data:[{index:0,embedding:Array.from({length:2048},(_,i)=>i===0?1:0)}],usage:{prompt_tokens:5,total_tokens:5}})});
 const adapter=createBookPaidResolver(f.grant.id,{execute:f.wire,executeBinary:vi.fn()})({providerKey:"zhipu",protocol:"OPENAI_EMBEDDINGS",family:"EMBEDDING",modelId:"embedding-3"})!;
 const input={...f.input,snapshot:{...f.input.snapshot,providerKey:"zhipu",protocol:"OPENAI_EMBEDDINGS",modelId:"embedding-3",routeSlot:"EMBEDDING",endpoint:"https://open.bigmodel.cn/api/paas/v4/embeddings",configuration:{},capability:{families:["EMBEDDING"],embeddingDimensions:fault==="wrong-dimensions"?1024:2048}},request:{workspaceId:f.w.id,bookExecution:f.context,idempotencyKey:`book-analysis-embeddings:${f.bookRun.id}`,requestFingerprint:"b".repeat(64),capability:{family:"EMBEDDING"},embedding:{texts,purpose:"DOCUMENT"}}} as unknown as typeof f.input;
 if(fault!=="valid"){await expect(adapter.execute(input)).rejects.toThrow();expect(f.wire).not.toHaveBeenCalled();return;}
 await adapter.execute(input);expect(f.wire).toHaveBeenCalledTimes(1);const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(p.embeddingCalls).toBe(1);expect(p.reservedMicroCny).toBe(1536);expect(p.entries[0]).toMatchObject({stage:"EMBEDDINGS",inputCount:1});
});
it("requires explicit activation, caps output and durably reserves the complete request before the network",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});await expect(activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id})).rejects.toThrow("ALREADY_STARTED");
 await f.adapter.execute(f.input);expect(f.wire).toHaveBeenCalledTimes(1);
 const body=JSON.parse((f.wire.mock.calls[0] as unknown as [{body:string}])[0].body);expect(JSON.stringify(body)).not.toContain(f.context.claimToken);expect(body.max_tokens).toBe(4000);expect(body.thinking).toEqual({type:"enabled"});expect(body.reasoning_effort).toBe("low");
 const stored=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(stored.textCalls).toBe(1);expect(stored.reservedMicroCny).toBeGreaterThan(11200);expect(stored.entries[0]?.inputUpper).toBeGreaterThan(4096);
});
it("serializes simultaneous reservations and never exceeds the authorization",async()=>{
 const f=await fixture(20000);await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 const results=await Promise.allSettled([f.adapter.execute(f.input),f.adapter.execute(f.input)]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(f.wire).toHaveBeenCalledTimes(1);
 const stored=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(stored.reservedMicroCny).toBeLessThanOrEqual(20000);expect(stored.textCalls).toBe(1);
});
it("retains unknown-cost reservations and blocks all automatic retries after failure",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});f.wire.mockRejectedValueOnce(new Error("TEST_TIMEOUT"));
 await expect(f.adapter.execute(f.input)).rejects.toThrow("TEST_TIMEOUT");await expect(f.adapter.execute(f.input)).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});expect(f.wire).toHaveBeenCalledTimes(1);
 const stored=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(stored.reservedMicroCny).toBeGreaterThan(0);expect(stored.stopped).toBe(true);
});
it.each(["archived","expired","viewer","wrong-key","no-budget"])("blocks %s before sending any content",async(kind)=>{
 const f=await fixture(kind==="no-budget"?1:5_000_000);await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 if(kind==="archived")await prisma.source.update({where:{id:f.source.id},data:{archivedAt:new Date()}});
 if(kind==="expired")await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,expiresAt:new Date(0).toISOString()} as never}});
 if(kind==="viewer")await prisma.workspaceMember.update({where:{workspaceId_userId:{workspaceId:f.w.id,userId:f.u.id}},data:{role:"VIEWER"}});
 if(kind==="wrong-key")await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,credentialIds:["other"]} as never}});
 await expect(f.adapter.execute(f.input)).rejects.toThrow();expect(f.wire).not.toHaveBeenCalled();
});

it("retains a safe upstream error code and HTTP status without leaking raw response text",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 f.wire.mockResolvedValueOnce({status:400,headers:{},body:JSON.stringify({error:{code:"1210",message:"fake-key and private-book-content"}})});
 await expect(f.adapter.execute(f.input)).rejects.toThrow();
 const stored=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;
 expect(stored.entries[0]).toMatchObject({httpStatus:400,remoteErrorCode:"1210",state:"REMOTE_REJECTED"});
 expect(JSON.stringify(stored)).not.toContain("private-book-content");expect(JSON.stringify(stored)).not.toContain("fake-key");
});

it("honors a reduced request allowance when an operator prepares a manual continuation",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,maxTextCalls:1} as never}});
 await f.adapter.execute(f.input);await expect(f.adapter.execute({...f.input,request:{...f.input.request,idempotencyKey:f.input.request.idempotencyKey+":another"}})).rejects.toMatchObject({code:"BUDGET_EXCEEDED"});expect(f.wire).toHaveBeenCalledTimes(1);
});
it("records truncated JSON diagnostics without persisting model content",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 const content='{"summary":"private-book-content';
 f.wire.mockResolvedValueOnce({status:200,headers:{},body:JSON.stringify({choices:[{finish_reason:"length",message:{content}}]})});
 await expect(f.adapter.execute(f.input)).rejects.toThrow();
 const stored=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;
 expect(stored.entries[0]).toMatchObject({responseDiagnostics:{finishReason:"length",contentCharacters:content.length,jsonComplete:false}});
 expect(JSON.stringify(stored)).not.toContain("private-book-content");expect(stored.stopped).toBe(true);
});

it("blocks concurrent duplicate operations without a second reservation or stopping the winner",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 const results=await Promise.allSettled([f.adapter.execute(f.input),f.adapter.execute(f.input)]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(f.wire).toHaveBeenCalledTimes(1);
 const stored=await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}});const payload=stored.payload as unknown as BookPaidGrant;
 expect(payload.textCalls).toBe(1);expect(payload.entries).toHaveLength(1);expect(stored.status).toBe("RUNNING");
 await expect(f.adapter.execute({...f.input,request:{...f.input.request,requestFingerprint:"b".repeat(64)}})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});expect(f.wire).toHaveBeenCalledTimes(1);
});

it("blocks cross-workspace snapshots before transport",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 await expect(f.adapter.execute({...f.input,snapshot:{...f.input.snapshot,workspaceId:crypto.randomUUID()}})).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});expect(f.wire).not.toHaveBeenCalled();
});
it("refuses legacy reservations without operation identity and preserves historical entries",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 const entries:BookPaidGrant["entries"]=[{ordinal:1,kind:"TEXT",reservedMicroCny:100,inputUpper:100,outputMax:1,state:"RESERVED"}];
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,entries,textCalls:1,reservedMicroCny:100}as never}});
 await expect(f.adapter.execute(f.input)).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});expect(f.wire).not.toHaveBeenCalled();
 const stored=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(stored.entries).toEqual(entries);expect(stored.reservedMicroCny).toBe(100);
});

it("does not overwrite a cancelled grant or send another request",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 await prisma.job.update({where:{id:f.grant.id},data:{status:"CANCELLED"}});
 await expect(f.adapter.execute(f.input)).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});expect(f.wire).not.toHaveBeenCalled();
 expect((await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).status).toBe("CANCELLED");
});

function barrier(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
it.each(["job","generation","token","user","run"])("denies stale or foreign execution %s before reservation",async kind=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 const execution={...f.context,...(kind==="job"?{jobId:crypto.randomUUID()}:kind==="generation"?{dispatchGeneration:1}:kind==="token"?{claimToken:crypto.randomUUID()}:kind==="user"?{userId:crypto.randomUUID()}:{analysisRunId:crypto.randomUUID()})};
 await expect(f.adapter.execute({...f.input,request:{...f.input.request,bookExecution:execution}})).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});expect(f.wire).not.toHaveBeenCalled();
 expect(((await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant).entries).toHaveLength(0);
});
it("requires the granting actor to activate or cancel",async()=>{
 const f=await fixture();const other={workspaceId:f.w.id,userId:crypto.randomUUID()};
 await expect(activateBookPaidGrant(f.grant.id,other)).rejects.toThrow("ACTOR_DENIED");await expect(cancelBookPaidGrant(f.grant.id,other)).rejects.toThrow("ACTOR_DENIED");expect(f.wire).not.toHaveBeenCalled();
});
it("serializes cancellation winning against a waiting claim",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 await prisma.bookAnalysisRun.update({where:{id:f.bookRun.id},data:{status:"QUEUED",executionClaimToken:null,executionLeaseUntil:null}});await prisma.job.update({where:{id:f.bookJob.id},data:{status:"QUEUED"}});
 const locked=barrier(),release=barrier();const blocker=prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT "id" FROM "BookAnalysisRun" WHERE "id"=${f.bookRun.id} FOR UPDATE`;locked.resolve();await release.promise;await tx.job.update({where:{id:f.bookJob.id},data:{status:"CANCELLED"}});},{timeout:10000});
 await locked.promise;const claim=claimBookAnalysisRun(f.bookRun.id,crypto.randomUUID(),0);release.resolve();await blocker;expect(await claim).toBe(false);
 expect((await prisma.bookAnalysisRun.findUniqueOrThrow({where:{id:f.bookRun.id}})).executionClaimToken).toBeNull();
});
it("quarantines an in-flight response after cancel and retains the billed reservation",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});const sent=barrier(),respond=barrier();
 f.wire.mockImplementationOnce(async()=>{sent.resolve();await respond.promise;return{status:200,headers:{},body:JSON.stringify({choices:[{finish_reason:"stop",message:{content:'{"summary":"late"}'}}],usage:{prompt_tokens:10,completion_tokens:4}})};});
 const pending=f.adapter.execute(f.input);const rejected=expect(pending).rejects.toMatchObject({code:"AUTHORIZATION_FAILED",usage:{inputTokens:10,outputTokens:4}});
 await sent.promise;await cancelBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});respond.resolve();await rejected;
 const job=await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}}),p=job.payload as unknown as BookPaidGrant;expect(job.status).toBe("CANCELLED");expect(p.reservedMicroCny).toBeGreaterThan(0);expect(p.entries[0]?.state).toBe("RESPONSE_QUARANTINED");
 await expect(withOwnedAnalysisTransaction(f.bookRun.id,f.context.claimToken,async()=>{throw new Error("BUSINESS_WRITE_REACHED");})).rejects.not.toThrow("BUSINESS_WRITE_REACHED");
});
it("blocks materialization after a valid response is returned and grant is cancelled",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});await f.adapter.execute(f.input);
 await cancelBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});await cancelBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 let writes=0;await expect(withOwnedAnalysisTransaction(f.bookRun.id,f.context.claimToken,async()=>{writes++;})).rejects.toThrow("OWNERSHIP_LOST");expect(writes).toBe(0);
 expect(((await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant).entries).toHaveLength(1);
});
it("does not let an obsolete owner stop the new owner's authorization",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 await prisma.bookAnalysisRun.update({where:{id:f.bookRun.id},data:{executionClaimToken:crypto.randomUUID()}});
 await expect(f.adapter.execute(f.input)).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});expect(f.wire).not.toHaveBeenCalled();expect((await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).status).toBe("RUNNING");
});

it("admits only one of two concurrent claims and denies the other execution",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});await prisma.bookAnalysisRun.update({where:{id:f.bookRun.id},data:{status:"QUEUED",executionClaimToken:null,executionLeaseUntil:null}});await prisma.job.update({where:{id:f.bookJob.id},data:{status:"QUEUED"}});
 const tokens=[crypto.randomUUID(),crypto.randomUUID()];const results=await Promise.all(tokens.map(token=>claimBookAnalysisRun(f.bookRun.id,token,0)));expect(results.filter(Boolean)).toHaveLength(1);
 const current={...f.context,claimToken:tokens[results.indexOf(true)]!};const stale={...f.context,claimToken:tokens[results.indexOf(false)]!};
 await expect(f.adapter.execute({...f.input,request:{...f.input.request,bookExecution:stale}})).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});
 await f.adapter.execute({...f.input,request:{...f.input.request,bookExecution:current}});expect(f.wire).toHaveBeenCalledTimes(1);
});
it.each(["expired","cancelled"])("rechecks %s authority after durable reservation but before send admission",async kind=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 const resolver=createBookPaidResolver(f.grant.id,{execute:f.wire,executeBinary:vi.fn()},{beforeSendAdmission:async()=>{
  const job=await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}});expect((job.payload as unknown as BookPaidGrant).entries).toHaveLength(1);
  if(kind==="cancelled")await cancelBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});else await prisma.job.update({where:{id:f.grant.id},data:{payload:{...(job.payload as object),expiresAt:new Date(0).toISOString()}}});
 }});const adapter=resolver({providerKey:"zhipu",protocol:"OPENAI_COMPATIBLE",family:"TEXT_GENERATION",modelId:"glm-5.3-flash"})!;
 await expect(adapter.execute(f.input)).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});expect(f.wire).not.toHaveBeenCalled();
});
it("preserves cancellation when a dispatched request fails with an unknown remote outcome",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});const sent=barrier(),release=barrier();f.wire.mockImplementationOnce(async()=>{sent.resolve();await release.promise;throw new Error("REMOTE_TIMEOUT");});
 const result=f.adapter.execute(f.input);const rejection=expect(result).rejects.toThrow("REMOTE_TIMEOUT");await sent.promise;await cancelBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});release.resolve();await rejection;
 const job=await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}}),p=job.payload as unknown as BookPaidGrant;expect(job.status).toBe("CANCELLED");expect(p.entries[0]?.state).toBe("REMOTE_OUTCOME_UNKNOWN");expect(p.reservedMicroCny).toBeGreaterThan(0);
 await expect(activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id})).rejects.toThrow();expect(f.wire).toHaveBeenCalledTimes(1);
});
it("does not allow an old grant to authorize a new execution Job",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});const job=await prisma.job.create({data:{workspaceId:f.w.id,userId:f.u.id,type:"book.analysis",status:"RUNNING",payload:{}}});
 await prisma.bookAnalysisRun.update({where:{id:f.bookRun.id},data:{jobId:job.id,dispatchGeneration:1}});
 const context={...f.context,jobId:job.id,dispatchGeneration:1};await expect(f.adapter.execute({...f.input,request:{...f.input.request,idempotencyKey:`book-analysis-text:${f.bookRun.id}:${job.id}:CHUNK:fixture`,bookExecution:context}})).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});expect(f.wire).not.toHaveBeenCalled();
});
it("allows a pre-cancellation result transaction to finish, then serializes cancellation",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});const locked=barrier(),release=barrier();
 const write=withOwnedAnalysisTransaction(f.bookRun.id,f.context.claimToken,async tx=>{locked.resolve();await release.promise;await tx.job.update({where:{id:f.bookJob.id},data:{progress:37}});});
 await locked.promise;const cancel=cancelBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});release.resolve();await write;await cancel;
 const job=await prisma.job.findUniqueOrThrow({where:{id:f.bookJob.id}});expect(job.status).toBe("CANCELLED");expect(job.progress).toBe(37);
});

it("denies an unbound historical grant without modifying its queued status",async()=>{
 const f=await fixture();const {binding:_binding,...legacy}=f.payload as BookPaidGrant & {binding?:unknown};void _binding;
 await prisma.job.update({where:{id:f.grant.id},data:{payload:legacy as never}});
 await expect(activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id})).rejects.toThrow("BINDING_REQUIRED");expect((await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).status).toBe("QUEUED");expect(f.wire).not.toHaveBeenCalled();
});
it("quarantines a late response from the old lease without stopping the new owner",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});const sent=barrier(),release=barrier();
 f.wire.mockImplementationOnce(async()=>{sent.resolve();await release.promise;return{status:200,headers:{},body:JSON.stringify({choices:[{finish_reason:"stop",message:{content:'{"summary":"late"}'}}]})};});
 const pending=f.adapter.execute(f.input);const rejection=expect(pending).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});await sent.promise;
 await prisma.bookAnalysisRun.update({where:{id:f.bookRun.id},data:{executionLeaseUntil:new Date(Date.now()-1000)}});const newToken=crypto.randomUUID();expect(await claimBookAnalysisRun(f.bookRun.id,newToken,0)).toBe(true);
 release.resolve();await rejection;expect((await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).status).toBe("RUNNING");expect((await prisma.bookAnalysisRun.findUniqueOrThrow({where:{id:f.bookRun.id}})).executionClaimToken).toBe(newToken);
 await expect(f.adapter.execute({...f.input,request:{...f.input.request,bookExecution:{...f.context,claimToken:newToken}}})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});expect(f.wire).toHaveBeenCalledTimes(1);
});

it("rejects a lease that expires while the business transaction waits for its row lock",async()=>{
 const f=await fixture();await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 await prisma.$executeRaw`UPDATE "BookAnalysisRun" SET "executionLeaseUntil"=clock_timestamp()+INTERVAL '300 milliseconds' WHERE "id"=${f.bookRun.id}`;
 const locked=barrier(),release=barrier();let pid=0;
 const blocker=prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT "id" FROM "BookAnalysisRun" WHERE "id"=${f.bookRun.id} FOR UPDATE`;const rows=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;pid=rows[0]!.pid;locked.resolve();await release.promise;},{timeout:10000});
 await locked.promise;let wrote=false;
 const work=withOwnedAnalysisTransaction(f.bookRun.id,f.context.claimToken,async()=>{wrote=true;});const outcome=work.then(()=>null,error=>error);
 try{let observed=false;for(let i=0;i<100;i++){const rows=await prisma.$queryRaw<Array<{blocked:boolean}>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))) AS blocked`;if(rows[0]!.blocked){observed=true;break;}await new Promise(r=>setTimeout(r,5));}expect(observed).toBe(true);await prisma.$queryRaw`SELECT pg_sleep(0.35)::text`;}finally{release.resolve();await blocker;}
 expect(await outcome).toMatchObject({message:"BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST"});expect(wrote).toBe(false);
});

async function minimaxFixture(budget=80000,batch=false,budgetOnly=false){
 const f=await fixture(budget),text="Bounded MiniMax canary source.";
 f.wire.mockImplementation(async()=>({status:200,headers:{},body:JSON.stringify({model:"MiniMax-M3",choices:[{message:{content:'{"summary":"ok"}'},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:10}})}));
 const block=await prisma.sourceBlock.create({data:{extractionId:f.bookRun.extractionId,ordinal:0,kind:"PARAGRAPH",text,contentHash:crypto.randomUUID()}});
 const chunk=await prisma.documentChunk.create({data:{workspaceId:f.w.id,chunkSetId:f.bookRun.chunkSetId,extractionId:f.bookRun.extractionId,structureVersion:"fixture",ordinal:batch?28:0,content:text,contentHash:crypto.randomUUID(),characterCount:text.length,tokenEstimate:10}});
 await prisma.chunkSourceSpan.create({data:{chunkId:chunk.id,sourceBlockId:block.id,extractionId:f.bookRun.extractionId,ordinal:0,startOffset:0,endOffset:text.length}});
 const p=batch?{...f.payload,providerPolicy:budgetOnly?"MINIMAX_M3_CN_CHUNK_BUDGET_V1":"MINIMAX_M3_CN_CHUNK_BATCH_V1",firstChunkOrdinal:28,lastChunkOrdinal:140,maxTextCalls:113,maxEmbeddingCalls:0}:{...f.payload,providerPolicy:"MINIMAX_M3_CN_CHUNK_CANARY_V1",canaryChunkId:chunk.id,maxTextCalls:1,maxEmbeddingCalls:0};await prisma.job.update({where:{id:f.grant.id},data:{payload:p}});
 const resolver=createBookPaidResolver(f.grant.id,{execute:f.wire,executeBinary:vi.fn()}),adapter=resolver({providerKey:"minimax",protocol:"OPENAI_COMPATIBLE",family:"TEXT_GENERATION",modelId:"MiniMax-M3"})!;
 const input={...f.input,snapshot:{...f.input.snapshot,providerKey:"minimax",modelId:"MiniMax-M3",endpoint:budgetOnly?"https://api.minimax.cn/v1/chat/completions":"https://api.minimax.cn/v1/text/chatcompletion_v2"},request:{...f.input.request,idempotencyKey:`book-analysis-text:${f.bookRun.id}:${f.bookJob.id}:CHUNK:chunk:${chunk.id}:${chunk.contentHash}`,text:{messages:[{role:"user"as const,content:JSON.stringify({sourceEvidence:[{sourceBlockId:block.id,startOffset:0,endOffset:text.length,text}]})}],structuredOutput:{mode:"JSON_MODE"as const}}}};
 await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});return{...f,adapter,input,chunk,block};
}
it("reserves MiniMax standard rates and allows just one explicitly bound chunk call",async()=>{
 const f=await minimaxFixture();await f.adapter.execute(f.input);const body=JSON.parse((f.wire.mock.calls[0] as unknown as [{body:string}])[0].body);expect(body).toMatchObject({model:"MiniMax-M3",max_completion_tokens:4000,stream:false});expect(body.thinking).toBeUndefined();expect(body.response_format).toBeUndefined();
 const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(p.reservedMicroCny).toBe(Math.ceil(p.entries[0]!.inputUpper*2.1+4000*8.4));await expect(f.adapter.execute(f.input)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});expect(f.wire).toHaveBeenCalledTimes(1);
});
it.each(["budget","other-chunk","wrong-source","other-model","wrong-host"])("denies MiniMax %s before any external call",async kind=>{
 const f=await minimaxFixture(kind==="budget"?1:80000);let input=f.input;
 if(kind==="other-chunk")input={...input,request:{...input.request,idempotencyKey:`book-analysis-text:${f.bookRun.id}:${f.bookJob.id}:CHUNK:chunk:foreign:hash`}};
 if(kind==="wrong-source")input={...input,request:{...input.request,text:{...input.request.text,messages:[{role:"user",content:'{"sourceEvidence":[]}' }]}}};
 if(kind==="other-model")input={...input,snapshot:{...input.snapshot,modelId:"MiniMax-M3.1-Flash"}};
 if(kind==="wrong-host")input={...input,snapshot:{...input.snapshot,endpoint:"https://api.minimax.io/v1/text/chatcompletion_v2"}};
 await expect(f.adapter.execute(input)).rejects.toThrow();expect(f.wire).not.toHaveBeenCalled();
});

it("uses bounded reported no-cache cost for batch exposure while retaining gross reservations",async()=>{
 const f=await minimaxFixture(50000,true);await f.adapter.execute(f.input);
 const next=await prisma.documentChunk.create({data:{workspaceId:f.w.id,chunkSetId:f.bookRun.chunkSetId,extractionId:f.bookRun.extractionId,structureVersion:"fixture",ordinal:29,content:f.chunk.content,contentHash:crypto.randomUUID(),characterCount:f.chunk.content.length,tokenEstimate:10}});
 await prisma.chunkSourceSpan.create({data:{chunkId:next.id,sourceBlockId:f.block.id,extractionId:f.bookRun.extractionId,ordinal:0,startOffset:0,endOffset:f.chunk.content.length}});
 await f.adapter.execute({...f.input,request:{...f.input.request,idempotencyKey:`book-analysis-text:${f.bookRun.id}:${f.bookJob.id}:CHUNK:chunk:${next.id}:${next.contentHash}`}});
 const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(p.entries).toHaveLength(2);expect(p.reservedMicroCny).toBeGreaterThan(p.maxMicroCny);expect(bookPaidExposureMicroCny(p)).toBe(210);expect(f.wire).toHaveBeenCalledTimes(2);
});
it.each(["unknown","truncated"])("keeps full batch reservation for %s usage outcomes",async kind=>{
 const f=await minimaxFixture(50000,true);if(kind==="unknown")f.wire.mockRejectedValueOnce(new Error("NETWORK_UNKNOWN"));else f.wire.mockResolvedValueOnce({status:200,headers:{},body:JSON.stringify({choices:[{message:{content:'{"summary":'},finish_reason:"length"}],usage:{prompt_tokens:10,completion_tokens:10}})});
 await expect(f.adapter.execute(f.input)).rejects.toThrow();const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(bookPaidExposureMicroCny(p)).toBe(p.reservedMicroCny);expect(f.wire).toHaveBeenCalledTimes(1);
});
it.each(["old-range","bad-hash","budget"])("rejects batch %s without external calls",async kind=>{
 const f=await minimaxFixture(kind==="budget"?1:50000,true);let input=f.input;if(kind==="old-range")await prisma.documentChunk.update({where:{id:f.chunk.id},data:{ordinal:27}});if(kind==="bad-hash")input={...input,request:{...input.request,idempotencyKey:input.request.idempotencyKey.replace(f.chunk.contentHash,"wronghash")}};
 await expect(f.adapter.execute(input)).rejects.toThrow();expect(f.wire).not.toHaveBeenCalled();
});

it("removes the fixed output ceiling but never exceeds the remaining CNY grant",async()=>{
 const f=await minimaxFixture(4000000,true,true);await f.adapter.execute(f.input);const body=JSON.parse((f.wire.mock.calls[0] as unknown as [{body:string}])[0].body);expect(body.max_completion_tokens).toBeGreaterThan(131072);expect(body.max_completion_tokens).toBeLessThanOrEqual(524288);expect(body.reasoning_split).toBe(true);
 const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(p.reservedMicroCny).toBeLessThanOrEqual(4000000);expect(p.entries[0]!.outputMax).toBe(body.max_completion_tokens);expect(bookPaidExposureMicroCny(p)).toBe(105);
});
it("retains the complete money-backed reservation when an uncapped request has unknown outcome",async()=>{
 const f=await minimaxFixture(4000000,true,true);f.wire.mockRejectedValueOnce(new Error("REMOTE_UNKNOWN"));await expect(f.adapter.execute(f.input)).rejects.toThrow();const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(bookPaidExposureMicroCny(p)).toBe(p.reservedMicroCny);expect(p.reservedMicroCny).toBeLessThanOrEqual(4000000);expect(f.wire).toHaveBeenCalledTimes(1);
});
it("denies an exhausted money-backed grant before sending",async()=>{
 const f=await minimaxFixture(1,true,true);await expect(f.adapter.execute(f.input)).rejects.toMatchObject({code:"BUDGET_EXCEEDED"});expect(f.wire).not.toHaveBeenCalled();
});

it.each(["expanded", "too-large", "legacy"])("bounds citation metadata input under money-backed policy: %s",async mode=>{
 const f=await minimaxFixture(4000000,true,mode!=="legacy");const input={...f.input,request:{...f.input.request,text:{...f.input.request.text,system:"x".repeat(mode==="too-large"?33000:17000)}}};
 if(mode==="expanded"){await f.adapter.execute(input);const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(p.entries[0]!.inputUpper).toBeGreaterThan(16384);expect(p.entries[0]!.inputUpper).toBeLessThanOrEqual(32768);expect(p.reservedMicroCny).toBeLessThanOrEqual(p.maxMicroCny);expect(f.wire).toHaveBeenCalledTimes(1);}else{await expect(f.adapter.execute(input)).rejects.toMatchObject({code:"CONTEXT_LIMIT_EXCEEDED"});expect(f.wire).not.toHaveBeenCalled();}
});

it("binds supplied local span references to the real source ordinal before billing",async()=>{
 const f=await minimaxFixture(100000,true,true),message=f.input.request.text.messages[0]!,payload=JSON.parse(message.content);payload.sourceEvidence[0].spanIndex=1;
 const input={...f.input,request:{...f.input.request,text:{...f.input.request.text,messages:[{...message,content:JSON.stringify(payload)}]}}};
 await expect(f.adapter.execute(input)).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});expect(f.wire).not.toHaveBeenCalled();
});

it.each(["stop","length"])("accounts supplier-reported tokens even when generated JSON is invalid (%s), without accepting or repairing the result",async finish_reason=>{
 const f=await minimaxFixture(100000,true,true);f.wire.mockResolvedValueOnce({status:200,headers:{},body:JSON.stringify({model:"MiniMax-M3",base_resp:{status_code:0},choices:[{finish_reason,message:{content:'{"summary":'}}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})});
 await expect(f.adapter.execute(f.input)).rejects.toThrow();const p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(p.entries[0]).toMatchObject({reportedInputTokens:10,reportedOutputTokens:10});expect(bookPaidExposureMicroCny(p)).toBe(105);expect(p.reservedMicroCny).toBeGreaterThan(105);expect(f.wire).toHaveBeenCalledTimes(1);
});
it.each(["wrong-model","business-error","wrong-total","over-input","over-output","missing-usage"])("retains full reservation for unverified supplier usage: %s",async fault=>{
 const f=await minimaxFixture(100000,true,true);const p:{model:string;base_resp:{status_code:number};choices:Array<{finish_reason:string;message:{content:string}}>;usage?:{prompt_tokens:number;completion_tokens:number;total_tokens:number}}={model:"MiniMax-M3",base_resp:{status_code:0},choices:[{finish_reason:"stop",message:{content:'{"summary":'}}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}};
 if(fault==="wrong-model")p.model="other";if(fault==="business-error")p.base_resp.status_code=1004;if(fault==="wrong-total")p.usage!.total_tokens=21;if(fault==="over-input")p.usage!.prompt_tokens=999999;if(fault==="over-output")p.usage!.completion_tokens=999999;if(fault==="missing-usage")delete p.usage;
 f.wire.mockResolvedValueOnce({status:200,headers:{},body:JSON.stringify(p)});await expect(f.adapter.execute(f.input)).rejects.toThrow();const g=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;expect(bookPaidExposureMicroCny(g)).toBe(g.reservedMicroCny);
});

it.each([72,73])("honors the explicitly increased cumulative 75-call allowance, remaining %s",async remaining=>{const f=await mergeContinuationFixture(),p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;await prisma.job.update({where:{id:f.grant.id},data:{payload:{...p,maxTextCalls:remaining,mergeContinuation:{...p.mergeContinuation!,cumulativeTextLimit:75,priorStageCounts:{SECTION:3,CHAPTER:0,BOOK:0,EMBEDDINGS:0}}} as never}});if(remaining===72){await f.adapter.execute(f.input);expect(f.wire).toHaveBeenCalledTimes(1);}else{await expect(f.adapter.execute(f.input)).rejects.toThrow();expect(f.wire).not.toHaveBeenCalled();}});

it.each([4,5])("retains a bounded BOOK recovery allowance, prior %s",async prior=>{const f=await mergeContinuationFixture(),p=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;await prisma.job.update({where:{id:f.grant.id},data:{payload:{...p,maxTextCalls:70,mergeContinuation:{...p.mergeContinuation!,cumulativeTextLimit:75,priorStageCounts:{SECTION:0,CHAPTER:0,BOOK:prior,EMBEDDINGS:0}}} as never}});await prisma.bookAnalysisRun.update({where:{id:f.bookRun.id},data:{analysisStage:"BOOK_SYNTHESIS"}});const input={...f.input,snapshot:{...f.input.snapshot,routeSlot:"BOOK_SYNTHESIS"},request:{...f.input.request,idempotencyKey: f.input.request.idempotencyKey.replace(":SECTION:",":BOOK:")}} as typeof f.input;if(prior===4){await f.adapter.execute(input);expect(f.wire).toHaveBeenCalledTimes(1);}else{await expect(f.adapter.execute(input)).rejects.toThrow();expect(f.wire).not.toHaveBeenCalled();}});
