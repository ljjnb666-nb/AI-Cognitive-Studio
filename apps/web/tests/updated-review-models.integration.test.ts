import { describe, expect, it } from "vitest";
import { AnthropicCompatibleAdapter, DeterministicProviderHttpTransport, GeminiNativeAdapter, OpenAICompatibleAdapter, OpenAIResponsesAdapter, canonicalTextInputHash, builtInProviderCatalog, type AdapterRequest, type ExecutionSnapshot } from "@ai-cognitive/provider-gateway";
import { assessmentSchema, rubricForCognitionType, validateTeachBackAssessment } from "../lib/teach-back";
const expected=rubricForCognitionType("CONCEPT"), labels=["E1"], schema=assessmentSchema(expected,labels);
const good=()=>({criteria:expected.map(key=>({key,status:"MET",rationale:"能够准确说明",evidenceRefs:["E1"]})),feedback:"表述完整",nextPrompt:null});
const cases=[
 {provider:"qwen",model:"qwen3.8-flash",Adapter:OpenAICompatibleAdapter,protocol:"OPENAI_COMPATIBLE"},
 {provider:"qwen",model:"qwen3.8-max",Adapter:OpenAICompatibleAdapter,protocol:"OPENAI_COMPATIBLE"},
 {provider:"qwen",model:"qwen3.7-plus",Adapter:OpenAICompatibleAdapter,protocol:"OPENAI_COMPATIBLE"},
 {provider:"anthropic",model:"claude-haiku-4-5-20251001",Adapter:AnthropicCompatibleAdapter,protocol:"ANTHROPIC_COMPATIBLE"},
 {provider:"anthropic",model:"claude-sonnet-4-6",Adapter:AnthropicCompatibleAdapter,protocol:"ANTHROPIC_COMPATIBLE"},
 {provider:"gemini",model:"gemini-3.8-flash",Adapter:GeminiNativeAdapter,protocol:"GEMINI_NATIVE"},
 {provider:"openai",model:"gpt-5.4-mini",Adapter:OpenAIResponsesAdapter,protocol:"OPENAI_RESPONSES"},
] as const;
function runInput(entry:typeof cases[number]){
 const capability=builtInProviderCatalog.providers.find(provider=>provider.providerKey===entry.provider)!.models.find(model=>model.modelId===entry.model)!;
 const configuration=entry.provider==="qwen"?{qwenRegion:"BEIJING",qwenWorkspaceId:"acceptance"}:{};
 const snapshot={id:"fixture",workspaceId:"fixture",source:"WORKSPACE",routeSlot:"TEACH_BACK_ASSESSMENT",providerKey:entry.provider,protocol:entry.protocol,modelId:entry.model,adapterVersion:"fixture",correlationId:"fixture",configuration,configurationHash:"fixture",createdAt:new Date(),capability} as ExecutionSnapshot;
 const text={system:"只返回符合结构的 JSON",messages:[{role:"user" as const,content:"复述验收"}],structuredOutput:{mode:"STRICT_JSON_SCHEMA" as const,schemaName:"teach_back_assessment",schema},generation:{temperature:0.2,topP:0.9,maxOutputTokens:1200}};
 const request={workspaceId:"fixture",routeSlot:"TEACH_BACK_ASSESSMENT",idempotencyKey:"fixture",inputHash:canonicalTextInputHash(text),requestFingerprint:"fixture",correlationId:"fixture",capability:{family:"TEXT_GENERATION",structuredOutput:"STRICT_JSON_SCHEMA"},text} as AdapterRequest;
 return {snapshot,request,credential:"fixture-not-a-real-key",signal:new AbortController().signal};
}
function response(entry:typeof cases[number], value:unknown){const text=JSON.stringify(value);return entry.provider==="anthropic"?{model:entry.model,content:[{type:"text",text}],stop_reason:"end_turn"}:entry.provider==="gemini"?{candidates:[{content:{parts:[{text}]},finishReason:"STOP"}]}:entry.provider==="openai"?{model:entry.model,status:"completed",output:[{type:"message",content:[{type:"output_text",text}]}]}:{model:entry.model,choices:[{finish_reason:"stop",message:{content:text}}]};}
describe("更新型号使用实际复述评估结构的无费用适配回归",()=>{
 it.each(cases)("$provider / $model 保留原始结构和引用校验",async entry=>{
  const wire=new DeterministicProviderHttpTransport(()=>({status:200,headers:{},body:JSON.stringify(response(entry,good()))}));
  const input=runInput(entry),before=structuredClone(input);const hash=canonicalTextInputHash(input.request.text!);
  const result=await new entry.Adapter(wire).execute(input);
  expect(result.response.type).toBe("STRUCTURED");expect(validateTeachBackAssessment((result.response as {structured:unknown}).structured,expected,labels).masteryState).toBe("DEMONSTRATED");
  expect(input.snapshot).toEqual(before.snapshot);expect(input.request.text!.structuredOutput!.schema).toEqual(schema);expect(canonicalTextInputHash(input.request.text!)).toBe(hash);
  const body=JSON.parse(wire.calls[0]!.body);
  if(entry.provider==="qwen"){expect(body.response_format).toMatchObject({type:"json_schema",json_schema:{strict:true,schema}});expect(body).not.toHaveProperty("enable_thinking");expect(wire.calls[0]!.url).toBe("https://acceptance.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions");}
  if(entry.provider==="anthropic"){expect(body).not.toHaveProperty("temperature");expect(body).not.toHaveProperty("top_p");expect(body.output_config.format.schema.properties.feedback).not.toHaveProperty("maxLength");expect(body.output_config.format.schema.properties.criteria).not.toHaveProperty("minItems");}
  if(entry.provider==="gemini"){expect(body.generationConfig.responseJsonSchema.properties.feedback).not.toHaveProperty("maxLength");expect(body.generationConfig.responseJsonSchema.properties.criteria.minItems).toBe(expected.length);}
  if(entry.provider==="openai"){expect(body.text.format).toMatchObject({type:"json_schema",strict:true,schema});expect(body).not.toHaveProperty("temperature");expect(body).not.toHaveProperty("top_p");}
 });
 it.each(cases)("$provider / $model 不因供应商结构子集而放过超长、缺字段或错误引用",async entry=>{
  const variants=[{...good(),feedback:"长".repeat(2001)},{...good(),feedback:undefined},{...good(),criteria:good().criteria.map(row=>({...row,evidenceRefs:["E999"]}))}];
  for(const value of variants){const wire=new DeterministicProviderHttpTransport(()=>({status:200,headers:{},body:JSON.stringify(response(entry,value))}));await expect(new entry.Adapter(wire).execute(runInput(entry))).rejects.toMatchObject({code:"INVALID_PROVIDER_RESPONSE"});}
 });
 it("结构合法仍不能绕过重复准则或虚构证据的业务门禁",()=>{const value=good();value.criteria=value.criteria.map(()=>({...value.criteria[0]!}));expect(()=>validateTeachBackAssessment(value,expected,labels)).toThrow("TEACH_BACK_ASSESSMENT_INVALID");});
});
