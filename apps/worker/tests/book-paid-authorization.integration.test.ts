import { claimBookAnalysisRun, withOwnedAnalysisTransaction } from "@ai-cognitive/book-intelligence";
import { afterEach, expect, it, vi } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { stableHash } from "@ai-cognitive/provider-gateway";
import { BOOK_CUMULATIVE_CNY_CAP_MICRO } from "../src/book-cumulative-budget.js";
import { activateBookPaidGrant, bindBookPaidGrant, cancelBookPaidGrant, BOOK_PAID_GRANT_TYPE, createBookPaidResolver, type BookPaidGrant } from "../src/book-paid-authorization.js";
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

async function withPrior(f: Awaited<ReturnType<typeof fixture>>, reservedMicroCny: number, status: "FAILED" | "SUCCEEDED" | "CANCELLED" = "FAILED") {
 const { binding: _binding, cumulativeBudget: _budget, ...original } = f.payload as BookPaidGrant & {binding?:unknown};
 void _binding; void _budget;
 const entry = { ordinal:1, kind:"TEXT" as const, reservedMicroCny, inputUpper:100, outputMax:10, state:"REMOTE_OUTCOME_UNKNOWN", operationKey:crypto.randomUUID() };
 const old = await prisma.job.create({data:{workspaceId:f.w.id,userId:f.u.id,type:BOOK_PAID_GRANT_TYPE,status,payload:{...original,reservedMicroCny,textCalls:1,entries:[entry],stopped:true} as never}});
 const persisted = await prisma.job.findUniqueOrThrow({where:{id:old.id}});
 const carried = {grantId:old.id,payloadDigest:stableHash(persisted.payload),reservedMicroCny};
 return {old,carried};
}
function cumulative(carried: {grantId:string;payloadDigest:string;reservedMicroCny:number}[]) {
 return {version:1 as const,limitMicroCny:BOOK_CUMULATIVE_CNY_CAP_MICRO,carryForward:carried};
}
it("pins all terminated prior gross reservations into an exact 10 CNY continuation envelope",async()=>{
 const f=await fixture(5_000_000),prior=await withPrior(f,788_499);
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,cumulativeBudget:cumulative([prior.carried])} as never}});
 await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 await f.adapter.execute(f.input);
 expect(f.wire).toHaveBeenCalledTimes(1);
 const payload=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;
 expect(payload.cumulativeBudget?.carryForward).toEqual([prior.carried]);
 expect(payload.reservedMicroCny).toBeGreaterThan(0);
 expect(payload.cumulativeBudget!.limitMicroCny).toBe(10_000_000);
});
it("allows the exactly remaining 9.211501 CNY only with explicit pinned historic 10 CNY authorization",async()=>{
 const f=await fixture(),prior=await withPrior(f,788_499);
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,maxMicroCny:9_211_501,cumulativeBudget:cumulative([prior.carried])} as never}});
 await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 await f.adapter.execute(f.input);
 expect(f.wire).toHaveBeenCalledTimes(1);
 const grant=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;
 expect(prior.carried.reservedMicroCny+grant.maxMicroCny).toBe(BOOK_CUMULATIVE_CNY_CAP_MICRO);
 expect(grant.entries).toHaveLength(1);
});
it("does not increase the legacy per-grant 5 CNY limit without the cumulative ledger",async()=>{
 const f=await fixture();
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,maxMicroCny:5_000_001} as never}});
 await expect(activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id})).rejects.toThrow("BOOK_PAID_GRANT_INVALID");
 expect(f.wire).not.toHaveBeenCalled();
});
it("blocks even one micro-CNY above the exact remaining continuation envelope",async()=>{
 const f=await fixture(),prior=await withPrior(f,788_499);
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,maxMicroCny:9_211_502,cumulativeBudget:cumulative([prior.carried])} as never}});
 await expect(activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id})).rejects.toThrow("BOOK_PAID_CUMULATIVE_BUDGET_INVALID");
 expect(f.wire).not.toHaveBeenCalled();
});
it("denies activation when prior gross plus new maximum exceeds 10 CNY",async()=>{
 const f=await fixture(5_000_000),prior=await withPrior(f,5_000_001);
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,cumulativeBudget:cumulative([prior.carried])} as never}});
 await expect(activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id})).rejects.toThrow("BOOK_PAID_CUMULATIVE_BUDGET_INVALID");
 expect(f.wire).not.toHaveBeenCalled();
});
it.each(["omitted","tampered","running","foreign","different-extraction"] as const)(
 "refuses %s historical fee evidence without sending",async kind=>{
 const f=await fixture(),prior=await withPrior(f,788_499);
 const envelope=cumulative(kind==="omitted"?[]:[prior.carried]);
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,cumulativeBudget:envelope} as never}});
 if(kind==="tampered")await prisma.job.update({where:{id:prior.old.id},data:{payload:{...(await prisma.job.findUniqueOrThrow({where:{id:prior.old.id}})).payload as object,stopped:false}}});
 if(kind==="running")await prisma.job.update({where:{id:prior.old.id},data:{status:"RUNNING"}});
 if(kind==="foreign")await prisma.job.update({where:{id:prior.old.id},data:{userId:crypto.randomUUID()}});
 if(kind==="different-extraction")await prisma.job.update({where:{id:prior.old.id},data:{payload:{...(await prisma.job.findUniqueOrThrow({where:{id:prior.old.id}})).payload as object,extractionId:crypto.randomUUID()}}});
 await expect(activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id})).rejects.toThrow();
 expect(f.wire).not.toHaveBeenCalled();
});
it("blocks an unlisted peer grant for the same source/extraction, even if no tokens were spent",async()=>{
 const f=await fixture(),prior=await withPrior(f,788_499),other=await withPrior(f,0);
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,cumulativeBudget:cumulative([prior.carried])} as never}});
 await expect(activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id})).rejects.toThrow("AUTHORIZATION_FAILED");
 expect(other.old.id).not.toBe(prior.old.id);expect(f.wire).not.toHaveBeenCalled();
});
it("rechecks immutable previous grants after reservation and refuses network send if the history changes",async()=>{
 const f=await fixture(),prior=await withPrior(f,788_499);
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,cumulativeBudget:cumulative([prior.carried])} as never}});
 await activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id});
 const resolver=createBookPaidResolver(f.grant.id,{execute:f.wire,executeBinary:vi.fn()},{beforeSendAdmission:async()=>{
  const old=await prisma.job.findUniqueOrThrow({where:{id:prior.old.id}});
  await prisma.job.update({where:{id:old.id},data:{payload:{...(old.payload as object),stopped:false}}});
 }});
 const adapter=resolver({providerKey:"zhipu",protocol:"OPENAI_COMPATIBLE",family:"TEXT_GENERATION",modelId:"glm-5.3-flash"})!;
 await expect(adapter.execute(f.input)).rejects.toMatchObject({code:"AUTHORIZATION_FAILED"});
 expect(f.wire).not.toHaveBeenCalled();
 const grant=(await prisma.job.findUniqueOrThrow({where:{id:f.grant.id}})).payload as unknown as BookPaidGrant;
 expect(grant.entries).toHaveLength(1);expect(grant.entries[0]?.reservedMicroCny).toBeGreaterThan(0);
});

