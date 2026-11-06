import { afterEach, expect, it, vi } from "vitest";
import { createTestProviderGateway, ProviderRegistry, canonicalTextInputHash, type GatewayRequest, type GatewayExecutionDependencies } from "@ai-cognitive/provider-gateway";
import { bookProviderExecutionPolicy, bookProviderGeneration, bookProviderLeaseMs } from "../src/book-provider-execution-policy.js";

afterEach(()=>vi.useRealTimers());
it("M3 书籍生成具有所有书籍阶段统一的 32000 总输出额度，进入请求指纹且不改变源文",()=>{
  const text={messages:[{role:"user" as const,content:"原文与引用范围保持不变"}]};
  const generation=bookProviderGeneration({providerKey:"minimax",modelId:"MiniMax-M3"});expect(generation).toEqual({maxOutputTokens:32000});
  expect(canonicalTextInputHash({...text,generation})).not.toBe(canonicalTextInputHash(text));expect(text.messages[0]!.content).toBe("原文与引用范围保持不变");
  expect(bookProviderGeneration({providerKey:"zhipu",modelId:"glm-4.7-flashx"})).toBeUndefined();expect(bookProviderGeneration({providerKey:"minimax",modelId:"MiniMax-M2.5"})).toBeUndefined();
});
function fixture(delay: number, overrides: GatewayExecutionDependencies = {}, modelId = "MiniMax-M3", slot: GatewayRequest["routeSlot"] = "BOOK_CHUNK_ANALYSIS") {
  const capability={modelId,families:["TEXT_GENERATION"] as const,confidence:"VERIFIED" as const,structuredOutput:"JSON_MODE" as const};
  const registry=new ProviderRegistry();registry.register({providerKey:"minimax",displayName:"MiniMax",protocol:"TEST",adapterVersion:"test",models:[capability]});
  const text={system:"Return JSON",messages:[{role:"user" as const,content:"Test source"}],structuredOutput:{mode:"JSON_MODE" as const}};
  const request:GatewayRequest={workspaceId:"fixture",routeSlot:slot,correlationId:"fixture",idempotencyKey:"fixture",inputHash:canonicalTextInputHash(text),capability:{family:"TEXT_GENERATION",structuredOutput:"JSON_MODE"},text};
  const execute=vi.fn(({signal}:{signal:AbortSignal})=>new Promise<{response:{ok:boolean}}>((resolve,reject)=>{const timer=setTimeout(()=>resolve({response:{ok:true}}),delay);signal.addEventListener("abort",()=>{clearTimeout(timer);reject(new DOMException("aborted","AbortError"));},{once:true});}));
  const acquire=vi.fn(async()=>({key:"fixture",token:"fixture"}));
  const gateway=createTestProviderGateway(registry,{resolveWorkspaceRoute:async()=>({source:"PLATFORM",providerKey:"minimax",protocol:"TEST",modelId,adapterVersion:"test",capability,configuration:{}})},{resolve:async()=>undefined},()=>({execute}),{requestExecutionPolicy:bookProviderExecutionPolicy,concurrency:{acquire,release:async()=>true},...overrides});
  return {gateway,request,execute,acquire};
}
it("M3 书籍请求可等待超过 30 秒并保持足够并发租约，不改变请求",async()=>{
  vi.useFakeTimers();const f=fixture(45_000),before=structuredClone(f.request);const done=expect(f.gateway.execute(f.request,{userId:"fixture"})).resolves.toMatchObject({status:"SUCCEEDED",attempt:1});await vi.advanceTimersByTimeAsync(45_000);await done;expect(f.execute).toHaveBeenCalledTimes(1);expect(f.acquire).toHaveBeenCalledWith(expect.any(String),4,601_000);expect(f.request).toEqual(before);
});
it("M3 达到 600 秒时停止且不发起第二次请求",async()=>{
  vi.useFakeTimers();const f=fixture(601_000);const done=expect(f.gateway.execute(f.request,{userId:"fixture"})).rejects.toMatchObject({code:"TIMEOUT"});await vi.advanceTimersByTimeAsync(600_000);await done;expect(f.execute).toHaveBeenCalledTimes(1);
});
it("显式更短的操作时限和取消信号继续有效",async()=>{
  vi.useFakeTimers();const f=fixture(45_000,{timeoutMs:10_000,maxAttempts:1});const done=expect(f.gateway.execute(f.request,{userId:"fixture"})).rejects.toMatchObject({code:"TIMEOUT"});await vi.advanceTimersByTimeAsync(10_000);await done;expect(f.execute).toHaveBeenCalledTimes(1);
  const other=fixture(45_000),controller=new AbortController();other.request.signal=controller.signal;const cancelled=expect(other.gateway.execute(other.request,{userId:"fixture"})).rejects.toMatchObject({code:"CANCELLED"});await vi.advanceTimersByTimeAsync(100);controller.abort();await cancelled;expect(other.execute).toHaveBeenCalledTimes(1);
});
it.each(["BOOK_CHUNK_ANALYSIS","BOOK_REDUCTION_ANALYSIS","BOOK_SYNTHESIS"] as const)("仅针对 M3 书籍阶段启用新策略：%s",async slot=>{
  const f=fixture(1,{},"MiniMax-M3",slot);expect(bookProviderExecutionPolicy(await f.gateway.resolveSnapshot(f.request),f.request)).toEqual({timeoutMs:600_000,maxAttempts:1});
});
it.each([["MiniMax-M3","PODCAST_SCRIPT"],["MiniMax-M2.5","BOOK_CHUNK_ANALYSIS"]] as const)("其他用途和型号沿用原策略：%s %s",async(model,slot)=>{
  const f=fixture(1,{},model,slot);expect(bookProviderExecutionPolicy(await f.gateway.resolveSnapshot(f.request),f.request)).toBeUndefined();
});

it("M3 所有书籍阶段保留思考，32K总输出、等待及租约一致", () => {
  const snapshot = {providerKey:"minimax",modelId:"MiniMax-M3"};
  const generation = bookProviderGeneration(snapshot);
  expect(generation).toEqual({maxOutputTokens:32000});
  expect(generation).not.toHaveProperty("thinking");
  expect(canonicalTextInputHash({messages:[{role:"user",content:"原文"}],generation})).not.toBe(canonicalTextInputHash({messages:[{role:"user",content:"原文"}],generation:{maxOutputTokens:16000}}));
  expect(bookProviderLeaseMs()).toBe(630000);
  expect(bookProviderGeneration(snapshot)).toEqual({maxOutputTokens:32000});
  expect(bookProviderLeaseMs()).toBe(630000);
});

it.each(["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"] as const)("各阶段延长等待期间租约有效且仍只执行一次：%s", async slot => {
  vi.useFakeTimers(); const f=fixture(320000,{},"MiniMax-M3",slot);
  const done=expect(f.gateway.execute(f.request,{userId:"fixture"})).resolves.toMatchObject({status:"SUCCEEDED",attempt:1});
  await vi.advanceTimersByTimeAsync(320000);await done;
  expect(f.acquire).toHaveBeenCalledWith(expect.any(String),4,601000);
  expect(f.execute).toHaveBeenCalledTimes(1);
});
