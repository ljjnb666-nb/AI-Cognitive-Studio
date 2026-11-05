import { describe, expect, it, vi } from "vitest";
import { assertAnalysisEvidenceWithinRequest, guardedGenerateStructured, reduceBoundedAnalysisChildren, derivedAnalysisText, assertAnalysisRelationsWithinMemory, extractDerivedEvidenceRanges, validateAnalysisResponse, sha256, type AnalysisRequest, type AnalysisResponse } from "../src/index.js";
const span = {sourceBlockId:"partial",startOffset:0,endOffset:13,text:"abcdefghijklm"};
const response = (sourceBlockId:string,startOffset:number,endOffset:number):AnalysisResponse => ({summary:"grounded",memory:[{type:"ARGUMENT",content:"claim",evidence:[{sourceBlockId,startOffset,endOffset}]}]});
const request:AnalysisRequest={stage:"CHUNK",content:span.text,sourceBlockIds:[span.sourceBlockId],sourceEvidence:[span],tokenBudget:100,correlationId:"bounds",systemInstructions:"untrusted evidence",boundedChunk:{chunkId:"chunk",contentHash:sha256(span.text),sourceBlockIds:[span.sourceBlockId]}};
describe("CHUNK evidence stays inside the sent spans",()=>{
 it.each([[0,13],[1,12],[12,13]])("accepts a valid absolute subrange %s..%s without rewriting",(start,end)=>{const value=response("partial",start,end),before=JSON.stringify(value);expect(()=>assertAnalysisEvidenceWithinRequest(value,request)).not.toThrow();expect(JSON.stringify(value)).toBe(before);});
 it.each([[0,103],[-1,13],[0,14],[5,5],[10,8]])("rejects an invalid range %s..%s",(start,end)=>expect(()=>assertAnalysisEvidenceWithinRequest(response("partial",start,end),request)).toThrow("CHUNK_EVIDENCE_INVALID"));
 it("rejects a source ID absent from this chunk",()=>expect(()=>assertAnalysisEvidenceWithinRequest(response("other",0,13),request)).toThrow("CHUNK_EVIDENCE_INVALID"));
 it("does not bridge a gap between two spans from the same block",()=>expect(()=>assertAnalysisEvidenceWithinRequest(response("partial",0,25),{stage:"CHUNK",sourceEvidence:[span,{...span,startOffset:20,endOffset:25,text:"uvwxy"}]})).toThrow("CHUNK_EVIDENCE_INVALID"));
 it("keeps nonzero absolute UTF-16 offsets instead of rebasing text to zero",()=>{const req={stage:"CHUNK" as const,sourceEvidence:[{sourceBlockId:"unicode",startOffset:9,endOffset:13,text:"中文😀"}]};expect(()=>assertAnalysisEvidenceWithinRequest(response("unicode",9,13),req)).not.toThrow();expect(()=>assertAnalysisEvidenceWithinRequest(response("unicode",0,4),req)).toThrow("CHUNK_EVIDENCE_INVALID");});
 it("blocks the historical 0..103 failure even when the full original block has 200 characters, without retry or repair",async()=>{
   const value=response("partial",0,103),before=JSON.stringify(value),generateStructured=vi.fn(async()=>value);
   await expect(guardedGenerateStructured({generateStructured},request,[{id:"partial",ordinal:0,kind:"PARAGRAPH",text:span.text+"x".repeat(187)}],12000)).rejects.toThrow("CHUNK_EVIDENCE_INVALID");
   expect(generateStructured).toHaveBeenCalledTimes(1);expect(JSON.stringify(value)).toBe(before);
 });
 it("does not impose chunk spans on derived stages",()=>expect(()=>assertAnalysisEvidenceWithinRequest(response("other",0,103),{stage:"BOOK"})).not.toThrow());
});

