import { describe, expect, it } from "vitest";
import { guardedGenerateStructured, reduceBoundedAnalysisChildren, sha256, type AnalysisResponse } from "../src/index.js";

describe("audit evidence and synthesis regressions", () => {
  const response: AnalysisResponse = { summary: "Synthesis", memory: [{ type: "CONCEPT", content: "One", evidence: [{ sourceBlockId: "random-id", startOffset: 2, endOffset: 4, quoteText: "😀" }] }, { type: "ARGUMENT", content: "Two" }], relations: [{ fromOrdinal: 0, toOrdinal: 1, type: "SUPPORTS" }] };
  it.each([1, 2, 5])("retains final memory and relations for %i children, including durable replay", async count => {
    const cache = new Map<string, AnalysisResponse>(); let calls = 0;
    const input = { stage: "BOOK" as const, children: Array.from({ length: count }, (_, ordinal) => ({ ordinal, summary: "child", structuredOutput: response })), blocks: [{ id: "random-id", ordinal: 0, kind: "PARAGRAPH" as const, text: "AA😀ZZ" }], limit: 4000, correlationId: "test", systemInstructions: "Use supplied evidence", cache: { find: async (id: { inputHash: string }) => cache.get(id.inputHash) ?? null, persist: async (id: { inputHash: string }, value: AnalysisResponse) => { cache.set(id.inputHash, value); return value; } }, provider: { generateStructured: async (request: { content: string }) => { calls++; expect(request.content).toContain("random-id"); return response; } } };
    expect(await reduceBoundedAnalysisChildren(input)).toEqual(response);
    expect(await reduceBoundedAnalysisChildren(input)).toEqual(response);
    expect(calls).toBe(1);
  });
  it("rejects forged and split-surrogate slices before invoking a provider", async () => {
    const text = "AA😀ZZ", blocks = [{ id: "random-id", ordinal: 0, kind: "PARAGRAPH" as const, text }]; let calls = 0;
    const request = { stage: "CHUNK" as const, content: text, sourceBlockIds: ["random-id"], sourceSlices: [{ sourceBlockId: "random-id", startOffset: 0, endOffset: 6, text }], tokenBudget: 100, correlationId: "test", systemInstructions: "untrusted source", boundedChunk: { chunkId: "chunk", contentHash: sha256(text), sourceBlockIds: ["random-id"] } };
    const provider = { generateStructured: async () => { calls++; return response; } };
    await guardedGenerateStructured(provider, request, blocks, 100);
    await expect(guardedGenerateStructured(provider, { ...request, sourceSlices: [{ ...request.sourceSlices[0]!, startOffset: 3 }] }, blocks, 100)).rejects.toThrow("ANALYSIS_SOURCE_SLICE_INVALID");
    expect(calls).toBe(1);
  });

  it("requires a valid in-slice citation from the production chunk analysis", async () => {
    const text = "A grounded statement.", blocks = [{ id: "block", ordinal: 0, kind: "PARAGRAPH" as const, text }];
    const request = { stage: "CHUNK" as const, content: text, sourceBlockIds: ["block"], sourceSlices: [{ sourceBlockId: "block", startOffset: 0, endOffset: text.length, text }], tokenBudget: 100, correlationId: "test", systemInstructions: "Cite the supplied source", pipelineVersion: "product-v2-evidence", boundedChunk: { chunkId: "chunk", contentHash: sha256(text), sourceBlockIds: ["block"] } };
    await expect(guardedGenerateStructured({ generateStructured: async () => ({ summary: "unsupported summary" }) }, request, blocks, 100)).rejects.toThrow("ANALYSIS_EVIDENCE_REQUIRED");
    await expect(guardedGenerateStructured({ generateStructured: async () => ({ summary: "summary", memory: [{ type: "CLAIM", content: "claim", evidence: [{ sourceBlockId: "another", startOffset: 0, endOffset: 1 }] }] }) }, request, blocks, 100)).rejects.toThrow("ANALYSIS_EVIDENCE_REQUIRED");
    await expect(guardedGenerateStructured({ generateStructured: async () => ({ summary: "summary", memory: [{ type: "CLAIM", content: "claim", evidence: [{ sourceBlockId: "block", startOffset: 0, endOffset: text.length, quoteText: text }] }] }) }, request, blocks, 100)).resolves.toMatchObject({ memory: [{ type: "CLAIM" }] });
  });
});

it("全书综合某批次截断后复用成功批次，不重发已保存综合请求", async () => {
  const cache = new Map<string, AnalysisResponse>();
  const key = (id: unknown) => JSON.stringify(id);
  const input = {stage:"BOOK" as const,children:Array.from({length:4},(_,ordinal)=>({ordinal,summary:`批次${ordinal}:`+"内容".repeat(100)})),blocks:[{id:"source",ordinal:0,kind:"PARAGRAPH" as const,text:"仅用于原文身份校验的独立样本"}],limit:600,correlationId:"test",systemInstructions:"仅综合已有摘要",cache:{find:async(id:unknown)=>cache.get(key(id))??null,persist:async(id:unknown,value:AnalysisResponse)=>{cache.set(key(id),value);return value;}}};
  let firstCalls=0;
  await expect(reduceBoundedAnalysisChildren({...input,provider:{generateStructured:async()=>{if(++firstCalls===2)throw new Error("OUTPUT_TRUNCATED");return {summary:"已成功的首个综合批次"};}}})).rejects.toThrow("OUTPUT_TRUNCATED");
  expect(cache.size).toBe(1);
  const [firstKey, firstValue] = [...cache.entries()][0]!;
  let resumedCalls=0;
  const result=await reduceBoundedAnalysisChildren({...input,provider:{generateStructured:async()=>{resumedCalls++;return {summary:"完整综合摘要"};}}});
  expect(result.summary).toBe("完整综合摘要");
  expect(resumedCalls).toBe(2);
  expect(cache.get(firstKey)).toBe(firstValue);
});
