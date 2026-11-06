import { bindBookPaidGrant, activateBookPaidGrant, cancelBookPaidGrant, BOOK_PAID_GRANT_TYPE } from "../src/book-paid-authorization.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { DeterministicProviderHttpTransport, ProviderGatewayError, ProviderGatewayRepository, createProviderAdapterResolver, parseKeyring, stableHash, type GatewayRequest } from "@ai-cognitive/provider-gateway";
import { materializeChunkSet, processBookAnalysisRun, requestBookAnalysisForUser } from "@ai-cognitive/book-intelligence";
import { createBookProductionGatewayRuntime } from "../src/provider-gateway-runtime.js";
import { startWorkerRuntime } from "../src/runtime.js";

const keyring = JSON.stringify({ activeVersion: "v1", keys: { v1: Buffer.alloc(32, 7).toString("base64") } });
const manifest = JSON.stringify({ providers: [{ providerKey: "fixture", displayName: "Fixture", protocol: "TEST", adapterVersion: "test", models: [{ modelId: "fixture-model", families: ["TEXT_GENERATION", "EMBEDDING"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA", embeddingDimensions: 3, maxEmbeddingInputs: 10, embeddingPurposes: ["DOCUMENT"] }] }] });
const source = { REDIS_URL: "redis://127.0.0.1:6379", NODE_ENV: "test", PROVIDER_GATEWAY_KEYRING: keyring, PROVIDER_GATEWAY_MODEL_MANIFEST: manifest };
const textSchema = { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" } } };
const owned: Array<{ workspaceId: string; userId: string }> = [];
const controls = { circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async (key: string) => ({ key, token: "test" }), release: async () => true }, validateEndpoint: async () => undefined };
function runtime(calls: { text: number; embedding: number }) {
  return createBookProductionGatewayRuntime(source, {
    ...controls,
    adapterResolver: input => ({ execute: async ({ request }) => {
      if (input.family === "EMBEDDING") {
        calls.embedding++;
        return { response: { vectors: request.embedding!.texts.map(() => [1, 0, 0]), dimensions: 3 } };
      }
      calls.text++;
      return { response: { type: "STRUCTURED", structured: { summary: "durable summary", memory: [{ type: "SUMMARY", content: "durable memory" }] } }, usage: { inputTokens: 1, outputTokens: 1 } };
    } }),
  });
}
async function fixture() { const user = await prisma.user.create({ data: { email: `${randomUUID()}@phase8c.test` } }), ws = await prisma.workspace.create({ data: { name: randomUUID() } }); owned.push({ workspaceId: ws.id, userId: user.id }); await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: "OWNER" } }); return { workspaceId: ws.id, userId: user.id }; }
async function routes(f: { workspaceId: string; userId: string }, slots = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING"], configuration = { providerKey: "fixture", protocol: "TEST", displayName: "fixture", modelId: "fixture-model", embeddingModelId: "fixture-model", embeddingDimensions: 3 }) { const store = new ProviderGatewayRepository(prisma, parseKeyring(keyring)!); const connection = await store.createConnection(f, { providerKey: configuration.providerKey, protocol: configuration.protocol, displayName: configuration.displayName }); await store.rotateCredential(f, connection.id, "fixture-secret"); for (const routeSlot of slots) await store.setRoute(f, { routeSlot, connectionId: connection.id, modelId: routeSlot === "EMBEDDING" ? configuration.embeddingModelId : configuration.modelId, configuration: routeSlot === "EMBEDDING" ? { embeddingDimensions: configuration.embeddingDimensions } : {} }); return { store, connection }; }
async function durableRoutePlan(workspaceId: string) { const routes = await prisma.providerRouteBinding.findMany({ where: { workspaceId, routeSlot: { in: ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING"] } }, include: { connection: { include: { credentialVersions: { where: { status: "ACTIVE" }, orderBy: { credentialVersion: "desc" }, take: 1 } } } } }); const endpoint = (provider: string, slot: string, configuration: Record<string, unknown>) => provider === "openai" ? slot === "EMBEDDING" ? "https://api.openai.com/v1/embeddings" : "https://api.openai.com/v1/responses" : provider === "minimax" ? "https://api.minimax.io/v1/text/chatcompletion_v2" : provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : provider === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : provider === "qwen" ? `https://${String(configuration.qwenWorkspaceId)}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions` : "https://fixture.example.test/v1"; const adapterVersion = (provider: string) => provider === "fixture" ? "test" : provider === "gemini" || provider === "deepseek" ? "builtin-v2" : "builtin-v1"; const entries = Object.fromEntries(routes.map(route => [route.routeSlot, { providerKey: route.connection.providerKey, protocol: route.connection.protocol, modelId: route.modelId, configuration: route.configuration as Record<string, unknown>, configurationHash: stableHash(route.configuration), ...(route.routeSlot === "EMBEDDING" ? { dimensions: Number((route.configuration as { embeddingDimensions?: number }).embeddingDimensions ?? 3) } : { structuredOutput: route.connection.providerKey === "minimax" || route.connection.providerKey === "deepseek" ? "JSON_MODE" : "STRICT_JSON_SCHEMA" }), connectionId: route.connectionId, credentialVersionId: route.connection.credentialVersions[0]!.id, endpoint: endpoint(route.connection.providerKey, route.routeSlot, route.configuration as Record<string, unknown>), adapterVersion: adapterVersion(route.connection.providerKey) }])); return { version: 1 as const, routes: entries } as import("@ai-cognitive/book-intelligence").BookAnalysisRoutePlan; }
function request(workspaceId: string, routeSlot: GatewayRequest["routeSlot"], id: string, embedding = false): GatewayRequest { return { workspaceId, routeSlot, correlationId: id, idempotencyKey: id, inputHash: "a".repeat(64), capability: embedding ? { family: "EMBEDDING" } : { family: "TEXT_GENERATION", structuredOutput: "STRICT_JSON_SCHEMA" }, ...(embedding ? { embedding: { texts: ["one"], purpose: "DOCUMENT" } } : { text: { system: "test", messages: [{ role: "user", content: "one" }], structuredOutput: { mode: "STRICT_JSON_SCHEMA", schemaName: "response", schema: textSchema } } }) }; }
async function bookLineage(f: { workspaceId: string; userId: string }, multipleChapters = false, paragraphCount = 0) { const sourceRow = await prisma.source.create({ data: { workspaceId: f.workspaceId, kind: "FILE", displayName: "book.md" } }), blob = await prisma.sourceBlob.create({ data: { workspaceId: f.workspaceId, sha256: randomUUID(), sizeBytes: 1, mediaType: "text/markdown", storageKey: `phase8c/${randomUUID()}` } }), document = await prisma.sourceDocument.create({ data: { workspaceId: f.workspaceId, sourceId: sourceRow.id, sourceBlobId: blob.id, version: 1, sha256: randomUUID(), sizeBytes: 1, mediaType: "text/markdown", storageKey: blob.storageKey } }), job = await prisma.job.create({ data: { workspaceId: f.workspaceId, userId: f.userId, type: "source.ingest", payload: {}, idempotencyKey: `ingest:${randomUUID()}` } }), ingestion = await prisma.ingestionRun.create({ data: { workspaceId: f.workspaceId, sourceDocumentId: document.id, jobId: job.id, parserVersion: "test", normalizationVersion: "test" } }), extraction = await prisma.documentExtraction.create({ data: { workspaceId: f.workspaceId, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } }); const blocks = paragraphCount ? Array.from({length:paragraphCount},(_,i)=>`Fact ${String(i).padStart(3,"0")}: a bounded historical observation with its original evidence.`) : multipleChapters ? ["# Chapter One", "## Section One", "First sufficiently long durable paragraph for the first chapter.", "Second sufficiently long durable paragraph for the first chapter.", "# Chapter Two", "## Section Two", "First sufficiently long durable paragraph for the second chapter.", "Second sufficiently long durable paragraph for the second chapter."] : ["# Chapter", "## Section", "First sufficiently long durable paragraph for the first chunk.", "Second sufficiently long durable paragraph for the second chunk."]; for (const [ordinal, text] of blocks.entries()) { const heading = text.startsWith("#"); await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal, kind: heading ? "HEADING" : "PARAGRAPH", text, contentHash: randomUUID(), metadata: heading ? { level: text.startsWith("##") ? 2 : 1 } : {} } }); } await prisma.currentDocumentExtraction.create({ data: { workspaceId: f.workspaceId, sourceDocumentId: document.id, extractionId: extraction.id } }); await materializeChunkSet({ workspaceId: f.workspaceId, sourceDocumentId: document.id, configuration: { targetSize: 40, hardMax: 80 } }); return document; }
async function waitForRun(id: string) { for (let i = 0; i < 50; i++) { const run = await prisma.bookAnalysisRun.findUniqueOrThrow({ where: { id } }); if (run.status === "SUCCEEDED" || run.status === "FAILED") return run; await new Promise(resolve => setTimeout(resolve, 200)); } throw new Error("BOOK_WORKER_TIMEOUT"); }
afterEach(async () => { for (const f of owned.splice(0)) { await prisma.currentBookIntelligence.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.providerTextResult.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.providerEmbeddingResult.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.providerUsageEvent.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.providerInvocation.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.providerRouteBinding.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.providerCredentialVersion.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.providerConnection.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.bookAnalysisRun.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.chunkSet.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.documentExtraction.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.ingestionRun.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.job.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.sourceDocument.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.source.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.sourceBlob.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.workspaceMember.deleteMany({ where: { workspaceId: f.workspaceId } }); await prisma.workspace.delete({ where: { id: f.workspaceId } }); await prisma.user.delete({ where: { id: f.userId } }); } });

describe("Phase 8C Checkpoint 3B production gateway composition", () => {
  it("M3 长输出请求在远端执行前延长当前拥有者业务租约并保留 Token 预算",async()=>{
    const f=await fixture(),document=await bookLineage(f);
    await routes(f,undefined,{providerKey:"minimax",protocol:"TEST",displayName:"M3 fixture",modelId:"MiniMax-M3",embeddingModelId:"MiniMax-M3",embeddingDimensions:3});
    const definition=JSON.parse(manifest);definition.providers[0].providerKey="minimax";definition.providers[0].adapterVersion="builtin-v1";definition.providers[0].models[0].modelId="MiniMax-M3";definition.providers[0].models[0].structuredOutput="JSON_MODE";
    const requested=await requestBookAnalysisForUser(f,{sourceDocumentId:document.id,pipelineVersion:"m3-lease-test",promptVersion:"v1",provider:"minimax",model:"MiniMax-M3",routePlan:await durableRoutePlan(f.workspaceId)});
    let calls=0;const r=createBookProductionGatewayRuntime({...source,PROVIDER_GATEWAY_MODEL_MANIFEST:JSON.stringify(definition)},{...controls,adapterResolver:()=>({execute:async({request:value})=>{calls++;const run=await prisma.bookAnalysisRun.findUniqueOrThrow({where:{id:requested.run.id}});expect(run.executionLeaseUntil!.getTime()-Date.now()).toBeGreaterThan(600_000);expect(value.text!.generation!.maxOutputTokens).toBe(32_000);expect(value.text!.generation).not.toHaveProperty("thinking");expect(value.bookExecution).toMatchObject({analysisRunId:requested.run.id,jobId:requested.job.id});throw new ProviderGatewayError("QUOTA_EXCEEDED");}})});
    try{await expect(processBookAnalysisRun(requested.run.id,{analysisProviderForRun:input=>r.createAnalysisProvider(input),embeddingGateway:{gateway:r.gateway,repository:r.repository,userId:f.userId}})).rejects.toMatchObject({code:"QUOTA_EXCEEDED"});expect(calls).toBe(1);}finally{await r.close();}
  });
  it.each(["cancelled","expired","lost-owner"])("retains the encrypted remote receipt but rejects materialization when %s", async mode => {
    const f=await fixture(),document=await bookLineage(f);await routes(f);
    const requested=await requestBookAnalysisForUser(f,{sourceDocumentId:document.id,pipelineVersion:"cancel-receipt",promptVersion:"v1",provider:"fixture",model:"fixture-model"});
    const grant=await prisma.job.create({data:{workspaceId:f.workspaceId,userId:f.userId,type:BOOK_PAID_GRANT_TYPE,payload:{version:1,sourceDocumentId:document.id,extractionId:requested.run.extractionId,sha256:document.sha256,bootstrapId:"fixture",expiresAt:new Date(Date.now()+120000).toISOString(),credentialIds:["fixture"],maxMicroCny:5000000,reservedMicroCny:0,textCalls:0,embeddingCalls:0,entries:[]}}});
    await bindBookPaidGrant(grant.id,requested.run.id,f);await activateBookPaidGrant(grant.id,f);
    const r=runtime({text:0,embedding:0});
    try{
      await expect(processBookAnalysisRun(requested.run.id,{analysisProviderForRun:async input=>{
        const provider=await r.createAnalysisProvider(input);
        return{generateStructured:async req=>{const response=await provider.generateStructured(req);if(mode==="cancelled")await cancelBookPaidGrant(grant.id,f);else if(mode==="expired"){const current=await prisma.job.findUniqueOrThrow({where:{id:grant.id}});await prisma.job.update({where:{id:grant.id},data:{payload:{...(current.payload as object),expiresAt:new Date(0).toISOString()}}});}else await prisma.bookAnalysisRun.update({where:{id:requested.run.id},data:{executionClaimToken:crypto.randomUUID()}});return response;},consumeGenerated:(provider as import("@ai-cognitive/book-intelligence").DurableAnalysisProvider).consumeGenerated!.bind(provider)};
      },embeddingGatewayForRun:input=>({gateway:r.gateway,repository:r.repository,userId:input.userId})})).rejects.toThrow(/OWNERSHIP_LOST|BOOK_PAID_EXECUTION_DENIED/);
      expect(await prisma.analysisArtifact.count({where:{analysisRunId:requested.run.id}})).toBe(0);
      expect(await prisma.providerTextResult.count({where:{workspaceId:f.workspaceId,consumedAt:null,ciphertext:{not:null}}})).toBe(1);
      expect((await prisma.job.findUniqueOrThrow({where:{id:grant.id}})).status).toBe(mode==="cancelled"?"CANCELLED":mode==="expired"?"FAILED":"RUNNING");
      expect((await prisma.job.findUniqueOrThrow({where:{id:requested.job.id}})).status).toBe(mode==="cancelled"?"CANCELLED":mode==="expired"?"FAILED":"RUNNING");
      expect(await prisma.currentBookIntelligence.count({where:{analysisRunId:requested.run.id}})).toBe(0);
    }finally{await r.close();}
  });
  it("recovers 27 persisted chunks plus historical failed chunk 28, then survives lease takeover", async () => {
    const f=await fixture(), document=await bookLineage(f,false,141);await routes(f);
    const chunks=await prisma.documentChunk.findMany({where:{chunkSet:{sourceDocumentId:document.id}},orderBy:{ordinal:"asc"},include:{sourceSpans:{orderBy:{ordinal:"asc"}}}});
    expect(chunks).toHaveLength(141);
    const chunkOrdinal=new Map(chunks.map(c=>[c.id,c.ordinal]));
    let oldAttempt=true;let historical28: import("@ai-cognitive/provider-gateway").AdapterRequest|undefined;const generated:number[]=[];
    const r=createBookProductionGatewayRuntime(source,{...controls,maxAttempts:1,adapterResolver:input=>({execute:async({request:value})=>{
      expect(value.bookExecution).toMatchObject({workspaceId:f.workspaceId,userId:f.userId});
      if(input.family==="EMBEDDING")return{response:{vectors:value.embedding!.texts.map(()=>[1,0,0]),dimensions:3},usage:{inputTokens:1}};
      if(value.routeSlot==="BOOK_CHUNK_ANALYSIS"){
        const chunkId=/:CHUNK:chunk:([^:]+):/.exec(value.idempotencyKey)![1]!;const ordinal=chunkOrdinal.get(chunkId)!;generated.push(ordinal);
        if(oldAttempt&&ordinal===27){historical28=value;throw new ProviderGatewayError("CONTENT_REJECTED");}
      }
      return{response:{type:"STRUCTURED",structured:{summary:"bounded derived summary",memory:[{type:"SUMMARY",content:"bounded memory"}]}},usage:{inputTokens:10,outputTokens:5}};
    }})});
    const requested=await requestBookAnalysisForUser(f,{sourceDocumentId:document.id,pipelineVersion:"history-27-plus-1",promptVersion:"old-compatible",provider:"fixture",model:"fixture-model"});
    const dependencies={analysisProviderForRun:async(input:Parameters<typeof r.createAnalysisProvider>[0])=>{
      const provider=await r.createAnalysisProvider(input);
      if(!oldAttempt)return provider;
      return{generateStructured:(req:import("@ai-cognitive/book-intelligence").AnalysisRequest)=>provider.generateStructured({...req,content:JSON.stringify({content:req.content,sourceSlices:req.sourceSlices}),sourceSlices:undefined}),consumeGenerated:(provider as import("@ai-cognitive/book-intelligence").DurableAnalysisProvider).consumeGenerated!.bind(provider)};
    },embeddingGatewayForRun:(input:{userId:string})=>({gateway:r.gateway,repository:r.repository,userId:input.userId,maxEmbeddingInputs:10})};
    try{
      await expect(processBookAnalysisRun(requested.run.id,dependencies)).rejects.toMatchObject({code:"CONTENT_REJECTED"});
      const originalArtifacts=await prisma.analysisArtifact.findMany({where:{analysisRunId:requested.run.id,scope:"CHUNK"},orderBy:{ordinal:"asc"}});expect(originalArtifacts).toHaveLength(27);
      const digest=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex"),immutable=(rows:typeof originalArtifacts)=>rows.map(row=>({...row,parentId:null})),originalHash=digest(immutable(originalArtifacts)),oldJobId=requested.run.jobId;
      const oldInvocations=await prisma.providerInvocation.findMany({where:{workspaceId:f.workspaceId},orderBy:{id:"asc"}});
      const oldUsage=await prisma.providerUsageEvent.findMany({where:{workspaceId:f.workspaceId},orderBy:{id:"asc"}});
      expect(oldInvocations.filter(i=>i.status==="FAILED")).toHaveLength(1);
      const oldGrant=await prisma.job.create({data:{workspaceId:f.workspaceId,userId:f.userId,type:BOOK_PAID_GRANT_TYPE,status:"FAILED",attemptCount:1,payload:{version:1,sourceDocumentId:document.id,extractionId:requested.run.extractionId,reservedMicroCny:2800,textCalls:28,entries:Array.from({length:28},(_,ordinal)=>({ordinal:ordinal+1,reservedMicroCny:100,state:ordinal===27?"REMOTE_REJECTED":"RESPONSE_RECEIVED"}))}}});
      await expect(r.gateway.execute(historical28!,{userId:f.userId})).resolves.toMatchObject({status:"TERMINAL_FAILED"});
      await expect(r.gateway.execute({...historical28!,inputHash:"b".repeat(64),text:{...historical28!.text!,messages:[{role:"user",content:"new deduplicated envelope"}]}},{userId:f.userId})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
      const before=generated.length;await processBookAnalysisRun(requested.run.id,dependencies);expect(generated).toHaveLength(before);
      oldAttempt=false;
      const recover=()=>requestBookAnalysisForUser(f,{sourceDocumentId:document.id,chunkSetId:requested.run.chunkSetId,pipelineVersion:"history-27-plus-1",promptVersion:"old-compatible",provider:"fixture",model:"fixture-model"});
      const outcomes=await Promise.allSettled([recover(),recover()]);expect(outcomes.some(o=>o.status==="fulfilled")).toBe(true);
      const rearmed=await prisma.bookAnalysisRun.findUniqueOrThrow({where:{id:requested.run.id}});expect(rearmed.jobId).not.toBe(oldJobId);expect(rearmed.dispatchGeneration).toBe(1);
      const newGrant=await prisma.job.create({data:{workspaceId:f.workspaceId,userId:f.userId,type:BOOK_PAID_GRANT_TYPE,payload:{version:1,sourceDocumentId:document.id,extractionId:requested.run.extractionId,sha256:document.sha256,bootstrapId:"fixture-history",expiresAt:new Date(Date.now()+120000).toISOString(),credentialIds:["fixture"],maxMicroCny:5000000,reservedMicroCny:0,textCalls:0,embeddingCalls:0,entries:[]}}});
      await bindBookPaidGrant(newGrant.id,rearmed.id,f);await activateBookPaidGrant(newGrant.id,f);
      let paused!:()=>void,resume!:()=>void;const reached=new Promise<void>(r=>{paused=r;}),release=new Promise<void>(r=>{resume=r;});
      const obsolete=processBookAnalysisRun(requested.run.id,{...dependencies,faultInjector:async(point,meta)=>{if(point==="afterChunkPersist"&&meta.ordinal===27){paused();await release;}}},rearmed.dispatchGeneration);
      const oldOutcome=obsolete.then(()=>null,error=>error);
      await reached;
      expect(await prisma.analysisArtifact.count({where:{analysisRunId:requested.run.id,scope:"CHUNK"}})).toBe(28);
      await prisma.bookAnalysisRun.update({where:{id:requested.run.id},data:{executionLeaseUntil:new Date(Date.now()-1000)}});
      const recovered=await processBookAnalysisRun(requested.run.id,dependencies,rearmed.dispatchGeneration);
      resume();expect(await oldOutcome).toMatchObject({message:"BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST"});
      expect(recovered.status).toBe("SUCCEEDED");
      expect(await prisma.job.findUnique({where:{id:oldGrant.id}})).toEqual(oldGrant);
      expect((await prisma.job.findUniqueOrThrow({where:{id:newGrant.id}})).status).toBe("SUCCEEDED");await cancelBookPaidGrant(newGrant.id,f);expect((await prisma.job.findUniqueOrThrow({where:{id:newGrant.id}})).status).toBe("SUCCEEDED");
      const preserved=await prisma.analysisArtifact.findMany({where:{id:{in:originalArtifacts.map(a=>a.id)}},orderBy:{ordinal:"asc"}});
      expect(digest(immutable(preserved))).toBe(originalHash);
      for(const row of preserved){expect(row.parentId).not.toBeNull();expect(await prisma.analysisArtifact.findFirst({where:{id:row.parentId!,analysisRunId:requested.run.id,scope:{not:"CHUNK"}}})).toBeTruthy();}
      expect(await prisma.analysisArtifact.count({where:{analysisRunId:requested.run.id,scope:"CHUNK"}})).toBe(141);
      expect(generated.slice(before).filter(n=>n<27)).toEqual([]);expect(generated.filter(n=>n===27)).toHaveLength(2);
      expect(await prisma.providerInvocation.findMany({where:{id:{in:oldInvocations.map(i=>i.id)}},orderBy:{id:"asc"}})).toEqual(oldInvocations);
      expect(await prisma.providerUsageEvent.findMany({where:{id:{in:oldUsage.map(i=>i.id)}},orderBy:{id:"asc"}})).toEqual(oldUsage);
      expect((await prisma.job.findUniqueOrThrow({where:{id:oldJobId}})).status).toBe("FAILED");
      expect(await prisma.documentChunk.findMany({where:{id:{in:chunks.map(c=>c.id)}},orderBy:{ordinal:"asc"},include:{sourceSpans:{orderBy:{ordinal:"asc"}}}})).toEqual(chunks);
    }finally{await r.close();}
  },120000);
  it("keeps historical failed request identity separate from a new execution Job", async () => {
    const f = await fixture(); await routes(f); let calls = 0;
    const r = createBookProductionGatewayRuntime(source, { ...controls, maxAttempts: 1, adapterResolver: () => ({ execute: async () => {
      calls++; if (calls === 1) throw new ProviderGatewayError("CONTENT_REJECTED");
      return { response: { type: "STRUCTURED", structured: { summary: "new execution" } } };
    } }) });
    const old = request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "book-analysis-text:run:old-job:CHUNK:chunk-28");
    try {
      await expect(r.gateway.execute(old, { userId: f.userId })).rejects.toMatchObject({ code: "CONTENT_REJECTED" });
      await expect(r.gateway.execute(old, { userId: f.userId })).resolves.toMatchObject({ status: "TERMINAL_FAILED" });
      const changed = { ...old, inputHash: "b".repeat(64), text: { ...old.text!, messages: [{ role: "user" as const, content: "deduplicated source evidence" }] } };
      await expect(r.gateway.execute(changed, { userId: f.userId })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(calls).toBe(1);
      await expect(r.gateway.execute({ ...changed, idempotencyKey: "book-analysis-text:run:new-job:CHUNK:chunk-28" }, { userId: f.userId })).resolves.toMatchObject({ status: "SUCCEEDED" });
      expect(calls).toBe(2);
      expect(await prisma.providerInvocation.findFirst({ where: { workspaceId: f.workspaceId, idempotencyKey: old.idempotencyKey }, select: { status: true } })).toEqual({ status: "FAILED" });
    } finally { await r.close(); }
  });
  it("W01-W05 starts the real production worker and processes a pinned Book route plan", async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }, document = await bookLineage(f), isolation = randomUUID(), workerSource = { ...source, BOOK_ANALYSIS_PROVIDER: "fixture" }; await routes(f); const runtimeWorker = await startWorkerRuntime({ REDIS_URL: source.REDIS_URL } as never, { source: workerSource, bookProductionGatewayOverrides: { ...controls, adapterResolver: input => runtime(calls).gateway ? ({ execute: async ({ request }) => input.family === "EMBEDDING" ? (calls.embedding++, { response: { vectors: request.embedding!.texts.map(() => [1, 0, 0]), dimensions: 3 } }) : (calls.text++, { response: { type: "STRUCTURED", structured: { summary: "worker summary", memory: [{ type: "SUMMARY", content: "worker memory" }] } }, usage: { inputTokens: 1, outputTokens: 1 } }) }) : undefined }, dispatchIntervalMs: 100, bullmqPrefix: `phase8c-${isolation}`, outboxTopics: { bookAnalysis: `phase8c.worker.${isolation}` } }); try { expect(runtimeWorker.bookWorker).toBeTruthy(); const requested = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "worker", promptVersion: "p", provider: "fixture", model: "fixture-model", routePlan: await durableRoutePlan(f.workspaceId), outboxTopic: `phase8c.worker.${isolation}` }); const completed = await waitForRun(requested.run.id); expect(completed).toMatchObject({ status: "SUCCEEDED", analysisStage: "COMPLETED" }); expect(calls.text).toBeGreaterThan(0); expect(calls.embedding).toBe(1); } finally { await runtimeWorker.close(); } });
  it("W06 enables the real worker with a durable local keyring and pinned plan", async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }, document = await bookLineage(f), isolation = randomUUID(), directory = mkdtempSync(join(tmpdir(), "acs-local-keyring-")), localKeyring = join(directory, "provider-gateway-keyring.json"); writeFileSync(localKeyring, keyring); await routes(f, undefined, { providerKey: "openai", protocol: "OPENAI_RESPONSES", displayName: "OpenAI", modelId: "gpt-4o-mini", embeddingModelId: "text-embedding-3-small", embeddingDimensions: 1536 }); const workerSource = { REDIS_URL: source.REDIS_URL, NODE_ENV: "test", PROVIDER_GATEWAY_LOCAL_KEYRING_PATH: localKeyring }; const runtimeWorker = await startWorkerRuntime({ REDIS_URL: source.REDIS_URL } as never, { source: workerSource, bookProductionGatewayOverrides: { ...controls, adapterResolver: input => ({ execute: async ({ request }) => input.family === "EMBEDDING" ? (calls.embedding++, { response: { vectors: request.embedding!.texts.map(() => [1, ...Array(1535).fill(0)]), dimensions: 1536 } }) : (calls.text++, { response: { type: "STRUCTURED", structured: { summary: "zero config summary", memory: [{ type: "SUMMARY", content: "grounded durable evidence" }] } }, usage: { inputTokens: 1, outputTokens: 1 } }) }) }, dispatchIntervalMs: 100, bullmqPrefix: `phase8c-${isolation}`, outboxTopics: { bookAnalysis: `phase8c.zero-config.${isolation}` } }); try { expect(runtimeWorker.bookWorker).toBeTruthy(); const requested = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "zero-config", promptVersion: "p", provider: "openai", model: "gpt-4o-mini", routePlan: await durableRoutePlan(f.workspaceId), outboxTopic: `phase8c.zero-config.${isolation}` }); const completed = await waitForRun(requested.run.id); expect(completed).toMatchObject({ status: "SUCCEEDED", analysisStage: "COMPLETED" }); expect(await prisma.currentBookIntelligence.findFirst({ where: { workspaceId: f.workspaceId, analysisRunId: requested.run.id } })).toBeTruthy(); expect(calls.text).toBeGreaterThan(0); expect(calls.embedding).toBe(1); } finally { await runtimeWorker.close(); rmSync(directory, { recursive: true, force: true }); } });
  it("P01 valid production startup", () => expect(runtime({ text: 0, embedding: 0 })).toMatchObject({ gateway: expect.any(Object), repository: expect.any(Object) }));
  it("honors one-attempt policy even when the gateway deadline replaces adapter cancellation", async () => {
    const f = await fixture(); await routes(f); let calls = 0;
    const r = createBookProductionGatewayRuntime(source, { ...controls, maxAttempts: 1, timeoutMs: 20, adapterResolver: () => ({ execute: async ({ signal }) => {
      calls++; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ProviderGatewayError("CANCELLED")), { once: true }));
    } }) });
    try {
      await expect(r.gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "bounded-deadline"), { userId: f.userId })).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(calls).toBe(1);
      const invocation = await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: f.workspaceId }, include: { attempts: true } });
      expect(invocation.attempts).toHaveLength(1); expect(invocation.attempts[0]).toMatchObject({ status: "TIMEOUT", failureCode: "TIMEOUT" });
    } finally { await r.close(); }
  });
  it("sends real bounded source IDs/ranges and materializes their validated evidence", async () => {
    const f = await fixture(), document = await bookLineage(f); await routes(f); let groundedRequests = 0;
    const r = createBookProductionGatewayRuntime(source, { ...controls, adapterResolver: input => ({ execute: async ({ request: value }) => {
      if (input.family === "EMBEDDING") return { response: { vectors: value.embedding!.texts.map(() => [1, 0, 0]), dimensions: 3 } };
      if (value.routeSlot !== "BOOK_CHUNK_ANALYSIS") return { response: { type: "STRUCTURED", structured: { summary: "derived summary" } } };
      const payload = JSON.parse(value.text!.messages[0]!.content), spans = payload.sourceSlices;
      expect(spans.length).toBeGreaterThan(0); expect(value.text!.system).toContain("Never invent IDs");
              const chunkId = /:CHUNK:chunk:([^:]+):/.exec(value.idempotencyKey)![1]!;
        const chunk = await prisma.documentChunk.findUniqueOrThrow({ where: { id: chunkId } });
        expect(payload).not.toHaveProperty("content");
        expect(spans.map((span: { text: string }) => span.text).join("\n\n")).toBe(chunk.content);
      for (const span of spans) {
        const block = await prisma.sourceBlock.findUniqueOrThrow({ where: { id: span.sourceBlockId } });
        expect(block.text.slice(span.startOffset, span.endOffset)).toBe(span.text);
      }
      groundedRequests++;
      const { sourceBlockId, startOffset, endOffset } = spans[0];
      return { response: { type: "STRUCTURED", structured: { summary: "grounded", memory: [{ type: "CLAIM", content: "Grounded evidence.", evidence: [{ sourceBlockId, startOffset, endOffset }] }] } } };
    } }) });
    try {
      const requested = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "source-evidence-test", promptVersion: "v2", provider: "fixture", model: "fixture-model" });
      const final = await processBookAnalysisRun(requested.run.id, { analysisProviderForRun: r.createAnalysisProvider, embeddingGatewayForRun: input => ({ gateway: r.gateway, repository: r.repository, userId: input.userId }) });
      expect(final.status).toBe("SUCCEEDED"); expect(groundedRequests).toBeGreaterThan(0);
      expect(await prisma.bookMemoryEvidence.count({ where: { analysisRunId: requested.run.id } })).toBeGreaterThan(0);
    } finally { await r.close(); }
  });
  it("allows the explicitly selected two-attempt deadline policy within the original business lease", async () => {
    const f = await fixture(); await routes(f); let calls = 0;
    const r = createBookProductionGatewayRuntime(source, { ...controls, maxAttempts: 2, timeoutMs: 20, adapterResolver: () => ({ execute: async ({ signal }) => {
      if (++calls === 1) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ProviderGatewayError("CANCELLED")), { once: true }));
      return { response: { type: "STRUCTURED", structured: { summary: "recovered" } }, usage: { inputTokens: 1, outputTokens: 1 } };
    } }) });
    try {
      expect(await r.gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "bounded-two-attempts"), { userId: f.userId })).toMatchObject({ status: "SUCCEEDED", attempt: 2 });
      expect(calls).toBe(2);
      const invocation = await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: f.workspaceId }, include: { attempts: { orderBy: { attemptNumber: "asc" } } } });
      expect(invocation.attempts.map(attempt => attempt.status)).toEqual(["TIMEOUT", "SUCCEEDED"]);
    } finally { await r.close(); }
  });
  it("P02 missing keyring fails closed", () => expect(() => createBookProductionGatewayRuntime({ ...source, PROVIDER_GATEWAY_KEYRING: undefined, PROVIDER_GATEWAY_LOCAL_KEYRING_PATH: join(tmpdir(), `missing-keyring-${randomUUID()}`) })).toThrow("PROVIDER_GATEWAY_KEYRING_MISSING"));
  it("P03 malformed manifest fails closed", () => expect(() => createBookProductionGatewayRuntime({ ...source, PROVIDER_GATEWAY_MODEL_MANIFEST: "{" })).toThrow("PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID"));
  it("P04 missing BOOK_CHUNK_ANALYSIS route", async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }; await expect(runtime(calls).gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p04"), { userId: f.userId })).rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE" }); expect(calls.text).toBe(0); });
  it("P05 missing EMBEDDING route", async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }; await expect(runtime(calls).gateway.execute(request(f.workspaceId, "EMBEDDING", "p05", true), { userId: f.userId })).rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE" }); expect(calls.embedding).toBe(0); });
  it("P06 disabled connection fails closed", async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }, { store, connection } = await routes(f); await store.setConnectionEnabled(f, connection.id, false); await expect(runtime(calls).gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p06"), { userId: f.userId })).rejects.toMatchObject({ code: "CONNECTION_DISABLED" }); expect(calls.text).toBe(0); });
  it("P07 absent membership fails closed", async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }; await routes(f); const other = await prisma.user.create({ data: { email: `${randomUUID()}@phase8c.test` } }); await expect(runtime(calls).gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p07"), { userId: other.id })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" }); expect(calls.text).toBe(0); await prisma.user.delete({ where: { id: other.id } }); });
  it("P08 actor-null path is explicitly rejected by the production authorizer", async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }; await routes(f); await expect(runtime(calls).gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p08"))).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" }); expect(calls.text).toBe(0); });
  it("P09 workspace A uses only A route", async () => { const a = await fixture(), b = await fixture(), calls = { text: 0, embedding: 0 }; await routes(a); await routes(b); await runtime(calls).gateway.execute(request(a.workspaceId, "BOOK_CHUNK_ANALYSIS", "p09"), { userId: a.userId }); expect(await prisma.providerInvocation.count({ where: { workspaceId: a.workspaceId } })).toBe(1); expect(await prisma.providerInvocation.count({ where: { workspaceId: b.workspaceId } })).toBe(0); });
  it("P10 workspace B uses only B route", async () => { const a = await fixture(), b = await fixture(), calls = { text: 0, embedding: 0 }; await routes(a); await routes(b); await runtime(calls).gateway.execute(request(b.workspaceId, "BOOK_CHUNK_ANALYSIS", "p10"), { userId: b.userId }); expect(await prisma.providerInvocation.count({ where: { workspaceId: b.workspaceId } })).toBe(1); expect(await prisma.providerInvocation.count({ where: { workspaceId: a.workspaceId } })).toBe(0); });
  for (const [label, slot, embedding] of [["P11", "BOOK_CHUNK_ANALYSIS", false], ["P12", "BOOK_REDUCTION_ANALYSIS", false], ["P13", "BOOK_REDUCTION_ANALYSIS", false], ["P14", "BOOK_SYNTHESIS", false], ["P15", "EMBEDDING", true]] as const) it(`${label} uses exact route slot ${slot}`, async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }; await routes(f); await runtime(calls).gateway.execute(request(f.workspaceId, slot, label, embedding), { userId: f.userId }); expect((await prisma.providerExecutionSnapshot.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })).routeSlot).toBe(slot); });
  it("P16 durable text result survives retry with one remote call", async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }, r = runtime(calls); await routes(f); await r.gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p16"), { userId: f.userId }); await r.gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p16"), { userId: f.userId }); expect(calls.text).toBe(1); await expect(Promise.all([prisma.providerExecutionSnapshot.count({ where: { workspaceId: f.workspaceId } }), prisma.providerInvocation.count({ where: { workspaceId: f.workspaceId } }), prisma.providerInvocationAttempt.count({ where: { workspaceId: f.workspaceId } }), prisma.providerUsageEvent.count({ where: { workspaceId: f.workspaceId } }), prisma.providerTextResult.count({ where: { workspaceId: f.workspaceId } })])).resolves.toEqual([1, 1, 1, 1, 1]); });
  it("P17 consumed receipt replay reports textConsumed and performs no remote call", async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }, r = runtime(calls); await routes(f); const first = await r.gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p17"), { userId: f.userId }); if (first.status !== "SUCCEEDED" || !first.invocationId) throw new Error("fixture"); await r.repository.consumeTextResult({ workspaceId: f.workspaceId, invocationId: first.invocationId, snapshotId: first.snapshot.id, consumerKind: "TEST", consumerKey: "p17", consumerFingerprint: "b".repeat(64) }, async () => undefined); await expect(r.gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p17"), { userId: f.userId })).resolves.toMatchObject({ status: "ALREADY_PROCESSED", textConsumed: true }); expect(calls.text).toBe(1); });
  it("P18 consumed missing destination cannot recreate or recall", async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }, r = runtime(calls); await routes(f); const first = await r.gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p18"), { userId: f.userId }); if (first.status !== "SUCCEEDED" || !first.invocationId) throw new Error("fixture"); await r.repository.consumeTextResult({ workspaceId: f.workspaceId, invocationId: first.invocationId, snapshotId: first.snapshot.id, consumerKind: "TEST", consumerKey: "p18", consumerFingerprint: "c".repeat(64) }, async () => undefined); await r.gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p18"), { userId: f.userId }); expect(calls.text).toBe(1); });
  it("P19 durable receipt remains pinned after a route update", async () => { const f = await fixture(), calls = { text: 0, embedding: 0 }, r = runtime(calls), { store, connection } = await routes(f); await r.gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p19"), { userId: f.userId }); await store.setRoute(f, { routeSlot: "BOOK_CHUNK_ANALYSIS", connectionId: connection.id, modelId: "fixture-model" }); await r.gateway.execute(request(f.workspaceId, "BOOK_CHUNK_ANALYSIS", "p19"), { userId: f.userId }); expect(calls.text).toBe(1); });
  it("P20 completes the real production-composed BookAnalysis chain", async () => { const f = await fixture(), document = await bookLineage(f), calls = { text: 0, embedding: 0 }, r = runtime(calls); await routes(f); const requested = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "p20", promptVersion: "p", provider: "fixture", model: "fixture-model" }); const final = await processBookAnalysisRun(requested.run.id, { analysisProviderForRun: input => r.createAnalysisProvider(input), embeddingGatewayForRun: input => ({ gateway: r.gateway, repository: r.repository, userId: input.userId }) }); expect(final).toMatchObject({ status: "SUCCEEDED", analysisStage: "COMPLETED" }); expect(await prisma.job.findUniqueOrThrow({ where: { id: requested.job.id } })).toMatchObject({ status: "SUCCEEDED" }); expect(await prisma.currentBookIntelligence.findFirst({ where: { workspaceId: f.workspaceId, analysisRunId: requested.run.id } })).toBeTruthy(); expect(calls.text).toBeGreaterThan(0); expect(calls.embedding).toBe(1); });
  it("P21 completes durable MiniMax JSON-mode text plus Gemini 768-dimensional embeddings", async () => {
    const f = await fixture(), document = await bookLineage(f), calls = { text: 0, embedding: 0 };
    const manifest = JSON.stringify({ providers: [
      { providerKey: "minimax", displayName: "MiniMax", protocol: "OPENAI_COMPATIBLE", adapterVersion: "test", models: [{ modelId: "MiniMax-M3", families: ["TEXT_GENERATION"], confidence: "DECLARED", structuredOutput: "JSON_MODE" }] },
      { providerKey: "gemini", displayName: "Google Gemini", protocol: "GEMINI_NATIVE", capabilityProtocols: { EMBEDDING: "GEMINI_EMBEDDINGS" }, adapterVersion: "test", models: [{ modelId: "gemini-embedding-2", families: ["EMBEDDING"], confidence: "DECLARED", embeddingDimensions: 768, configurableEmbeddingDimensions: true }] },
    ] });
    const transport = new DeterministicProviderHttpTransport(request => {
      if (request.url.includes(":batchEmbedContents")) { calls.embedding++; const body = JSON.parse(request.body!); expect(body.requests[0].embedContentConfig.outputDimensionality).toBe(768); return { status: 200, headers: {}, body: JSON.stringify({ embeddings: body.requests.map(() => ({ values: [1, ...Array(767).fill(0)] })) }) }; }
      calls.text++; return { status: 200, headers: {}, body: JSON.stringify({ model: "MiniMax-M3", choices: [{ finish_reason: "stop", message: { content: '{"summary":"MiniMax final response","memory":[{"type":"SUMMARY","content":"grounded durable evidence"}]}', reasoning_content: "never persist this reasoning" } }] }) };
    });
    const r = createBookProductionGatewayRuntime({ ...source, PROVIDER_GATEWAY_MODEL_MANIFEST: manifest }, { ...controls, adapterResolver: createProviderAdapterResolver(transport) });
    const store = new ProviderGatewayRepository(prisma, parseKeyring(keyring)!);
    const minimax = await store.createConnection(f, { providerKey: "minimax", protocol: "OPENAI_COMPATIBLE", displayName: "MiniMax" }); await store.rotateCredential(f, minimax.id, "minimax-sentinel");
    for (const routeSlot of ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"] as const) await store.setRoute(f, { routeSlot, connectionId: minimax.id, modelId: "MiniMax-M3" });
    const gemini = await store.createConnection(f, { providerKey: "gemini", protocol: "GEMINI_EMBEDDINGS", displayName: "Gemini" }); await store.rotateCredential(f, gemini.id, "gemini-sentinel"); await store.setRoute(f, { routeSlot: "EMBEDDING", connectionId: gemini.id, modelId: "gemini-embedding-2", configuration: { embeddingDimensions: 768 } });
    const requested = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "p21", promptVersion: "p", provider: "minimax", model: "MiniMax-M3" });
    await expect(processBookAnalysisRun(requested.run.id, { analysisProviderForRun: input => r.createAnalysisProvider(input), embeddingGatewayForRun: input => ({ gateway: r.gateway, repository: r.repository, userId: input.userId }) })).resolves.toMatchObject({ status: "SUCCEEDED", analysisStage: "COMPLETED" });
    expect(await prisma.currentBookIntelligence.findFirst({ where: { workspaceId: f.workspaceId, analysisRunId: requested.run.id } })).toBeTruthy();
    expect(await prisma.providerExecutionSnapshot.findMany({ where: { workspaceId: f.workspaceId }, select: { providerKey: true, modelId: true, routeSlot: true, capability: true } })).toEqual(expect.arrayContaining([expect.objectContaining({ providerKey: "minimax", modelId: "MiniMax-M3", routeSlot: "BOOK_CHUNK_ANALYSIS" }), expect.objectContaining({ providerKey: "gemini", modelId: "gemini-embedding-2", routeSlot: "EMBEDDING" })]));
    const minimaxCalls = transport.calls.filter(call => call.url === "https://api.minimax.io/v1/text/chatcompletion_v2"); expect(minimaxCalls.length).toBeGreaterThan(0); const minimaxBody = JSON.parse(minimaxCalls[0]!.body!); expect(minimaxCalls[0]!.headers.authorization).toBe("Bearer minimax-sentinel"); expect(minimaxBody.model).toBe("MiniMax-M3"); expect(minimaxBody.response_format).toBeUndefined(); expect(minimaxBody.messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("exactly one JSON object") }); expect(JSON.stringify(await prisma.providerTextResult.findMany({ where: { workspaceId: f.workspaceId } }))).not.toContain("reasoning"); expect(JSON.stringify(await prisma.providerExecutionSnapshot.findMany({ where: { workspaceId: f.workspaceId } }))).not.toContain("minimax-sentinel");
    expect(calls.text).toBeGreaterThan(0); expect(calls.embedding).toBe(1);
  });
  it("P22 fails closed and never publishes Book Intelligence when real MiniMax final content is prose", async () => {
    const f = await fixture(), document = await bookLineage(f);
    const manifest = JSON.stringify({ providers: [
      { providerKey: "minimax", displayName: "MiniMax", protocol: "OPENAI_COMPATIBLE", adapterVersion: "test", models: [{ modelId: "MiniMax-M3", families: ["TEXT_GENERATION"], confidence: "DECLARED", structuredOutput: "JSON_MODE" }] },
      { providerKey: "gemini", displayName: "Google Gemini", protocol: "GEMINI_NATIVE", capabilityProtocols: { EMBEDDING: "GEMINI_EMBEDDINGS" }, adapterVersion: "test", models: [{ modelId: "gemini-embedding-2", families: ["EMBEDDING"], confidence: "DECLARED", embeddingDimensions: 768, configurableEmbeddingDimensions: true }] },
    ] });
    const transport = new DeterministicProviderHttpTransport(request => request.url.includes(":batchEmbedContents") ? { status: 200, headers: {}, body: JSON.stringify({ embeddings: [] }) } : { status: 200, headers: {}, body: JSON.stringify({ model: "MiniMax-M3", choices: [{ finish_reason: "stop", message: { content: "ordinary prose must fail", reasoning_content: '{"summary":"never consume reasoning"}' } }] }) });
    const r = createBookProductionGatewayRuntime({ ...source, PROVIDER_GATEWAY_MODEL_MANIFEST: manifest }, { ...controls, adapterResolver: createProviderAdapterResolver(transport) });
    const store = new ProviderGatewayRepository(prisma, parseKeyring(keyring)!);
    const minimax = await store.createConnection(f, { providerKey: "minimax", protocol: "OPENAI_COMPATIBLE", displayName: "MiniMax" }); await store.rotateCredential(f, minimax.id, "minimax-prose-sentinel");
    for (const routeSlot of ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"] as const) await store.setRoute(f, { routeSlot, connectionId: minimax.id, modelId: "MiniMax-M3" });
    const gemini = await store.createConnection(f, { providerKey: "gemini", protocol: "GEMINI_EMBEDDINGS", displayName: "Gemini" }); await store.rotateCredential(f, gemini.id, "gemini-prose-sentinel"); await store.setRoute(f, { routeSlot: "EMBEDDING", connectionId: gemini.id, modelId: "gemini-embedding-2", configuration: { embeddingDimensions: 768 } });
    const requested = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "p22", promptVersion: "p", provider: "minimax", model: "MiniMax-M3" });
    await expect(processBookAnalysisRun(requested.run.id, { analysisProviderForRun: input => r.createAnalysisProvider(input), embeddingGatewayForRun: input => ({ gateway: r.gateway, repository: r.repository, userId: input.userId }) })).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    expect(await prisma.currentBookIntelligence.findFirst({ where: { workspaceId: f.workspaceId, analysisRunId: requested.run.id } })).toBeNull(); expect(JSON.stringify(await prisma.providerTextResult.findMany({ where: { workspaceId: f.workspaceId } }))).not.toContain("reasoning");
  });
  it("P23 executes each Book stage through its sealed mixed provider route after live bindings change", async () => {
    const f = await fixture(), document = await bookLineage(f, true), seen: Array<{ url: string; model: string; structured?: unknown; input?: string[]; dimensions?: number }> = []; let textResponse = 0;
    const mixedManifest = JSON.stringify({ providers: [
      { providerKey: "minimax", displayName: "MiniMax", protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v1", models: [{ modelId: "MiniMax-M3", families: ["TEXT_GENERATION"], confidence: "DECLARED", structuredOutput: "JSON_MODE" }] },
      { providerKey: "deepseek", displayName: "DeepSeek", protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v2", models: [{ modelId: "deepseek-v4-flash", families: ["TEXT_GENERATION"], confidence: "DECLARED", structuredOutput: "JSON_MODE" }] },
      { providerKey: "openai", displayName: "OpenAI", protocol: "OPENAI_RESPONSES", adapterVersion: "builtin-v1", models: [{ modelId: "gpt-4o-mini", families: ["TEXT_GENERATION"], confidence: "DECLARED", structuredOutput: "STRICT_JSON_SCHEMA" }] },
      { providerKey: "qwen", displayName: "Qwen", protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v1", models: [{ modelId: "text-embedding-v4", families: ["EMBEDDING"], confidence: "DECLARED", embeddingDimensions: 1024, configurableEmbeddingDimensions: true, embeddingDimensionOptions: [768] }] },
    ] });
    const transport = new DeterministicProviderHttpTransport(request => {
      const body = JSON.parse(request.body!);
      if (request.url.endsWith("/embeddings")) { seen.push({ url: request.url, model: body.model, input: body.input, dimensions: body.dimensions }); return { status: 200, headers: {}, body: JSON.stringify({ model: "text-embedding-v4", data: body.input.map((_: string, index: number) => ({ index, embedding: [1, ...Array(767).fill(0)] })), usage: { prompt_tokens: 7 } }) }; }
      if (request.url.endsWith("/responses")) { seen.push({ url: request.url, model: body.model, structured: body.text?.format }); return { status: 200, headers: {}, body: JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: `strict synthesis ${++textResponse}`, memory: [{ type: "SUMMARY", content: "grounded durable evidence" }] }) }] }], usage: { input_tokens: 3, output_tokens: 2 } }) }; }
      seen.push({ url: request.url, model: body.model, structured: body.response_format }); return { status: 200, headers: {}, body: JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ summary: `mixed stage ${++textResponse}`, memory: [{ type: "SUMMARY", content: "grounded durable evidence" }] }) } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) };
    });
    const runtimeMixed = createBookProductionGatewayRuntime({ ...source, PROVIDER_GATEWAY_MODEL_MANIFEST: mixedManifest }, { ...controls, adapterResolver: createProviderAdapterResolver(transport) });
    const store = new ProviderGatewayRepository(prisma, parseKeyring(keyring)!);
    const minimax = await store.createConnection(f, { providerKey: "minimax", protocol: "OPENAI_COMPATIBLE", displayName: "Mixed MiniMax" }); await store.rotateCredential(f, minimax.id, "mixed-minimax");
    const deepseek = await store.createConnection(f, { providerKey: "deepseek", protocol: "OPENAI_COMPATIBLE", displayName: "Mixed DeepSeek" }); await store.rotateCredential(f, deepseek.id, "mixed-deepseek");
    const openai = await store.createConnection(f, { providerKey: "openai", protocol: "OPENAI_RESPONSES", displayName: "Mixed Strict" }); await store.rotateCredential(f, openai.id, "mixed-strict");
    const qwen = await store.createConnection(f, { providerKey: "qwen", protocol: "OPENAI_COMPATIBLE", displayName: "Mixed Qwen" }); await store.rotateCredential(f, qwen.id, "mixed-qwen");
    await store.setRoute(f, { routeSlot: "BOOK_CHUNK_ANALYSIS", connectionId: minimax.id, modelId: "MiniMax-M3" });
    await store.setRoute(f, { routeSlot: "BOOK_REDUCTION_ANALYSIS", connectionId: deepseek.id, modelId: "deepseek-v4-flash" });
    await store.setRoute(f, { routeSlot: "BOOK_SYNTHESIS", connectionId: openai.id, modelId: "gpt-4o-mini" });
    await store.setRoute(f, { routeSlot: "EMBEDDING", connectionId: qwen.id, modelId: "text-embedding-v4", configuration: { qwenRegion: "BEIJING", qwenWorkspaceId: "mixed-workspace", embeddingDimensions: 768 } });
    const requested = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "p23", promptVersion: "p", provider: "minimax", model: "MiniMax-M3", routePlan: await durableRoutePlan(f.workspaceId) });
    await store.setRoute(f, { routeSlot: "BOOK_CHUNK_ANALYSIS", connectionId: deepseek.id, modelId: "deepseek-v4-flash" });
    await expect(processBookAnalysisRun(requested.run.id, { analysisProviderForRun: input => runtimeMixed.createAnalysisProvider(input), embeddingGatewayForRun: input => runtimeMixed.createEmbeddingGatewayForRun(input) })).resolves.toMatchObject({ status: "SUCCEEDED", analysisStage: "COMPLETED" });
    expect(seen.filter(call => call.url === "https://api.minimax.io/v1/text/chatcompletion_v2").every(call => call.model === "MiniMax-M3" && call.structured === undefined)).toBe(true);
    const reductions = seen.filter(call => call.url === "https://api.deepseek.com/chat/completions"); expect(reductions.length).toBeGreaterThanOrEqual(2); expect(reductions.every(call => call.model === "deepseek-v4-flash" && (call.structured as { type?: string } | undefined)?.type === "json_object")).toBe(true);
    expect(seen.filter(call => call.url.endsWith("/embeddings"))).toEqual([expect.objectContaining({ model: "text-embedding-v4", dimensions: 768 })]);
    expect(seen).toContainEqual(expect.objectContaining({ url: "https://api.openai.com/v1/responses", model: "gpt-4o-mini", structured: expect.objectContaining({ type: "json_schema" }) }));
    expect(seen).toContainEqual(expect.objectContaining({ url: "https://mixed-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings", model: "text-embedding-v4" }));
    const snapshots = await prisma.providerExecutionSnapshot.findMany({ where: { workspaceId: f.workspaceId }, select: { routeSlot: true, providerKey: true, modelId: true } });
    expect(snapshots).toEqual(expect.arrayContaining([expect.objectContaining({ routeSlot: "BOOK_CHUNK_ANALYSIS", providerKey: "minimax", modelId: "MiniMax-M3" }), expect.objectContaining({ routeSlot: "BOOK_REDUCTION_ANALYSIS", providerKey: "deepseek", modelId: "deepseek-v4-flash" }), expect.objectContaining({ routeSlot: "BOOK_SYNTHESIS", providerKey: "openai", modelId: "gpt-4o-mini" }), expect.objectContaining({ routeSlot: "EMBEDDING", providerKey: "qwen", modelId: "text-embedding-v4" })]));
    const usage = await prisma.providerUsageEvent.findMany({ where: { workspaceId: f.workspaceId }, select: { routeSlot: true, providerKey: true, modelId: true } });
    const expectedUsage = [
      { routeSlot: "BOOK_CHUNK_ANALYSIS", providerKey: "minimax", modelId: "MiniMax-M3" },
      { routeSlot: "BOOK_REDUCTION_ANALYSIS", providerKey: "deepseek", modelId: "deepseek-v4-flash" },
      { routeSlot: "BOOK_SYNTHESIS", providerKey: "openai", modelId: "gpt-4o-mini" },
      { routeSlot: "EMBEDDING", providerKey: "qwen", modelId: "text-embedding-v4" },
    ];
    expect(usage).toEqual(expect.arrayContaining(expectedUsage));
    expect(usage.length).toBeGreaterThanOrEqual(4);
    expect(usage.every(event => expectedUsage.some(expected => expected.routeSlot === event.routeSlot && expected.providerKey === event.providerKey && expected.modelId === event.modelId))).toBe(true);
    expect(await prisma.currentBookIntelligence.findFirst({ where: { workspaceId: f.workspaceId, analysisRunId: requested.run.id } })).toBeTruthy();
  });
  it("P24 creates a distinct BookAnalysisRun for a changed custom endpoint but reuses its normalized target", async () => {
    const f = await fixture(), document = await bookLineage(f); await routes(f);
    const customA = await durableRoutePlan(f.workspaceId);
    customA.routes.BOOK_CHUNK_ANALYSIS = { ...customA.routes.BOOK_CHUNK_ANALYSIS, providerKey: "openai-compatible", modelId: "custom-book-model", endpoint: "https://custom-a.example.test/v1/" };
    const first = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "p24", promptVersion: "p", provider: "openai-compatible", model: "custom-book-model", routePlan: customA });
    const sameTarget = structuredClone(customA);
    sameTarget.routes.BOOK_CHUNK_ANALYSIS.connectionId = "rotated-custom-connection";
    sameTarget.routes.BOOK_CHUNK_ANALYSIS.credentialVersionId = "rotated-custom-credential";
    sameTarget.routes.BOOK_CHUNK_ANALYSIS.endpoint = "https://CUSTOM-A.example.test:443/v1?credential=excluded";
    const retry = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "p24", promptVersion: "p", provider: "openai-compatible", model: "custom-book-model", routePlan: sameTarget });
    await prisma.job.update({ where: { id: first.job.id }, data: { status: "SUCCEEDED", completedAt: new Date() } });
    const customB = structuredClone(customA);
    customB.routes.BOOK_CHUNK_ANALYSIS.endpoint = "https://custom-b.example.test/v1";
    const changed = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "p24", promptVersion: "p", provider: "openai-compatible", model: "custom-book-model", routePlan: customB });
    expect(retry.run.id).toBe(first.run.id);
    expect(retry.run.analysisIdentityHash).toBe(first.run.analysisIdentityHash);
    expect(changed.run.id).not.toBe(first.run.id);
    expect(changed.run.analysisIdentityHash).not.toBe(first.run.analysisIdentityHash);
  });
  it("P25 executes a failed semantic run through the fresh Job attempt plan after a connection switch", async () => {
    const f = await fixture(), document = await bookLineage(f), calls = { text: 0, embedding: 0 }, r = runtime(calls);
    const { store, connection: firstConnection } = await routes(f);
    const firstPlan = await durableRoutePlan(f.workspaceId);
    const requested = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "p25", promptVersion: "p", provider: "fixture", model: "fixture-model", routePlan: firstPlan });
    await prisma.bookAnalysisRun.update({ where: { id: requested.run.id }, data: { status: "FAILED", errorCode: "P25_FIRST_CONNECTION_FAILED" } });
    await prisma.job.update({ where: { id: requested.job.id }, data: { status: "FAILED", error: { code: "P25_FIRST_CONNECTION_FAILED" }, completedAt: new Date() } });

    const secondConnection = await store.createConnection(f, { providerKey: "fixture", protocol: "TEST", displayName: "fixture-recovery" });
    await store.rotateCredential(f, secondConnection.id, "fixture-recovery-secret");
    for (const routeSlot of ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING"] as const) {
      await store.setRoute(f, { routeSlot, connectionId: secondConnection.id, modelId: "fixture-model", configuration: routeSlot === "EMBEDDING" ? { embeddingDimensions: 3 } : {} });
    }
    const secondPlan = await durableRoutePlan(f.workspaceId);
    const retried = await requestBookAnalysisForUser(f, { sourceDocumentId: document.id, pipelineVersion: "p25", promptVersion: "p", provider: "fixture", model: "fixture-model", routePlan: secondPlan });

    expect(retried.run.id).toBe(requested.run.id);
    expect(retried.run.dispatchGeneration).toBe(requested.run.dispatchGeneration + 1);
    expect(retried.job.id).not.toBe(requested.job.id);
    expect((retried.run.routePlan as { routes: Record<string, { connectionId: string }> }).routes.BOOK_CHUNK_ANALYSIS!.connectionId).toBe(firstConnection.id);
    expect(((retried.job.payload as { routePlan?: { routes?: Record<string, { connectionId?: string }> } }).routePlan?.routes?.BOOK_CHUNK_ANALYSIS?.connectionId)).toBe(secondConnection.id);
    expect(((requested.job.payload as { routePlan?: { routes?: Record<string, { connectionId?: string }> } }).routePlan?.routes?.BOOK_CHUNK_ANALYSIS?.connectionId)).toBe(firstConnection.id);

    await expect(processBookAnalysisRun(retried.run.id, { analysisProviderForRun: input => r.createAnalysisProvider(input), embeddingGatewayForRun: input => r.createEmbeddingGatewayForRun(input) }, retried.run.dispatchGeneration)).resolves.toMatchObject({ status: "SUCCEEDED", analysisStage: "COMPLETED" });
    const snapshots = await prisma.providerExecutionSnapshot.findMany({ where: { workspaceId: f.workspaceId }, select: { connectionId: true } });
    expect(snapshots.length).toBeGreaterThan(0);
    expect(new Set(snapshots.map(snapshot => snapshot.connectionId))).toEqual(new Set([secondConnection.id]));
    expect(calls.text).toBeGreaterThan(0);
    expect(calls.embedding).toBe(1);
  });

});

it("事实分类提示明确使用现有CLAIM且不丢弃原文事实", async () => {
  const {bookAnalysisJsonOutputContract} = await import("../src/provider-gateway-runtime.js");
  expect(bookAnalysisJsonOutputContract).toContain("factual statements and supporting facts use CLAIM");
  expect(bookAnalysisJsonOutputContract).toContain("do not omit facts");
});