describe("complete structured reduction results",()=>{
 it("uses distinct operation identities for equal text under different parents and stable identities on replay",async()=>{
  const requests:AnalysisRequest[]=[],provider={generateStructured:async(req:AnalysisRequest)=>{requests.push(req);return {summary:"derived"};}};
  for(const parentKey of ["section-a","section-b","section-a"])await reduceBoundedAnalysisChildren({provider,stage:"SECTION",parentKey,children:[{ordinal:0,summary:"same first"},{ordinal:1,summary:"same second"}],blocks:[{id:"actual",ordinal:0,kind:"PARAGRAPH",text:"source"}],limit:3000,correlationId:"identity",systemInstructions:"derived only"});
  expect(requests[0]!.content).toBe(requests[1]!.content);expect(requests[0]!.operationKey).not.toBe(requests[1]!.operationKey);expect(requests[0]!.operationKey).toBe(requests[2]!.operationKey);
 });
 it("carries factual memory and source references into parent requests and returns the final memory and relations",async()=>{
  const result:AnalysisResponse={summary:"结论",memory:[{type:"CLAIM",content:"收入降低25%，仅适用于1998年样本",evidence:[{sourceBlockId:"actual",startOffset:9,endOffset:18}]},{type:"CONCEPT",content:"边界条件"}],relations:[{fromOrdinal:0,toOrdinal:1,type:"SUPPORTS"}]};
  const requests:AnalysisRequest[]=[],provider={generateStructured:async(req:AnalysisRequest)=>{requests.push(req);return result;}};
  const reduced=await reduceBoundedAnalysisChildren({provider,stage:"BOOK",children:[{ordinal:0,summary:"第一段",analysis:result},{ordinal:1,summary:"第二段",analysis:result}],blocks:[{id:"actual",ordinal:0,kind:"PARAGRAPH",text:"原书来源文本，限定条件与证据均需保留。"}],limit:3000,correlationId:"structured",systemInstructions:"derived only"});
  expect(requests).toHaveLength(1);expect(requests[0]!.content).toContain("收入降低25%");expect(requests[0]!.content).toContain("1998");expect(requests[0]!.content).toContain("actual");expect(reduced).toEqual(result);
 });
 it("preserves structured cached final results without another provider call",async()=>{
  const response:AnalysisResponse={summary:"缓存综合",memory:[{type:"CONCEPT",content:"保留概念"}]},generateStructured=vi.fn(async()=>{throw new Error("NO_NEW_CALL");});
  const output=await reduceBoundedAnalysisChildren({provider:{generateStructured},stage:"BOOK",children:[{ordinal:0,summary:"a"},{ordinal:1,summary:"b"}],blocks:[{id:"actual",ordinal:0,kind:"PARAGRAPH",text:"原书来源文本，限定条件与证据均需保留。"}],limit:3000,correlationId:"cached",systemInstructions:"derived only",cache:{find:async()=>response,persist:async()=>{throw new Error("NO_WRITE");}}});
  expect(output).toEqual(response);expect(generateStructured).not.toHaveBeenCalled();expect(derivedAnalysisText(response)).toContain("保留概念");
 });
});

describe("zero-based relations in new analysis output",()=>{
 const memory=Array.from({length:6},(_,i)=>({type:"SUMMARY" as const,content:`memory ${i}`}));
 it("accepts both zero and the last array index without changing the response",()=>{
  const value={summary:"valid",memory,relations:[{fromOrdinal:0,toOrdinal:5,type:"SUPPORTS" as const}]},before=JSON.stringify(value);
  expect(()=>assertAnalysisRelationsWithinMemory(value)).not.toThrow();expect(JSON.stringify(value)).toBe(before);
 });
 it.each([[6,1],[1,6],[-1,0],[0,-1],[1.5,0],[0,Number.MAX_SAFE_INTEGER+1]])("rejects %s -> %s without rebasing or dropping a relation",(fromOrdinal,toOrdinal)=>{
  const value={summary:"invalid",memory,relations:[{fromOrdinal,toOrdinal,type:"SUPPORTS" as const}]},before=JSON.stringify(value);
  expect(()=>assertAnalysisRelationsWithinMemory(value)).toThrow("ANALYSIS_RELATION_INVALID");expect(JSON.stringify(value)).toBe(before);
 });
 it("rejects relations without memory while preserving legacy parsing for frozen artifacts",()=>{
  const legacy={summary:"historical",relations:[{fromOrdinal:0,toOrdinal:0,type:"SUPPORTS" as const}]};
  expect(validateAnalysisResponse(legacy)).toBe(legacy);expect(()=>assertAnalysisRelationsWithinMemory(legacy)).toThrow("ANALYSIS_RELATION_INVALID");
  expect(()=>assertAnalysisRelationsWithinMemory({memory:[],relations:[]})).not.toThrow();
 });
 it("does not retry or persist the exact six-memory/index-six regression",async()=>{
  const invalid={summary:"bad relations",memory,relations:[{fromOrdinal:6,toOrdinal:1,type:"SUPPORTS" as const}]},before=JSON.stringify(invalid),generateStructured=vi.fn(async()=>invalid),persist=vi.fn(async()=>invalid);
  await expect(reduceBoundedAnalysisChildren({provider:{generateStructured},stage:"SECTION",children:[{ordinal:0,summary:"first"},{ordinal:1,summary:"second"}],blocks:[{id:"source",ordinal:0,kind:"PARAGRAPH",text:"source"}],limit:3000,correlationId:"relation-bounds",systemInstructions:"derived only",cache:{find:async()=>null,persist}})).rejects.toThrow("ANALYSIS_RELATION_INVALID");
  expect(generateStructured).toHaveBeenCalledTimes(1);expect(persist).not.toHaveBeenCalled();expect(JSON.stringify(invalid)).toBe(before);
 });
});