it("refuses a legacy unpinned grant once a cumulative continuation for the same document exists",async()=>{
 const f=await fixture();
 const other=await prisma.job.create({data:{workspaceId:f.w.id,userId:f.u.id,type:BOOK_PAID_GRANT_TYPE,status:"FAILED",payload:{...f.payload,cumulativeBudget:cumulative([])} as never}});
 expect(other.id).not.toBe(f.grant.id);
 await expect(activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id})).rejects.toThrow("AUTHORIZATION_FAILED");
 expect(f.wire).not.toHaveBeenCalled();
});
it("refuses a re-pinned historic receipt with a nonexistent extraction even if its hash matches",async()=>{
 const f=await fixture(),historical=await withPrior(f,788_499);
 const old=await prisma.job.findUniqueOrThrow({where:{id:historical.old.id}});
 const changed={...(old.payload as object),extractionId:crypto.randomUUID()};
 await prisma.job.update({where:{id:old.id},data:{payload:changed as never}});
 await prisma.job.update({where:{id:f.grant.id},data:{payload:{...f.payload,cumulativeBudget:cumulative([{grantId:old.id,payloadDigest:stableHash(changed),reservedMicroCny:788_499}])} as never}});
 await expect(activateBookPaidGrant(f.grant.id,{workspaceId:f.w.id,userId:f.u.id})).rejects.toThrow("AUTHORIZATION_FAILED");
 expect(f.wire).not.toHaveBeenCalled();
});
