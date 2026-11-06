import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { ProviderGatewayRepository, testCipher } from "@ai-cognitive/provider-gateway";
import { GET, POST } from "../app/api/studio/providers/route";
import { providerReadiness } from "../lib/provider-product";
import { miniMaxSites } from "../lib/minimax-endpoints";
let actor: {workspaceId:string;userId:string};
vi.mock("@/lib/identity",()=>({resolveWebIdentity:async()=>actor}));
vi.mock("node:dns/promises",()=>({lookup:async()=>[{address:"93.184.216.34",family:4}]}));
vi.mock("@ai-cognitive/provider-gateway",async original=>{const mod=await original<typeof import("@ai-cognitive/provider-gateway")>();return {...mod,resolveCredentialKeyring:()=>mod.testCipher()};});
const owned:Array<{workspaceId:string;userId:string}>=[];
async function fixture(){const userId=randomUUID(),workspaceId=randomUUID();actor={userId,workspaceId};owned.push(actor);await prisma.user.create({data:{id:userId,email:`${userId}@ui-restore.test`}});await prisma.workspace.create({data:{id:workspaceId,name:"界面回归"}});await prisma.workspaceMember.create({data:{...actor,role:"OWNER"}});const repository=new ProviderGatewayRepository(prisma,testCipher());return repository.createConnectionWithCredential(actor,{providerKey:"zhipu",protocol:"OPENAI_COMPATIBLE",displayName:"智谱",endpoint:"https://open.bigmodel.cn/api/paas/v4/chat/completions",secret:"fixture-not-a-real-key"});}
const post=(body:unknown)=>POST(new Request("http://localhost/api/studio/providers",{method:"POST",body:JSON.stringify(body)}));
afterEach(async()=>{for(const {workspaceId,userId}of owned.splice(0)){await prisma.providerRouteBinding.deleteMany({where:{workspaceId}});await prisma.providerCredentialVersion.deleteMany({where:{workspaceId}});await prisma.providerConnection.deleteMany({where:{workspaceId}});await prisma.providerAuditEvent.deleteMany({where:{workspaceId}});await prisma.workspaceMember.deleteMany({where:{workspaceId}});await prisma.workspace.delete({where:{id:workspaceId}});await prisma.user.delete({where:{id:userId}});}});
it("恢复界面可用同一密钥配置语音与向量，保存不会发送模型请求",async()=>{const {connection}=await fixture();const remote=vi.spyOn(globalThis,"fetch");try{for(const [routeSlot,modelId,configuration]of [["PODCAST_TTS","glm-tts",{outputFormat:"wav",hostVoices:[1,2].map(ordinal=>({ordinal,providerVoiceId:ordinal===1?"tongtong":"xiaochen",voiceVersion:"1",speakingRate:1,pitch:0,outputFormat:"wav"}))}],["EMBEDDING","embedding-3",{embeddingDimensions:2048}]]as const){expect((await post({action:"SET_ROUTE",routeSlot,modelId,connectionId:connection.id,configuration})).status).toBe(200);const route=await prisma.providerRouteBinding.findUniqueOrThrow({where:{workspaceId_routeSlot:{workspaceId:actor.workspaceId,routeSlot}}});expect(route.connectionId).not.toBe(connection.id);}const readiness=await providerReadiness(actor.workspaceId);expect(readiness.podcast.dependencies).toHaveLength(2);expect(readiness.podcastAudio).toMatchObject({state:"READY",configured:2,required:2});expect(remote).not.toHaveBeenCalled();}finally{remote.mockRestore();}});
it("三个理解阶段仅在明确勾选后统一保存",async()=>{const {connection}=await fixture();expect((await post({action:"SET_ROUTE",connectionId:connection.id,routeSlot:"BOOK_CHUNK_ANALYSIS",modelId:"glm-4.7-flashx",applyToBookStages:true,configuration:{}})).status).toBe(200);expect(await prisma.providerRouteBinding.count({where:{workspaceId:actor.workspaceId}})).toBe(3);expect((await post({action:"SET_ROUTE",connectionId:connection.id,routeSlot:"BOOK_CHUNK_ANALYSIS",modelId:"glm-4.5-air",configuration:{}})).status).toBe(200);expect((await prisma.providerRouteBinding.findUniqueOrThrow({where:{workspaceId_routeSlot:{workspaceId:actor.workspaceId,routeSlot:"BOOK_SYNTHESIS"}}})).modelId).toBe("glm-4.7-flashx");});
it("拒绝不兼容型号，删除后列表不再展示服务商且凭据被撤销",async()=>{const {connection,credential}=await fixture();expect((await post({action:"SET_ROUTE",connectionId:connection.id,routeSlot:"PODCAST_TTS",modelId:"not-a-speech-model",configuration:{}})).status).toBe(400);expect(await prisma.providerConnection.count({where:{workspaceId:actor.workspaceId}})).toBe(1);const response=await post({action:"DELETE_CONNECTION",connectionId:connection.id,expectedRouteSlots:[],expectedCredentialVersionId:credential.id});expect(response.status).toBe(200);expect((await response.json()).connections).toEqual([]);expect((await prisma.providerCredentialVersion.findUniqueOrThrow({where:{id:credential.id}})).status).toBe("REVOKED");});
async function bindCapabilities(connectionId: string) {
  for (const [routeSlot, modelId] of [["EMBEDDING", "embedding-3"], ["PODCAST_TTS", "glm-tts"]]) {
    const result = await post({ action:"SET_ROUTE", connectionId, routeSlot, modelId, configuration:{} });
    expect(result.status).toBe(200);
  }
}
it("一个服务商展示全部用途，重复保存不会新增服务商或改写原有绑定", async () => {
  const { connection } = await fixture();
  await bindCapabilities(connection.id);
  const before = await prisma.providerRouteBinding.findMany({ where: { workspaceId:actor.workspaceId }, orderBy:{routeSlot:"asc"} });
  for (let i=0;i<2;i++) await bindCapabilities(connection.id);
  expect(await prisma.providerConnection.count({ where:{workspaceId:actor.workspaceId} })).toBe(3);
  const body = await (await GET()).json();
  expect(body.connections).toHaveLength(1);
  expect(body.connections[0]).toMatchObject({ id:connection.id, displayName:"智谱", managedCapabilities:expect.arrayContaining(["向量检索","语音合成"]) });
  expect(body.routes.every((route: {connectionId:string})=>route.connectionId===connection.id)).toBe(true);
  const after = await prisma.providerRouteBinding.findMany({ where: { workspaceId:actor.workspaceId }, orderBy:{routeSlot:"asc"} });
  expect(after.map(route=>[route.id,route.connectionId,route.modelId])).toEqual(before.map(route=>[route.id,route.connectionId,route.modelId]));
});
it("兼容已产生的旧内部记录，不归并用户独立创建的同品牌服务商", async () => {
  const { connection } = await fixture();
  const repository = new ProviderGatewayRepository(prisma,testCipher());
  const legacy = await repository.createConnectionWithCredential(actor,{providerKey:"zhipu",protocol:"OPENAI_EMBEDDINGS",displayName:`智谱 GLM（向量 ${connection.id}）`,endpoint:"https://open.bigmodel.cn/api/paas/v4/embeddings",secret:"fixture-not-a-real-key"});
  await repository.setRoute(actor,{connectionId:legacy.connection.id,routeSlot:"EMBEDDING",modelId:"embedding-3"});
  await repository.createConnectionWithCredential(actor,{providerKey:"zhipu",protocol:"OPENAI_EMBEDDINGS",displayName:"独立的向量账户",endpoint:"https://open.bigmodel.cn/api/paas/v4/embeddings",secret:"another-fixture-key"});
  const before=await prisma.providerConnection.findMany({where:{workspaceId:actor.workspaceId},orderBy:{id:"asc"}});
  const response=await (await GET()).json();
  expect(response.connections.map((item:{displayName:string})=>item.displayName)).toEqual(["智谱","独立的向量账户"]);
  expect(response.routes[0].connectionId).toBe(connection.id);
  expect(await prisma.providerConnection.findMany({where:{workspaceId:actor.workspaceId},orderBy:{id:"asc"}})).toEqual(before);
  await bindCapabilities(connection.id);
  expect(await prisma.providerConnection.count({where:{workspaceId:actor.workspaceId}})).toBe(4);
});
it("更新密钥、停用、启用和撤销覆盖所有内部用途，历史快照保持不变", async () => {
  const { connection } = await fixture();
  await bindCapabilities(connection.id);
  const child = await prisma.providerConnection.findFirstOrThrow({where:{workspaceId:actor.workspaceId,protocol:"OPENAI_EMBEDDINGS"}});
  const key = await prisma.providerCredentialVersion.findFirstOrThrow({where:{connectionId:child.id,status:"ACTIVE"}});
  const snapshot=await prisma.providerExecutionSnapshot.create({data:{workspaceId:actor.workspaceId,routeSlot:"EMBEDDING",providerKey:"zhipu",protocol:child.protocol,modelId:"embedding-3",connectionId:child.id,credentialVersionId:key.id,capability:{},configurationHash:"fixture",adapterVersion:"fixture",correlationId:randomUUID()}});
  try {
    expect((await post({action:"SET_CREDENTIAL",connectionId:connection.id,secret:"replacement-fixture-key"})).status).toBe(200);
    const keys = await prisma.providerCredentialVersion.findMany({where:{workspaceId:actor.workspaceId,status:"ACTIVE"},include:{connection:true}});
    expect(keys).toHaveLength(3);
    for(const current of keys) expect(testCipher().decrypt(current,{workspaceId:actor.workspaceId,connectionId:current.connectionId,credentialVersionId:current.id,providerKey:current.connection.providerKey})).toBe("replacement-fixture-key");
    for(const enabled of [false,true]) {
      expect((await post({action:"SET_ENABLED",connectionId:connection.id,enabled})).status).toBe(200);
      expect(await prisma.providerConnection.count({where:{workspaceId:actor.workspaceId,status:enabled?"ACTIVE":"DISABLED"}})).toBe(3);
    }
    const parentKey=keys.find(current=>current.connectionId===connection.id)!;
    expect((await post({action:"REVOKE_CREDENTIAL",credentialVersionId:parentKey.id})).status).toBe(200);
    expect(await prisma.providerCredentialVersion.count({where:{workspaceId:actor.workspaceId,status:{not:"REVOKED"}}})).toBe(0);
    expect(await prisma.providerExecutionSnapshot.findUnique({where:{id:snapshot.id}})).toEqual(snapshot);
  } finally { await prisma.providerExecutionSnapshot.delete({where:{id:snapshot.id}}); }
});
it("删除确认包含内部用途，过期确认不写入，历史记录保持不变", async()=>{
  const {connection,credential}=await fixture();await bindCapabilities(connection.id);
  expect((await post({action:"DELETE_CONNECTION",connectionId:connection.id,expectedRouteSlots:[],expectedCredentialVersionId:credential.id})).status).toBe(409);
  expect(await prisma.providerRouteBinding.count({where:{workspaceId:actor.workspaceId}})).toBe(2);
  const request={action:"DELETE_CONNECTION",connectionId:connection.id,expectedRouteSlots:["EMBEDDING","PODCAST_TTS"],expectedCredentialVersionId:credential.id};
  expect((await post(request)).status).toBe(200);expect((await post(request)).status).toBe(200);
  expect((await (await GET()).json()).connections).toHaveLength(0);
  expect(await prisma.providerConnection.count({where:{workspaceId:actor.workspaceId,status:"REVOKED"}})).toBe(3);
  expect(await prisma.providerRouteBinding.count({where:{workspaceId:actor.workspaceId}})).toBe(0);
  expect(await prisma.providerCredentialVersion.count({where:{workspaceId:actor.workspaceId,status:"REVOKED"}})).toBe(3);
});
it("并发保存同一用途只创建一条内部记录，权限不足不能管理整组",async()=>{
 const {connection}=await fixture();const command={action:"SET_ROUTE",connectionId:connection.id,routeSlot:"EMBEDDING",modelId:"embedding-3",configuration:{}};
 const responses=await Promise.all([post(command),post(command)]);expect(responses.map(result=>result.status)).toEqual([200,200]);
 expect(await prisma.providerConnection.count({where:{workspaceId:actor.workspaceId}})).toBe(2);
 await prisma.workspaceMember.update({where:{workspaceId_userId:actor},data:{role:"VIEWER"}});
 expect((await post({action:"SET_ENABLED",connectionId:connection.id,enabled:false})).status).toBe(403);
 expect(await prisma.providerConnection.count({where:{workspaceId:actor.workspaceId,status:"ACTIVE"}})).toBe(2);
});
it.each(Object.entries(miniMaxSites))("MiniMax %s 验证同站点模型列表，保存时保留所选调用地址且不自动绑定用途", async(siteName,site)=>{
 await fixture();
 const remote=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({object:"list",data:[{id:"MiniMax-M3"}]}),{status:200}));
 try {
  const input={providerKey:"minimax",protocol:"OPENAI_COMPATIBLE",endpoint:site.endpoint,secret:"fixture-minimax-key"};
  const response=await post({action:"TEST_CONNECTION",...input});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({test:{state:"VALID"}});
  expect(remote).toHaveBeenCalledExactlyOnceWith(site.testEndpoint,expect.objectContaining({method:"GET",redirect:"error",headers:{authorization:"Bearer fixture-minimax-key"}}));
  remote.mockClear();
  const saved=await post({action:"CREATE_CONNECTION_WITH_CREDENTIAL",...input,displayName:`MiniMax ${siteName}`,configuration:{}});
  expect(saved.status).toBe(200);expect(remote).not.toHaveBeenCalled();
  const connection=await prisma.providerConnection.findFirstOrThrow({where:{workspaceId:actor.workspaceId,providerKey:"minimax"}});
  expect(connection.endpoint).toBe(site.endpoint);
  expect(await prisma.providerRouteBinding.count({where:{workspaceId:actor.workspaceId}})).toBe(0);
 } finally {remote.mockRestore();}
});
it.each(["https://api.minimax.cn.evil.test/v1/chat/completions","https://api.minimax.cn:8443/v1/chat/completions","https://api.minimax.cn/v1/chat/completions?key=fixture","https://api.minimax.cn/v1/unknown"])("不向非固定 MiniMax 地址发送密钥：%s",async endpoint=>{
 await fixture();const remote=vi.spyOn(globalThis,"fetch");try{const result=await post({action:"TEST_CONNECTION",providerKey:"minimax",protocol:"OPENAI_COMPATIBLE",endpoint,secret:"fixture-key"});expect(result.status).toBeGreaterThanOrEqual(400);expect(remote).not.toHaveBeenCalled();}finally{remote.mockRestore();}
});
it.each([[401,"AUTHENTICATION_FAILED",{}],[403,"AUTHENTICATION_FAILED",{}],[200,"INVALID_TEST_RESPONSE",{base_resp:{status_code:1004}}],[200,"INVALID_TEST_RESPONSE",{object:"list",data:[{}]}],[200,"INVALID_TEST_RESPONSE",null],[429,"PROVIDER_REJECTED",{}]] as const)("MiniMax HTTP %s 不会把异常响应当作验证成功：%s",async(status,state,body)=>{
 await fixture();const remote=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify(body),{status}));try{const result=await post({action:"TEST_CONNECTION",providerKey:"minimax",protocol:"OPENAI_COMPATIBLE",endpoint:miniMaxSites.CN.endpoint,secret:"fixture-key"});expect(await result.json()).toEqual({test:{state}});}finally{remote.mockRestore();}
});
it.each(["BEIJING", "SINGAPORE"])("百炼 %s 使用已校验的工作区专属目录接口验证，不生成内容或保存密钥",async qwenRegion=>{
 await fixture();const before=await prisma.providerConnection.count({where:{workspaceId:actor.workspaceId}});
 const host=`fixture-workspace.${qwenRegion==="BEIJING"?"cn-beijing":"ap-southeast-1"}.maas.aliyuncs.com`;
 const remote=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({success:true,output:{models:[{model:"qwen3.8-flash"}]}}),{status:200}));
 try{const result=await post({action:"TEST_CONNECTION",providerKey:"qwen",protocol:"OPENAI_COMPATIBLE",endpoint:`https://${host}/compatible-mode/v1/chat/completions`,secret:"fixture-key",configuration:{qwenRegion,qwenWorkspaceId:"fixture-workspace"}});expect(await result.json()).toEqual({test:{state:"VALID"}});expect(remote).toHaveBeenCalledExactlyOnceWith(`https://${host}/api/v1/models`,expect.objectContaining({method:"GET",redirect:"error",headers:{authorization:"Bearer fixture-key"}}));expect(await prisma.providerConnection.count({where:{workspaceId:actor.workspaceId}})).toBe(before);}finally{remote.mockRestore();}
});
it.each([{success:false,output:{models:[]}},{success:true,output:{models:[{}]}},{success:true},null])("百炼不把 HTTP 200 异常响应视为密钥通过：%j",async body=>{
 await fixture();const remote=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify(body),{status:200}));
 try{const result=await post({action:"TEST_CONNECTION",providerKey:"qwen",protocol:"OPENAI_COMPATIBLE",endpoint:"https://fixture-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",secret:"fixture-key",configuration:{qwenRegion:"BEIJING",qwenWorkspaceId:"fixture-workspace"}});expect(await result.json()).toEqual({test:{state:"INVALID_TEST_RESPONSE"}});}finally{remote.mockRestore();}
});
it.each([{}, {qwenRegion:"BEIJING",qwenWorkspaceId:"bad/workspace"}, {qwenRegion:"BEIJING",qwenWorkspaceId:"other-workspace"}])("百炼配置缺失或地址不匹配时不发送密钥：%j",async configuration=>{
 await fixture();const remote=vi.spyOn(globalThis,"fetch");try{const result=await post({action:"TEST_CONNECTION",providerKey:"qwen",protocol:"OPENAI_COMPATIBLE",endpoint:"https://fixture-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",secret:"fixture-key",configuration});expect(result.status).toBe(400);expect(remote).not.toHaveBeenCalled();}finally{remote.mockRestore();}
});
it("理解验证的可选模型与保存使用同一能力门禁，普通文本型号不会出现在候选中",async()=>{
 const {connection}=await fixture();
 const repository=new ProviderGatewayRepository(prisma,testCipher());
 const openai=await repository.createConnectionWithCredential(actor,{providerKey:"openai",protocol:"OPENAI_RESPONSES",displayName:"严格结构化服务",endpoint:"https://api.openai.com/v1/responses",secret:"fixture-key"});
 const minimax=await repository.createConnectionWithCredential(actor,{providerKey:"minimax",protocol:"OPENAI_COMPATIBLE",displayName:"MiniMax",endpoint:miniMaxSites.CN.endpoint,secret:"fixture-key"});
 const response=await (await GET()).json();
 expect(response.routeModels[connection.id].TEACH_BACK_ASSESSMENT).toEqual([]);
 expect(response.routeModels[minimax.connection.id].TEACH_BACK_ASSESSMENT).toEqual([]);
 expect(response.routeModels[minimax.connection.id].BOOK_CHUNK_ANALYSIS.map((model:{modelId:string})=>model.modelId)).toContain("MiniMax-M3");
 const compatible=response.routeModels[openai.connection.id].TEACH_BACK_ASSESSMENT;
 expect(compatible.length).toBeGreaterThan(0);expect(compatible.every((model:{structuredOutput:string})=>model.structuredOutput==="STRICT_JSON_SCHEMA")).toBe(true);
 const rejected=await post({action:"SET_ROUTE",connectionId:minimax.connection.id,routeSlot:"TEACH_BACK_ASSESSMENT",modelId:"MiniMax-M3",configuration:{}});
 expect(rejected.status).toBe(400);
 expect(await prisma.providerRouteBinding.count({where:{workspaceId:actor.workspaceId,routeSlot:"TEACH_BACK_ASSESSMENT"}})).toBe(0);
 const accepted=await post({action:"SET_ROUTE",connectionId:openai.connection.id,routeSlot:"TEACH_BACK_ASSESSMENT",modelId:compatible[0].modelId,configuration:{}});
 expect(accepted.status).toBe(200);
 expect((await prisma.providerRouteBinding.findUniqueOrThrow({where:{workspaceId_routeSlot:{workspaceId:actor.workspaceId,routeSlot:"TEACH_BACK_ASSESSMENT"}}})).modelId).toBe(compatible[0].modelId);
});
it("百炼用途继承服务商配置，切换服务商和向量维度不污染历史快照",async()=>{
 await fixture();const repository=new ProviderGatewayRepository(prisma,testCipher());
 const configuration={qwenRegion:"BEIJING",qwenWorkspaceId:"first-workspace"};
 const {connection,credential}=await repository.createConnectionWithCredential(actor,{providerKey:"qwen",protocol:"OPENAI_COMPATIBLE",displayName:"北京百炼",endpoint:"https://first-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",configuration,secret:"fixture-key"});
 const snapshot=await prisma.providerExecutionSnapshot.create({data:{workspaceId:actor.workspaceId,routeSlot:"BOOK_SYNTHESIS",providerKey:"qwen",protocol:"OPENAI_COMPATIBLE",modelId:"qwen-plus",connectionId:connection.id,credentialVersionId:credential.id,capability:{modelId:"qwen-plus"},configurationHash:"unchanged-history",adapterVersion:"builtin-v1",correlationId:randomUUID()}});
 const remote=vi.spyOn(globalThis,"fetch");try{
  expect((await post({action:"SET_ROUTE",connectionId:connection.id,routeSlot:"TEACH_BACK_ASSESSMENT",modelId:"qwen3.8-flash",configuration:{qwenRegion:"SINGAPORE",qwenWorkspaceId:"stale-or-forged",customOption:true}})).status).toBe(200);
  expect((await prisma.providerRouteBinding.findUniqueOrThrow({where:{workspaceId_routeSlot:{workspaceId:actor.workspaceId,routeSlot:"TEACH_BACK_ASSESSMENT"}}})).configuration).toEqual({...configuration,customOption:true});
  expect((await post({action:"SET_ROUTE",connectionId:connection.id,routeSlot:"EMBEDDING",modelId:"text-embedding-v4",configuration:{embeddingDimensions:512}})).status).toBe(200);
  expect((await prisma.providerRouteBinding.findUniqueOrThrow({where:{workspaceId_routeSlot:{workspaceId:actor.workspaceId,routeSlot:"EMBEDDING"}}})).configuration).toEqual({...configuration,embeddingDimensions:512});
  expect((await post({action:"APPLY_STABLE_BOOK_ROUTES",textConnectionId:connection.id,textModelId:"qwen3.8-flash",textConfiguration:{},embeddingConnectionId:connection.id,embeddingModelId:"text-embedding-v4",embeddingConfiguration:{embeddingDimensions:512}})).status).toBe(200);
  const bookRoutes=await prisma.providerRouteBinding.findMany({where:{workspaceId:actor.workspaceId,routeSlot:{in:["BOOK_CHUNK_ANALYSIS","BOOK_REDUCTION_ANALYSIS","BOOK_SYNTHESIS"]}}});expect(bookRoutes).toHaveLength(3);for(const route of bookRoutes)expect(route.configuration).toEqual(configuration);
  const {connection:second}=await repository.createConnectionWithCredential(actor,{providerKey:"qwen",protocol:"OPENAI_COMPATIBLE",displayName:"新加坡百炼",endpoint:"https://second-workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",configuration:{qwenRegion:"SINGAPORE",qwenWorkspaceId:"second-workspace"},secret:"fixture-key"});
  expect((await post({action:"SET_ROUTE",connectionId:second.id,routeSlot:"TEACH_BACK_ASSESSMENT",modelId:"qwen3.8-flash",configuration})).status).toBe(200);
  expect((await prisma.providerRouteBinding.findUniqueOrThrow({where:{workspaceId_routeSlot:{workspaceId:actor.workspaceId,routeSlot:"TEACH_BACK_ASSESSMENT"}}})).configuration).toEqual({qwenRegion:"SINGAPORE",qwenWorkspaceId:"second-workspace"});
  expect(await prisma.providerExecutionSnapshot.findUniqueOrThrow({where:{id:snapshot.id}})).toEqual(snapshot);expect(remote).not.toHaveBeenCalled();
 }finally{remote.mockRestore();await prisma.providerExecutionSnapshot.delete({where:{id:snapshot.id}});}
});
it("百炼服务商缺少有效区域配置时阻止保存用途，不借用客户端工作区",async()=>{
 await fixture();const repository=new ProviderGatewayRepository(prisma,testCipher());
 const {connection}=await repository.createConnectionWithCredential(actor,{providerKey:"qwen",protocol:"OPENAI_COMPATIBLE",displayName:"旧百炼配置",endpoint:"https://missing.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",secret:"fixture-key"});
 expect((await post({action:"SET_ROUTE",connectionId:connection.id,routeSlot:"TEACH_BACK_ASSESSMENT",modelId:"qwen3.8-flash",configuration:{qwenRegion:"BEIJING",qwenWorkspaceId:"missing"}})).status).toBe(400);
 expect(await prisma.providerRouteBinding.count({where:{workspaceId:actor.workspaceId}})).toBe(0);
});
it("百炼国内型号可配置理解验证，旧 JSON 模式型号不冒充严格输出",async()=>{
 await fixture();const repository=new ProviderGatewayRepository(prisma,testCipher());
 const configuration={qwenRegion:"BEIJING",qwenWorkspaceId:"acceptance"};
 const {connection}=await repository.createConnectionWithCredential(actor,{providerKey:"qwen",protocol:"OPENAI_COMPATIBLE",displayName:"百炼国内验收",endpoint:"https://acceptance.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",configuration,secret:"fixture-key"});
 const body=await (await GET()).json();expect(body.routeModels[connection.id].TEACH_BACK_ASSESSMENT.map((item:{modelId:string})=>item.modelId)).toEqual(["qwen3.8-flash","qwen3.8-max","qwen3.7-plus"]);
 const remote=vi.spyOn(globalThis,"fetch");try{expect((await post({action:"SET_ROUTE",connectionId:connection.id,routeSlot:"TEACH_BACK_ASSESSMENT",modelId:"qwen3.8-flash",configuration})).status).toBe(200);expect(remote).not.toHaveBeenCalled();}finally{remote.mockRestore();}
 expect(await prisma.providerInvocation.count({where:{workspaceId:actor.workspaceId}})).toBe(0);
});
it("更新候选不覆盖历史型号绑定或冻结快照，停服型号仅阻断新配置",async()=>{
 await fixture();const repository=new ProviderGatewayRepository(prisma,testCipher());
 const {connection,credential}=await repository.createConnectionWithCredential(actor,{providerKey:"gemini",protocol:"GEMINI_NATIVE",displayName:"历史配置",endpoint:"https://generativelanguage.googleapis.com/v1beta",secret:"fixture-key"});
 const route=await repository.setRoute(actor,{connectionId:connection.id,routeSlot:"TEACH_BACK_ASSESSMENT",modelId:"gemini-2.0-flash"});
 const snapshot=await prisma.providerExecutionSnapshot.create({data:{workspaceId:actor.workspaceId,routeSlot:"TEACH_BACK_ASSESSMENT",providerKey:"gemini",protocol:"GEMINI_NATIVE",modelId:"gemini-2.0-flash",connectionId:connection.id,credentialVersionId:credential.id,capability:{modelId:"gemini-2.0-flash",structuredOutput:"STRICT_JSON_SCHEMA"},configurationHash:"historic-fixture",adapterVersion:"historic-fixture",correlationId:randomUUID()}});
 try{const body=await (await GET()).json();expect(body.routeModels[connection.id].TEACH_BACK_ASSESSMENT.map((item:{modelId:string})=>item.modelId)).toEqual(["gemini-3.8-flash"]);expect(body.readiness.mastery.state).toBe("INCOMPLETE");expect((await post({action:"SET_ROUTE",connectionId:connection.id,routeSlot:"TEACH_BACK_ASSESSMENT",modelId:"gemini-2.0-flash",configuration:{}})).status).toBe(400);expect(await prisma.providerRouteBinding.findUnique({where:{id:route.id}})).toEqual(route);expect(await prisma.providerExecutionSnapshot.findUnique({where:{id:snapshot.id}})).toEqual(snapshot);}finally{await prisma.providerExecutionSnapshot.delete({where:{id:snapshot.id}});}
});
