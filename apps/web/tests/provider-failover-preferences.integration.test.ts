import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { ProviderGatewayRepository, testCipher } from "@ai-cognitive/provider-gateway";
import { GET, POST } from "../app/api/studio/providers/route";

let actor: {workspaceId: string; userId: string};
vi.mock("@/lib/identity", () => ({ resolveWebIdentity: async () => actor }));
vi.mock("@ai-cognitive/provider-gateway", async original => {
  const mod = await original<typeof import("@ai-cognitive/provider-gateway")>();
  return { ...mod, resolveCredentialKeyring: () => mod.testCipher() };
});

const owned: {workspaceId:string;userId:string}[] = [];
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID();
  actor={workspaceId,userId};owned.push(actor);
  await prisma.user.create({data:{id:userId,email:userId+"@failover-preferences.test"}});
  await prisma.workspace.create({data:{id:workspaceId,name:"Failover intent only"}});
  await prisma.workspaceMember.create({data:{workspaceId,userId,role:"OWNER"}});
  const store=new ProviderGatewayRepository(prisma,testCipher());
  const zhipu=await store.createConnectionWithCredential(actor,{
    providerKey:"zhipu",protocol:"OPENAI_COMPATIBLE",displayName:"智谱主模型",
    endpoint:"https://open.bigmodel.cn/api/paas/v4/chat/completions",secret:"not-a-real-key",
  });
  const minimax=await store.createConnectionWithCredential(actor,{
    providerKey:"minimax",protocol:"OPENAI_COMPATIBLE",displayName:"MiniMax 备用",
    endpoint:"https://api.minimax.io/v1/text/chatcompletion_v2",secret:"not-a-real-key",
  });
  const deepseek=await store.createConnectionWithCredential(actor,{
    providerKey:"deepseek",protocol:"OPENAI_COMPATIBLE",displayName:"DeepSeek 备用",
    endpoint:"https://api.deepseek.com/chat/completions",secret:"not-a-real-key",
  });
  await store.setRoute(actor,{
    routeSlot:"BOOK_CHUNK_ANALYSIS",connectionId:zhipu.connection.id,modelId:"glm-5.3-flash",
  });
  const backups=[{connectionId:minimax.connection.id,modelId:"MiniMax-M3",configuration:{}},
    {connectionId:deepseek.connection.id,modelId:"deepseek-v4-flash",configuration:{}}];
  return {store,zhipu,minimax,deepseek,backups};
}
const post=(body:unknown)=>POST(new Request("http://localhost/api/studio/providers",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
}));
afterEach(async()=>{
  for(const {workspaceId,userId} of owned.splice(0)){
    await prisma.providerFailoverPreference.deleteMany({where:{workspaceId}});
    await prisma.providerRouteBinding.deleteMany({where:{workspaceId}});
    await prisma.providerCredentialVersion.deleteMany({where:{workspaceId}});
    await prisma.providerConnection.deleteMany({where:{workspaceId}});
    await prisma.providerAuditEvent.deleteMany({where:{workspaceId}});
    await prisma.workspaceMember.deleteMany({where:{workspaceId}});
    await prisma.workspace.delete({where:{id:workspaceId}});
    await prisma.user.delete({where:{id:userId}});
  }
});