describe("derived evidence objects do not depend on JSON key order",()=>{
 const expected={sourceBlockId:"real-source",startOffset:7,endOffset:19};
 it.each([
  {sourceBlockId:"real-source",startOffset:7,endOffset:19},
  {endOffset:19,startOffset:7,sourceBlockId:"real-source"},
  {startOffset:7,sourceBlockId:"real-source",endOffset:19,quoteText:'braces {} and "quoted" text'},
 ])("reads a complete citation without rebasing or modifying its input",citation=>{
  const content=JSON.stringify({summary:"derived",memory:[{evidence:[citation]}]});expect(extractDerivedEvidenceRanges(content)).toEqual([expected]);expect(content).toBe(JSON.stringify({summary:"derived",memory:[{evidence:[citation]}]}));
 });
 it("reads a complete leaf object in a bounded outer fragment",()=>expect(extractDerivedEvidenceRanges('unfinished prefix '+JSON.stringify({endOffset:19,startOffset:7,sourceBlockId:"real-source"})+' unfinished suffix')).toEqual([expected]));
 it.each(['{"sourceBlockId":"real-source","startOffset":7',JSON.stringify({sourceBlockId:"real-source",startOffset:7,endOffset:7}),JSON.stringify({sourceBlockId:"real-source",startOffset:-1,endOffset:19}),JSON.stringify({sourceBlockId:"real-source",startOffset:7.5,endOffset:19})])("does not grant incomplete or invalid ranges",content=>expect(extractDerivedEvidenceRanges(content)).toEqual([]));
 it("does not turn citation-shaped text inside a quoted memory into evidence",()=>expect(extractDerivedEvidenceRanges(JSON.stringify({content:JSON.stringify(expected)}))).toEqual([]));
});
it("keeps cached first-level batches intact while combining larger complete derived results at the next level",async()=>{
 const first={summary:"a".repeat(4500)},second={summary:"b".repeat(5000)},requests:AnalysisRequest[]=[],persisted:number[]=[];
 const result=await reduceBoundedAnalysisChildren({provider:{generateStructured:async request=>{requests.push(request);return{summary:"combined"};}},stage:"SECTION",children:[{ordinal:0,summary:"c".repeat(5000)},{ordinal:1,summary:"d".repeat(5000)}],blocks:[{id:"source",ordinal:0,kind:"PARAGRAPH",text:"original"}],limit:8000,higherLevelLimit:12000,correlationId:"higher-level",systemInstructions:"derived only",cache:{find:async identity=>identity.level===1?(identity.batchOrdinal===0?first:second):null,persist:async(identity,value)=>{persisted.push(identity.level);return value;}}});
 expect(requests).toHaveLength(1);expect(requests[0]!.content).toBe(first.summary+"\n"+second.summary);expect(requests[0]!.content.length).toBeGreaterThan(8000);expect(requests[0]!.content.length).toBeLessThanOrEqual(12000);expect(persisted).toEqual([2]);expect(result.summary).toBe("combined");
});
