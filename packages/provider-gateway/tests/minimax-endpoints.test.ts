import { describe, expect, it } from "vitest";
import { approvedProfile } from "../src/adapters/provider-profiles.js";
import { DeterministicProviderHttpTransport, OpenAICompatibleAdapter, type AdapterRequest, type ExecutionSnapshot } from "../src/index.js";
const endpoints=["https://api.minimax.cn/v1/chat/completions","https://api.minimax.io/v1/text/chatcompletion_v2"];
describe("MiniMax 站点与冻结端点兼容",()=>{
 it.each(endpoints)("使用所选站点执行，保留结构化门禁和冻结快照：%s",async endpoint=>{
  const wire=new DeterministicProviderHttpTransport(()=>({status:200,headers:{},body:JSON.stringify({model:"MiniMax-M3",choices:[{finish_reason:"stop",message:{content:'{"answer":"ok"}'}}],usage:{prompt_tokens:2,completion_tokens:4}})}));
  const snapshot={id:"fixture",workspaceId:"fixture",routeSlot:"BOOK_CHUNK_ANALYSIS",correlationId:"fixture",source:"WORKSPACE",providerKey:"minimax",protocol:"OPENAI_COMPATIBLE",modelId:"MiniMax-M3",adapterVersion:"fixture",capability:{modelId:"MiniMax-M3",families:["TEXT_GENERATION"],confidence:"DECLARED",structuredOutput:"JSON_MODE"},configuration:{},configurationHash:"fixture",createdAt:new Date(),endpoint} as ExecutionSnapshot;
  const request={workspaceId:"fixture",routeSlot:"BOOK_CHUNK_ANALYSIS",correlationId:"fixture",idempotencyKey:"fixture",inputHash:"a".repeat(64),capability:{family:"TEXT_GENERATION",structuredOutput:"JSON_MODE"},requestFingerprint:"fixture",text:{messages:[{role:"user",content:"fixture"}],structuredOutput:{mode:"JSON_MODE"}}} as AdapterRequest;
  const before=structuredClone(snapshot);const result=await new OpenAICompatibleAdapter(wire).execute({snapshot,request,credential:"fixture-not-a-real-key",signal:new AbortController().signal});
  expect(wire.calls).toHaveLength(1);expect(wire.calls[0]!.url).toBe(endpoint);expect(result.response).toMatchObject({structured:{answer:"ok"}});expect(snapshot).toEqual(before);
 });
 it("未指定端点时仍保持原有国际站默认值",()=>{expect(approvedProfile("minimax","TEXT_GENERATION",undefined)?.endpoint).toBe(endpoints[1]);});
 it.each(["https://api.minimax.cn.evil.test/v1/chat/completions","https://api.minimax.cn:8443/v1/chat/completions","https://api.minimax.cn/v1/chat/completions?key=x","https://api.minimax.io/v1/unknown"])("不放宽非批准地址：%s",endpoint=>{expect(approvedProfile("minimax","TEXT_GENERATION",endpoint)).toBeUndefined();});
});