describe("owner-configured cross-workflow fallback intent (no provider execution)",()=>{
  it("stores ordered backup chains, revision/CAS and audit without changing the primary route or calling paid providers",async()=>{
    const {backups,zhipu}=await fixture();
    const before=(await GET());
    expect(before.status).toBe(200);
    expect((await before.json()).failoverPreferences).toEqual([]);
    const remote=vi.spyOn(globalThis,"fetch");
    try {
      const created=await post({
        action:"SET_FAILOVER_PREFERENCE",routeSlot:"BOOK_CHUNK_ANALYSIS",
        requestedEnabled:true,maxSwitches:2,candidates:backups,expectedRevision:null,
      });
      expect(created.status).toBe(200);
      const body=await created.json();
      expect(body.failoverPreferences).toHaveLength(1);
      expect(body.failoverPreferences[0]).toMatchObject({
        routeSlot:"BOOK_CHUNK_ANALYSIS",requestedEnabled:true,maxSwitches:2,
        candidates:backups,revision:1,executionEnabled:false,
      });
      expect(body.failoverPreferences[0].preferenceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(body.failoverChoices).toEqual(expect.arrayContaining([
        expect.objectContaining({routeSlot:"BOOK_CHUNK_ANALYSIS",modelId:"MiniMax-M3"}),
      ]));
      expect((await prisma.providerRouteBinding.findUniqueOrThrow({
        where:{workspaceId_routeSlot:{workspaceId:actor.workspaceId,routeSlot:"BOOK_CHUNK_ANALYSIS"}},
      })).connectionId).toBe(zhipu.connection.id);
      expect(await prisma.providerInvocation.count({where:{workspaceId:actor.workspaceId}})).toBe(0);
      expect(remote).not.toHaveBeenCalled();
      expect(await prisma.providerAuditEvent.count({
        where:{workspaceId:actor.workspaceId,targetType:"ProviderFailoverPreference"},
      })).toBe(1);

      const stale=await post({action:"SET_FAILOVER_PREFERENCE",routeSlot:"BOOK_CHUNK_ANALYSIS",
        requestedEnabled:false,maxSwitches:1,candidates:backups.slice(0,1),expectedRevision:null});
      expect(stale.status).toBe(409);
      expect((await stale.json()).error).toBe("PROVIDER_CONNECTION_CHANGED");
      const updated=await post({action:"SET_FAILOVER_PREFERENCE",routeSlot:"BOOK_CHUNK_ANALYSIS",
        requestedEnabled:false,maxSwitches:1,candidates:backups.slice(0,1),expectedRevision:1});
      expect(updated.status).toBe(200);
      expect((await updated.json()).failoverPreferences[0]).toMatchObject({
        requestedEnabled:false,revision:2,executionEnabled:false,
      });
      expect(remote).not.toHaveBeenCalled();
    } finally { remote.mockRestore(); }
  });

  it("rejects a primary-model duplicate, unsupported model and malformed backup list without mutating state",async()=>{
    const {backups,zhipu}=await fixture();
    const invalid=[
      {candidates:[{connectionId:zhipu.connection.id,modelId:"glm-5.3-flash",configuration:{}}]},
      {candidates:[{...backups[0]!,modelId:"not-a-real-model"}]},
      {candidates:[backups[0]!,backups[0]!] },
      {candidates:backups,maxSwitches:3},
      {candidates:backups,maxSwitches:2,expectedRevision:5},
      {candidates:[{...backups[0]!,configuration:{api_key:"exfiltrate"}}]},
    ];
    for(const override of invalid){
      const response=await post({
        action:"SET_FAILOVER_PREFERENCE",routeSlot:"BOOK_CHUNK_ANALYSIS",
        requestedEnabled:true,maxSwitches:1,expectedRevision:null,candidates:backups.slice(0,1),
        ...override,
      });
      expect(response.ok).toBe(false);
    }
    expect(await prisma.providerFailoverPreference.count({where:{workspaceId:actor.workspaceId}})).toBe(0);
  });

  it("requires active credentials and keeps workspace owners in control",async()=>{
    const {backups,minimax,store}=await fixture();
    await store.setConnectionEnabled(actor,minimax.connection.id,false);
    const disabled=await post({action:"SET_FAILOVER_PREFERENCE",routeSlot:"BOOK_CHUNK_ANALYSIS",
      requestedEnabled:true,maxSwitches:1,candidates:backups.slice(0,1),expectedRevision:null});
    expect(disabled.status).toBe(400);
    expect((await disabled.json()).error).toBe("CONNECTION_DISABLED");
    await store.setConnectionEnabled(actor,minimax.connection.id,true);
    const viewer=randomUUID();
    await prisma.user.create({data:{id:viewer,email:viewer+"@failover-preferences.test"}});
    await prisma.workspaceMember.create({data:{workspaceId:actor.workspaceId,userId:viewer,role:"VIEWER"}});
    try {
      actor={workspaceId:actor.workspaceId,userId:viewer};
      const forbidden=await post({action:"SET_FAILOVER_PREFERENCE",routeSlot:"BOOK_CHUNK_ANALYSIS",
        requestedEnabled:true,maxSwitches:1,candidates:backups.slice(0,1),expectedRevision:null});
      expect(forbidden.status).toBe(403);
      expect((await forbidden.json()).error).toBe("AUTHORIZATION_FAILED");
      expect(await prisma.providerFailoverPreference.count({where:{workspaceId:actor.workspaceId}})).toBe(0);
    } finally {
      await prisma.workspaceMember.delete({where:{workspaceId_userId:{workspaceId:actor.workspaceId,userId:viewer}}});
      await prisma.user.delete({where:{id:viewer}});
    }
  });

  it("validates strict JSON schema for Teach Back and keeps feature-specific routes distinct",async()=>{
    const {backups,zhipu}=await fixture();
    const bad=await post({action:"SET_FAILOVER_PREFERENCE",routeSlot:"TEACH_BACK_ASSESSMENT",
      requestedEnabled:true,maxSwitches:1,candidates:backups.slice(0,1),expectedRevision:null});
    expect(bad.status).toBe(400);
    const good=await post({action:"SET_FAILOVER_PREFERENCE",routeSlot:"TEACH_BACK_ASSESSMENT",
      requestedEnabled:false,maxSwitches:1,
      candidates:[{connectionId:zhipu.connection.id,modelId:"glm-4.7-flash",configuration:{}}],
      expectedRevision:null});
    expect(good.status).toBe(400); // JSON_MODE is deliberately not STRICT_JSON_SCHEMA
  });
});
