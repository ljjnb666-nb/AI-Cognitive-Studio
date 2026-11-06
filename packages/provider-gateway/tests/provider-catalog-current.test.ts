import { describe, expect, it } from "vitest";
import { builtInProviderCatalog, resolveProviderCatalog, ProviderRegistry, validateRouteManifestSelection } from "../src/index.js";
import { providerWireSchema } from "../src/text/provider-wire-schema.js";
describe("当前用途目录与历史型号保护",()=>{
 it("仅有真实声明的国内严格输出型号进入理解验证",()=>{
  const qwen=builtInProviderCatalog.providers.find(provider=>provider.providerKey==="qwen")!;
  expect(qwen.models.filter(model=>model.structuredOutput==="STRICT_JSON_SCHEMA").map(model=>model.modelId)).toEqual(["qwen3.8-flash","qwen3.8-max","qwen3.7-plus"]);
  for(const model of qwen.models.filter(model=>model.structuredOutput==="STRICT_JSON_SCHEMA")) expect(validateRouteManifestSelection(builtInProviderCatalog,{providerKey:"qwen",protocol:"OPENAI_COMPATIBLE",routeSlot:"TEACH_BACK_ASSESSMENT",modelId:model.modelId}).confidence).toBe("DECLARED");
  for(const providerKey of ["minimax","zhipu","deepseek"]) for(const model of builtInProviderCatalog.providers.find(provider=>provider.providerKey===providerKey)!.models.filter(model=>model.families.includes("TEXT_GENERATION"))) expect(()=>validateRouteManifestSelection(builtInProviderCatalog,{providerKey,protocol:"OPENAI_COMPATIBLE",routeSlot:"TEACH_BACK_ASSESSMENT",modelId:model.modelId})).toThrow();
 });
 it("停服型号保留身份可识别但阻断新请求，弃用与停服区分处理",()=>{
  const registry=new ProviderRegistry();for(const provider of builtInProviderCatalog.providers)registry.register(provider);
  expect(()=>registry.resolveCapability("gemini","gemini-2.0-flash",{family:"TEXT_GENERATION"})).toThrow("MODEL_NOT_FOUND");
  expect(()=>validateRouteManifestSelection(builtInProviderCatalog,{providerKey:"anthropic",protocol:"ANTHROPIC_COMPATIBLE",routeSlot:"TEACH_BACK_ASSESSMENT",modelId:"claude-3-5-haiku-latest"})).toThrowError(expect.objectContaining({code:"MODEL_NOT_FOUND"}));
  expect(registry.resolveCapability("openai","gpt-4o-mini",{family:"TEXT_GENERATION"})).toMatchObject({deprecated:true});
 });
 it("显式部署目录继续权威，不能自动加入新型号",()=>{
  const manifest={providers:[{providerKey:"fixture",displayName:"固定目录",protocol:"TEST",adapterVersion:"fixture",models:[{modelId:"pinned",families:["TEXT_GENERATION"],confidence:"DECLARED",structuredOutput:"JSON_MODE"}]}]};expect(resolveProviderCatalog(JSON.stringify(manifest))).toEqual(manifest);
 });
 it("供应商结构投影不删除同名业务字段，不改写原始结构",()=>{
  const schema={type:"object",properties:{minLength:{type:"string",minLength:2,maxLength:4},list:{type:"array",minItems:3,maxItems:3,items:{type:"string"}}},additionalProperties:false};const before=structuredClone(schema);
  const wire=providerWireSchema(schema,"anthropic") as typeof schema;
  expect(wire.properties).toHaveProperty("minLength");expect(wire.properties.minLength).not.toHaveProperty("minLength");expect(wire.properties.list).not.toHaveProperty("maxItems");expect(schema).toEqual(before);
 });
});
