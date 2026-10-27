import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  builtInProviderCatalog, canonicalGatewayRequestFingerprint, canonicalTextInputHash,
  createGatewayPdfVisualExecutor, createProviderAdapterResolver, createTestProviderGateway,
  DeterministicProviderHttpTransport, ProviderRegistry, sourceDataPolicy, stableHash,
  validatePdfVisionImage, validateRouteManifestSelection,
} from "../src/index.js";
import type { GatewayRequest, ResolvedRoute } from "../src/index.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
const sha=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex");
const capability={modelId:"glm-4.6v",families:["TEXT_GENERATION"] as const,confidence:"EXPERIMENTAL" as const,structuredOutput:"JSON_MODE" as const,visionInput:true};
const route:ResolvedRoute={source:"WORKSPACE",providerKey:"zhipu",protocol:"OPENAI_COMPATIBLE",modelId:"glm-4.6v",adapterVersion:"builtin-v1",connectionId:"connection",credentialVersionId:"version",capability,configuration:{}};
const image=()=>({physicalPageIndex:4,sourceSha256:"a".repeat(64),pngSha256:sha(png),pngBytes:new Uint8Array(png),width:1,height:1});
const graph={schemaVersion:1,figures:[{id:"f",kind:"DIAGRAM",bbox:[1,2,100,100],caption:"",nodes:[{id:"a",label:"A"},{id:"b",label:"B"}],edges:[{from:"a",to:"b",label:"connect",direction:"DIRECTED"}]}]};
function fixture(options:{authorized?:boolean;selected?:ResolvedRoute;reply?:string}={}) {
  const registry=new ProviderRegistry();
  const def=builtInProviderCatalog.providers.find(p=>p.providerKey==="zhipu")!;
  registry.register(def);
  const authorize=vi.fn(async()=>{if(options.authorized===false)throw Error("DENIED");});
  const beforeAttempt=vi.fn(async()=>({credential:"test-secret"}));
  const transport=new DeterministicProviderHttpTransport(async request=>({
    status:200,headers:{"x-request-id":"fixture"},
    body:JSON.stringify({model:"glm-4.6v",choices:[{message:{content:options.reply??JSON.stringify(graph)},finish_reason:"stop"}]})
  }));
  const gateway=createTestProviderGateway(registry,
    {resolveWorkspaceRoute:async()=>options.selected??route},
    {resolve:async()=>undefined},
    createProviderAdapterResolver(transport),
    {authorize, beforeAttempt});
  return {gateway,transport,authorize,beforeAttempt};
}
const settings=(gateway:ReturnType<typeof fixture>["gateway"])=>({gateway,workspaceId:"w",userId:"u",sourceDocumentId:"book",ingestionRunId:"run"});
describe("PDF visual images through Workspace Provider Gateway",()=>{
  it("uses the authenticated workspace route and fixed model endpoint for real PNG data",async()=>{
    const f=fixture();
    const executor=createGatewayPdfVisualExecutor(settings(f.gateway));
    await expect(executor.inspect(image())).resolves.toEqual(graph);
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.beforeAttempt).toHaveBeenCalledTimes(1);
    expect(f.transport.calls).toHaveLength(1);
    const call=f.transport.calls[0]!;
    expect(call.url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(call.headers.authorization).toBe("Bearer test-secret");
    const body=JSON.parse(call.body);
    expect(body.model).toBe("glm-4.6v");
    const user=body.messages.find((m:{role:string})=>m.role==="user");
    expect(user.content[1]).toEqual({type:"image_url",image_url:{url:"data:image/png;base64,"+png.toString("base64")}});
    expect(body.response_format).toEqual({type:"json_object"});
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });

  it("enforces membership before any provider request",async()=>{
    const f=fixture({authorized:false});
    await expect(createGatewayPdfVisualExecutor(settings(f.gateway)).inspect(image())).rejects.toThrow();
    expect(f.transport.calls).toHaveLength(0);
    expect(f.beforeAttempt).not.toHaveBeenCalled();
  });

  it("refuses text-only model, custom provider and unapproved runtime claims",async()=>{
    for(const selected of [
      {...route,modelId:"glm-4-flash",capability:{...capability,modelId:"glm-4-flash",visionInput:false}},
      {...route,providerKey:"openai-compatible"},
      {...route,capability:{...capability,visionInput:false}},
    ]){
      const f=fixture({selected});
      await expect(createGatewayPdfVisualExecutor(settings(f.gateway)).inspect(image())).rejects.toThrow();
      expect(f.transport.calls).toHaveLength(0);
    }
    expect(()=>validateRouteManifestSelection(builtInProviderCatalog,
      {routeSlot:"PDF_VISUAL_STRUCTURE",providerKey:"zhipu",protocol:"OPENAI_COMPATIBLE",modelId:"glm-4-flash"})).toThrow();
    expect(validateRouteManifestSelection(builtInProviderCatalog,
      {routeSlot:"PDF_VISUAL_STRUCTURE",providerKey:"zhipu",protocol:"OPENAI_COMPATIBLE",modelId:"glm-4.6v"}).visionInput).toBe(true);
  });

  it("refuses malicious image bounds, wrong SHA, byte budgets and absent opt-in",async()=>{
    const f=fixture(); const executor=createGatewayPdfVisualExecutor(settings(f.gateway));
    await expect(executor.inspect({...image(),pngSha256:"0".repeat(64)})).rejects.toThrow();
    await expect(executor.inspect({...image(),width:10000})).rejects.toThrow();
    const small=createGatewayPdfVisualExecutor({...settings(f.gateway),maxImageBytes:45});
    await expect(small.inspect(image())).rejects.toThrow();
    expect(f.transport.calls).toHaveLength(0);
    expect(()=>validatePdfVisionImage({...{
      mediaType:"image/png",dataBase64:png.toString("base64"),
      sha256:sha(png),sourceSha256:"a".repeat(64),physicalPageIndex:0,
    },goldApproved:true})).toThrow();
  });

  it("does not accept image contents on ordinary text routes",async()=>{
    const f=fixture();
    const request:GatewayRequest={
      workspaceId:"w",routeSlot:"BOOK_CHUNK_ANALYSIS",correlationId:"c",idempotencyKey:"key",
      inputHash:"a".repeat(64),capability:{family:"TEXT_GENERATION",structuredOutput:"JSON_MODE"},
      text:{messages:[{role:"user",content:"x",image:{
        mediaType:"image/png",dataBase64:png.toString("base64"),sha256:sha(png),
        sourceSha256:"a".repeat(64),physicalPageIndex:0}}],structuredOutput:{mode:"JSON_MODE"}}
    };
    await expect(f.gateway.execute(request,{userId:"u"})).rejects.toThrow();
    expect(f.transport.calls).toHaveLength(0);
  });

  it("fingerprints image source identity, not megabytes of private base64",()=>{
    const obj={system:"vision",messages:[{role:"user" as const,content:"graph",image:{
      mediaType:"image/png" as const,dataBase64:png.toString("base64"),sha256:sha(png),
      sourceSha256:"a".repeat(64),physicalPageIndex:4
    }}]};
    const digest=canonicalTextInputHash(obj);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(png.toString("base64"));
    expect(canonicalTextInputHash({...obj,messages:[{...obj.messages[0],image:{...obj.messages[0].image,physicalPageIndex:5}}]})).not.toBe(digest);
  });

  it("returns fail-closed for a provider's malformed structured graph JSON",async()=>{
    const f=fixture({reply:"not-json"});
    await expect(createGatewayPdfVisualExecutor(settings(f.gateway)).inspect(image())).rejects.toThrow();
    expect(f.transport.calls).toHaveLength(1);
  });
});
