import { prisma } from "@ai-cognitive/db";
import { assertFrozenChunksUnchanged } from "./frozen-chunks.js";
import { validateQuote } from "./analysis.js";
/** This gate proves structure/provenance only; it never certifies a Mock's meaning. */
export async function inspectBookMergeStructure(analysisRunId: string, actor: {workspaceId:string;userId:string}) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const run=await tx.bookAnalysisRun.findFirst({where:{id:analysisRunId,workspaceId:actor.workspaceId}});
    const member=await tx.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId:actor.workspaceId,userId:actor.userId}}});
    if(!run || !member)throw new Error("BOOK_MERGE_AUDIT_ACCESS_DENIED");
    const [chunks,artifacts,items,evidence,blocks]=await Promise.all([
      tx.documentChunk.findMany({where:{chunkSetId:run.chunkSetId,workspaceId:run.workspaceId,extractionId:run.extractionId},orderBy:{ordinal:"asc"}}),
      tx.analysisArtifact.findMany({where:{analysisRunId,workspaceId:run.workspaceId},orderBy:[{scope:"asc"},{ordinal:"asc"}]}),
      tx.bookMemoryItem.findMany({where:{analysisRunId,workspaceId:run.workspaceId}}),tx.bookMemoryEvidence.findMany({where:{analysisRunId,workspaceId:run.workspaceId}}),tx.sourceBlock.findMany({where:{extractionId:run.extractionId}}),
    ]);
    const issues:Array<{code:string;id?:string}>=[],byId=new Map(artifacts.map(a=>[a.id,a])),itemById=new Map(items.map(i=>[i.id,i])),blockById=new Map(blocks.map(b=>[b.id,b])),leaves=artifacts.filter(a=>a.scope==="CHUNK").sort((a,b)=>a.ordinal-b.ordinal),books=artifacts.filter(a=>a.scope==="BOOK"),rank={CHUNK:0,SECTION:1,CHAPTER:2,BOOK:3};
    const job=await tx.job.findUniqueOrThrow({where:{id:run.jobId}});
    try{await assertFrozenChunksUnchanged(tx,run,job.payload);}catch{issues.push({code:"FROZEN_MANIFEST_INVALID"});}
    const embeddingIdentityHash=(job.result as {embeddingIdentityHash?:string}|null)?.embeddingIdentityHash;
    if(!embeddingIdentityHash)issues.push({code:"EMBEDDING_IDENTITY_MISSING"});else{
      const [chunkVectors,memoryVectors]=await Promise.all([tx.documentChunkEmbedding.count({where:{chunkId:{in:chunks.map(c=>c.id)},embeddingIdentityHash}}),tx.bookMemoryEmbedding.count({where:{analysisRunId,embeddingIdentityHash}})]);
      if(chunkVectors!==chunks.length||memoryVectors!==items.length)issues.push({code:"EMBEDDING_COVERAGE_INVALID"});
    }
    if(run.status!=="SUCCEEDED"||run.analysisStage!=="COMPLETED")issues.push({code:"RUN_NOT_COMPLETE"});
    if(chunks.some(c=>c.workspaceId!==run.workspaceId||c.extractionId!==run.extractionId||c.sourceDocumentId!==run.sourceDocumentId))issues.push({code:"CHUNK_LINEAGE_INVALID"});
    if(leaves.length!==chunks.length||leaves.some((a,i)=>a.ordinal!==chunks[i]?.ordinal||a.chunkId!==chunks[i]?.id))issues.push({code:"CHUNK_COVERAGE_INVALID"});
    if(books.length!==1||!books[0]?.summary)issues.push({code:"BOOK_ROOT_INVALID"});
    for(const a of artifacts){
      if(a.workspaceId!==run.workspaceId||a.chunkSetId!==run.chunkSetId||a.extractionId!==run.extractionId)issues.push({code:"ARTIFACT_LINEAGE_INVALID",id:a.id});
      if(a.scope==="BOOK"){if(a.parentId)issues.push({code:"BOOK_HAS_PARENT",id:a.id});continue;}
      let cursor=a,reached=false;const seen=new Set<string>();
      for(let depth=0;depth<4;depth++){if(seen.has(cursor.id)){issues.push({code:"ARTIFACT_CYCLE",id:a.id});break;}seen.add(cursor.id);const parent=cursor.parentId?byId.get(cursor.parentId):undefined;if(!parent||rank[parent.scope]<=rank[cursor.scope])break;if(parent.scope==="BOOK"){reached=true;break;}cursor=parent;}
      if(!reached)issues.push({code:"ARTIFACT_NOT_REACHING_BOOK",id:a.id});
    }
    for(const item of items){if(item.workspaceId!==run.workspaceId||item.sourceDocumentId!==run.sourceDocumentId||item.extractionId!==run.extractionId||!item.sourceArtifactId||!byId.has(item.sourceArtifactId))issues.push({code:"MEMORY_LINEAGE_INVALID",id:item.id});if(["CLAIM","EXAMPLE","STORY","PERSON","QUOTE"].includes(item.type)&&!evidence.some(e=>e.memoryItemId===item.id))issues.push({code:"FACT_MEMORY_WITHOUT_EVIDENCE",id:item.id});}
    for(const e of evidence){const block=blockById.get(e.sourceBlockId),item=itemById.get(e.memoryItemId);if(!block||!item||e.workspaceId!==run.workspaceId||e.extractionId!==run.extractionId||e.sourceDocumentId!==run.sourceDocumentId||e.startOffset<0||e.endOffset<=e.startOffset||e.endOffset>block.text.length){issues.push({code:"MEMORY_EVIDENCE_INVALID",id:e.id});continue;}if(item.type==="QUOTE")try{validateQuote(block,{sourceBlockId:block.id,startOffset:e.startOffset,endOffset:e.endOffset,...(e.quoteText?{quoteText:e.quoteText}:{})});}catch{issues.push({code:"DIRECT_QUOTE_INVALID",id:e.id});}}
    return{analysisRunId,structuralPass:issues.length===0,issues,counts:{chunks:leaves.length,sections:artifacts.filter(a=>a.scope==="SECTION").length,chapters:artifacts.filter(a=>a.scope==="CHAPTER").length,books:books.length,memoryItems:items.length,memoryEvidence:evidence.length},semanticReviewRequired:true,fullBookVerified:false};
  },{timeout:15000});
}
