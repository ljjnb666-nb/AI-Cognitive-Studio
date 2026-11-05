import { Prisma } from "@ai-cognitive/db";
import { stableHash } from "@ai-cognitive/provider-gateway";
import { assertAnalysisEvidenceWithinRequest, validateAnalysisResponse } from "./analysis.js";
import { sha256 } from "./chunking.js";
type BookAnalysisRun = Prisma.BookAnalysisRunGetPayload<Prisma.BookAnalysisRunDefaultArgs>;
export type FrozenChunkSelection = { version: 1; entries: Array<{ artifactId: string; digest: string }> };
export const frozenChunkRowDigest = (row: unknown) => stableHash(JSON.parse(JSON.stringify(row)));
export function frozenChunkSelectionHash(selection: FrozenChunkSelection): string {
  if(!selection||selection.version!==1||!Array.isArray(selection.entries)||selection.entries.some(e=>!e||typeof e!=="object"||Array.isArray(e)))throw new Error("FROZEN_CHUNKS_INVALID");
  if (Object.keys(selection).some(k=>!["version","entries"].includes(k)) || selection.entries.some(e=>Object.keys(e).some(k=>!["artifactId","digest"].includes(k))) || selection.version !== 1 || !selection.entries.length || new Set(selection.entries.map(e => e.artifactId)).size !== selection.entries.length || selection.entries.some(e => !e.artifactId || !/^[a-f0-9]{64}$/.test(e.digest))) throw new Error("FROZEN_CHUNKS_INVALID");
  return stableHash(selection);
}
/** Validate imported snapshots inside the same transaction that creates their target. */
export async function loadFrozenChunks(tx: Prisma.TransactionClient, lineage: { workspaceId: string; sourceDocumentId: string; extractionId: string; chunkSetId: string }, selection: FrozenChunkSelection, userId: string) {
  const hash=frozenChunkSelectionHash(selection);
  const member=await tx.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId:lineage.workspaceId,userId}}});
  const current=await tx.currentDocumentExtraction.findUnique({where:{sourceDocumentId_workspaceId:{sourceDocumentId:lineage.sourceDocumentId,workspaceId:lineage.workspaceId}}});
  const document=await tx.sourceDocument.findFirst({where:{id:lineage.sourceDocumentId,workspaceId:lineage.workspaceId,source:{archivedAt:null}}});
  if(!document||!member||member.role==="VIEWER"||current?.extractionId!==lineage.extractionId)throw new Error("FROZEN_CHUNKS_ACCESS_DENIED");
  const chunks=await tx.documentChunk.findMany({where:{chunkSetId:lineage.chunkSetId,workspaceId:lineage.workspaceId,extractionId:lineage.extractionId},include:{sourceSpans:{orderBy:{ordinal:"asc"},include:{sourceBlock:true}}},orderBy:{ordinal:"asc"}});
  const artifacts=await tx.analysisArtifact.findMany({where:{id:{in:selection.entries.map(e=>e.artifactId)}},orderBy:{ordinal:"asc"}});
  if(artifacts.length!==chunks.length||selection.entries.length!==chunks.length)throw new Error("FROZEN_CHUNKS_INCOMPLETE");
  const runs=await tx.bookAnalysisRun.findMany({where:{id:{in:[...new Set(artifacts.map(a=>a.analysisRunId))]}}});
  const receipts=await tx.providerTextResult.findMany({where:{workspaceId:lineage.workspaceId,consumedAt:{not:null},consumerKind:"BOOK_ANALYSIS_TEXT"},include:{invocation:{include:{snapshot:true}}}});
  const origins=[];
  for(const [index,a]of artifacts.entries()){
    const chunk=chunks[index]!,run=runs.find(r=>r.id===a.analysisRunId),entry=selection.entries[index]!;
    if(!run||!["FAILED","SUCCEEDED"].includes(run.status)||run.executionClaimToken||run.workspaceId!==lineage.workspaceId||run.sourceDocumentId!==lineage.sourceDocumentId||run.chunkSetId!==lineage.chunkSetId||run.extractionId!==lineage.extractionId||a.workspaceId!==lineage.workspaceId||a.extractionId!==lineage.extractionId||a.chunkSetId!==lineage.chunkSetId||a.scope!=="CHUNK"||a.ordinal!==index||a.chunkId!==chunk.id||entry.artifactId!==a.id||entry.digest!==frozenChunkRowDigest(a))throw new Error("FROZEN_CHUNKS_LINEAGE_INVALID");
    if(!chunk.sourceSpans.length||chunk.sourceSpans.some(s=>s.sourceBlock.extractionId!==lineage.extractionId||!Number.isSafeInteger(s.startOffset)||!Number.isSafeInteger(s.endOffset)||s.startOffset<0||s.endOffset<=s.startOffset||s.endOffset>s.sourceBlock.text.length))throw new Error("FROZEN_CHUNKS_SOURCE_INVALID");
    const spans=chunk.sourceSpans.map(s=>({sourceBlockId:s.sourceBlockId,startOffset:s.startOffset,endOffset:s.endOffset,text:s.sourceBlock.text.slice(s.startOffset,s.endOffset)}));
    if(sha256(chunk.content)!==chunk.contentHash||spans.map(s=>s.text).join("\n\n")!==chunk.content)throw new Error("FROZEN_CHUNKS_SOURCE_INVALID");
    const response=validateAnalysisResponse(a.structuredOutput);if(a.summary!==response.summary)throw new Error("FROZEN_CHUNKS_SUMMARY_INVALID");assertAnalysisEvidenceWithinRequest(response,{stage:"CHUNK",sourceSlices:spans});
    const fingerprint=sha256(JSON.stringify([lineage.workspaceId,run.id,"CHUNK",chunk.id,{chunkId:chunk.id,contentHash:chunk.contentHash}]));
    const matches=receipts.filter(r=>r.consumerKey===`CHUNK:${chunk.id}`&&r.consumerFingerprint===fingerprint&&r.invocation.status==="SUCCEEDED"&&r.invocation.providerKey===run.provider&&r.invocation.modelId===run.model&&r.invocation.snapshot.pipelineVersion===run.pipelineVersion&&r.invocation.snapshot.promptVersion===run.promptVersion&&r.invocation.correlationId===run.id&&r.invocation.routeSlot==="BOOK_CHUNK_ANALYSIS");
    if(matches.length!==1)throw new Error("FROZEN_CHUNKS_RECEIPT_INVALID");const receipt=matches[0]!;
    origins.push({artifactId:a.id,digest:entry.digest,ordinal:a.ordinal,chunkId:chunk.id,contentHash:chunk.contentHash,summaryHash:sha256(a.summary??""),outputHash:stableHash(a.structuredOutput),sourceRunId:run.id,sourceInvocationId:receipt.invocationId,sourceSnapshotId:receipt.snapshotId,provider:receipt.invocation.providerKey,model:receipt.invocation.modelId,pipelineVersion:receipt.invocation.snapshot.pipelineVersion,promptVersion:receipt.invocation.snapshot.promptVersion,schemaVersion:receipt.invocation.snapshot.schemaVersion});
  }
  return{hash,origins,artifacts};
}
/** Frozen origin hashes remain in the Job; parentId is reserved for the new tree. */
export async function seedFrozenChunks(tx: Prisma.TransactionClient, run: BookAnalysisRun, frozen: Awaited<ReturnType<typeof loadFrozenChunks>>) {
  for(const a of frozen.artifacts)await tx.analysisArtifact.create({data:{analysisRunId:run.id,workspaceId:run.workspaceId,chunkSetId:run.chunkSetId,extractionId:run.extractionId,chunkId:a.chunkId,scope:"CHUNK",ordinal:a.ordinal,summary:a.summary,structuredOutput:a.structuredOutput as Prisma.InputJsonValue}});
}
export async function assertFrozenChunksUnchanged(tx: Prisma.TransactionClient, run: BookAnalysisRun, payload: unknown) {
  const frozen=(payload as {frozenChunks?:{hash:string;selection:FrozenChunkSelection;origins:Array<{ordinal:number;chunkId:string;contentHash:string;summaryHash:string;outputHash:string}>}}|null)?.frozenChunks;
  const base=run.routePlanHash?[run.chunkSetId,run.pipelineVersion,run.promptVersion,run.routePlanHash]:[run.chunkSetId,run.pipelineVersion,run.promptVersion,run.provider,run.model,run.modelVersion??""];
  if(!frozen){
    // Stripping a frozen manifest must not silently turn the run into an ordinary one.
    if(sha256(JSON.stringify(base))!==run.analysisIdentityHash)throw new Error("FROZEN_CHUNKS_MANIFEST_MISSING");
    return;
  }
  if(frozen.hash!==frozenChunkSelectionHash(frozen.selection))throw new Error("FROZEN_CHUNKS_MANIFEST_CHANGED");
  const job=await tx.job.findUniqueOrThrow({where:{id:run.jobId}});if(!job.userId)throw new Error("FROZEN_CHUNKS_PRINCIPAL_REQUIRED");
  if(sha256(JSON.stringify([...base,"frozen-chunks-v1",frozen.hash]))!==run.analysisIdentityHash)throw new Error("FROZEN_CHUNKS_IDENTITY_CHANGED");
  const source=await loadFrozenChunks(tx,run,frozen.selection,job.userId);if(stableHash(source.origins)!==stableHash(frozen.origins))throw new Error("FROZEN_CHUNKS_ORIGINS_CHANGED");
  const artifacts=await tx.analysisArtifact.findMany({where:{analysisRunId:run.id,scope:"CHUNK"},include:{chunk:true},orderBy:{ordinal:"asc"}});
  if(artifacts.length!==frozen.origins.length||artifacts.some((a,i)=>{const o=frozen.origins[i]!;return a.ordinal!==o.ordinal||a.chunkId!==o.chunkId||a.chunk?.contentHash!==o.contentHash||sha256(a.summary??"")!==o.summaryHash||stableHash(a.structuredOutput)!==o.outputHash;}))throw new Error("FROZEN_CHUNKS_TARGET_CHANGED");
}
