import { describe, expect, it } from "vitest";
import { bookAnalysisMessage, bookAnalysisEvidenceInstruction, bookAnalysisEvidenceContractVersion, resolveBookAnalysisSpanReferences, bookAnalysisSpanReferenceInstruction } from "../src/book-analysis-request.js";
describe("lossless bounded Book request", () => {
  const spans = [{ sourceBlockId: "actual-block", startOffset: 9, endOffset: 13, text: "事实一。" }, { sourceBlockId: "actual-block-2", startOffset: 0, endOffset: 4, text: "观点二。" }];
  it("sends complete source once and preserves ordered IDs and exact offsets", () => {
    const content = spans.map(s => s.text).join("\n\n");
    const wire = bookAnalysisMessage({ content, sourceEvidence: spans });
    expect(JSON.parse(wire)).toEqual({ sourceEvidence: spans });
    expect(wire.match(/事实一。/g)).toHaveLength(1);
    expect(JSON.parse(wire).sourceEvidence.map((s: { text: string }) => s.text).join("\n\n")).toBe(content);
  });
  it("never discards content absent from evidence", () => {
    expect(JSON.parse(bookAnalysisMessage({ content: "重要的限定条件", sourceEvidence: spans }))).toEqual({ content: "重要的限定条件", sourceEvidence: spans });
  });
  it("preserves derived summaries with no source evidence", () => { expect(bookAnalysisMessage({ content: "章节综合" })).toBe("章节综合"); });
});

describe("bounded citation contract", () => {
 it("offers exact atomic tuples including a partial block without repeating source text", () => {
   const spans = [{sourceBlockId:"partial",startOffset:0,endOffset:13,text:"Private source"},{sourceBlockId:"next",startOffset:103,endOffset:108,text:"中文😀。"}];
   const instruction=bookAnalysisEvidenceInstruction(spans);
   const citations=JSON.parse(instruction.split("Allowed factual citations (copy complete objects, not fields from different rows): ")[1]!);
   expect(citations).toEqual(spans.map(({sourceBlockId,startOffset,endOffset})=>({sourceBlockId,startOffset,endOffset})));
   expect(instruction).not.toContain("Private source");
   expect(instruction).toContain("never combine an ID with offsets from another row");
   expect(instruction).toContain("absolute UTF-16");
   expect(bookAnalysisEvidenceContractVersion).toBe("book-evidence-span-v2");
 });
 it("does not add raw-source policy to derived stages without evidence",()=>expect(bookAnalysisEvidenceInstruction(undefined)).toBe(""));
});

describe("v3 request-scoped evidence references",()=>{
 const spans=[{sourceBlockId:"long-real-id",startOffset:40,endOffset:46,text:"中文😀事实"},{sourceBlockId:"partial",startOffset:0,endOffset:13,text:"abcdefghijklm"}];
 const raw=(e:unknown,type="CLAIM")=>({summary:"grounded",memory:[{type,content:"fact",evidence:[e]}]});
 it("sends source once with deterministic local indexes, retaining source authority",()=>{const wire=bookAnalysisMessage({content:spans.map(s=>s.text).join("\n\n"),sourceEvidence:spans},true);expect(JSON.parse(wire).sourceEvidence).toEqual(spans.map((s,spanIndex)=>({...s,spanIndex})));expect(wire.match(/中文😀事实/g)).toHaveLength(1);expect(bookAnalysisSpanReferenceInstruction(2)).toContain("0 through 1");});
 it("resolves references without asking the model to copy source IDs or offsets; preserves the raw response",()=>{const v=raw({spanIndex:1}),before=JSON.stringify(v);expect(resolveBookAnalysisSpanReferences(v,spans)).toMatchObject({memory:[{evidence:[{sourceBlockId:"partial",startOffset:0,endOffset:13}]}]});expect(JSON.stringify(v)).toBe(before);});
 it.each([-1,2,1.5,"0",null])("rejects invalid span index %s",spanIndex=>expect(()=>resolveBookAnalysisSpanReferences(raw({spanIndex}),spans)).toThrow("CHUNK_EVIDENCE_INVALID"));
 it("does not repair legacy ID/offset responses or accept an attached wrong range",()=>{expect(()=>resolveBookAnalysisSpanReferences(raw({sourceBlockId:"typo",startOffset:0,endOffset:13}),spans)).toThrow("CHUNK_EVIDENCE_INVALID");expect(()=>resolveBookAnalysisSpanReferences(raw({spanIndex:0,endOffset:999}),spans)).toThrow("CHUNK_EVIDENCE_INVALID");});
 it("maps an exact unique quote using original absolute UTF-16 offsets",()=>expect(resolveBookAnalysisSpanReferences(raw({spanIndex:0,quoteText:"😀"},"QUOTE"),spans)).toMatchObject({memory:[{evidence:[{sourceBlockId:"long-real-id",startOffset:42,endOffset:44,quoteText:"😀"}]}]}));
 it("rejects missing or ambiguous quotes instead of guessing",()=>{expect(()=>resolveBookAnalysisSpanReferences(raw({spanIndex:0,quoteText:"not in source"},"QUOTE"),spans)).toThrow("INVALID_DIRECT_QUOTE");expect(()=>resolveBookAnalysisSpanReferences(raw({spanIndex:0,quoteText:"a"},"QUOTE"),[{...spans[0]!,text:"aa"}])).toThrow("INVALID_DIRECT_QUOTE");});
 it("rejects seven memory items without deleting one",()=>{const item=raw({spanIndex:0}).memory[0]!,v={summary:"fact",memory:Array.from({length:7},()=>item)};expect(()=>resolveBookAnalysisSpanReferences(v,spans)).toThrow("CHUNK_MEMORY_QUALITY_FAILED");expect(v.memory).toHaveLength(7);});
});
