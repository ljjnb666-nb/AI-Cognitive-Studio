import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { pdfReviewCandidateFingerprint } from "@ai-cognitive/domain";
import { PDF_GRAPH_REVIEW_AXES, type ProviderExecutionRepository } from "@ai-cognitive/provider-gateway";
import { processNextPdfGraphSecondReviewRequest } from "../src/pdf-graph-second-review.js";

/** PostgreSQL-backed proof of one separate charged-call authorization per
 * existing ingestion generation + physical page, never actually invoking AI. */
const cleanups: Array<{workspaceId:string;userId:string}> = [];
async function fixture() {
  const key=randomUUID();
  const user=await prisma.user.create({data:{email:key+"@second-graph-proof.test"}});
  const workspace=await prisma.workspace.create({data:{name:"second-graph-"+key}});
  cleanups.push({workspaceId:workspace.id,userId:user.id});
  await prisma.workspaceMember.create({data:{workspaceId:workspace.id,userId:user.id,role:"OWNER"}});
  const source=await prisma.source.create({data:{
    workspaceId:workspace.id,kind:"FILE",displayName:"graph-proof.pdf",
  }});
  const blob=await prisma.sourceBlob.create({data:{
    workspaceId:workspace.id,sha256:"a".repeat(64),sizeBytes:1000n,
    mediaType:"application/pdf",storageKey:"private/test/"+key,
  }});
  const doc=await prisma.sourceDocument.create({data:{
    workspaceId:workspace.id,sourceId:source.id,sourceBlobId:blob.id,version:1,
    sha256:"a".repeat(64),sizeBytes:1000n,mediaType:"application/pdf",
    storageKey:"private/test/"+key,
  }});
  const job=await prisma.job.create({data:{
    workspaceId:workspace.id,userId:user.id,type:"source.ingest",
    status:"SUCCEEDED",payload:{},
  }});
  const run=await prisma.ingestionRun.create({data:{
    workspaceId:workspace.id,sourceDocumentId:doc.id,jobId:job.id,status:"SUCCEEDED",
    routingGeneration:1,parserVersion:"second-proof-v1",normalizationVersion:"second-proof-v1",
  }});
  return {workspace,user,doc,run};
}
afterEach(async()=>{
  for(const c of cleanups.splice(0)){
    const where={workspaceId:c.workspaceId};
    await prisma.currentDocumentExtraction.deleteMany({where});
    await prisma.providerRouteBinding.deleteMany({where});
    await prisma.providerConnection.deleteMany({where});
    await prisma.ingestionRun.deleteMany({where});
    await prisma.job.deleteMany({where});
    await prisma.sourceDocument.deleteMany({where});
    await prisma.sourceBlob.deleteMany({where});
    await prisma.source.deleteMany({where});
    await prisma.workspaceMember.deleteMany({where});
    await prisma.workspace.delete({where:{id:c.workspaceId}});
    await prisma.user.delete({where:{id:c.userId}});
  }
});
describe("real PostgreSQL separate graph second-review paid admission",()=>{
  it("stores only bounded source digests, consent expiry, and no paid invocation",async()=>{
    const f=await fixture();
    const expiry=new Date(Date.now()+600_000);
    const data={
      workspaceId:f.workspace.id,userId:f.user.id,sourceDocumentId:f.doc.id,
      ingestionRunId:f.run.id,routingGeneration:1,physicalPageIndex:3,
      sourcePdfSha256:"a".repeat(64),sourcePngSha256:"b".repeat(64),
      candidateSha256:"c".repeat(64),expiresAt:expiry,
    };
    const first=await prisma.pdfGraphSecondReviewRequest.create({data});
    expect(first).toMatchObject({
      status:"AUTHORIZED_NOT_DISPATCHED",invocationId:null,snapshotId:null,
      modelDecision:null,claimToken:null,sourcePngSha256:"b".repeat(64),
    });
    await expect(prisma.pdfGraphSecondReviewRequest.create({
      data:{...data,userId:f.user.id,candidateSha256:"d".repeat(64)},
    })).rejects.toThrow();
    const rows=await prisma.pdfGraphSecondReviewRequest.findMany({
      where:{ingestionRunId:f.run.id},
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invocationId).toBeNull();
    expect(rows[0]?.modelDecision).toBeNull();
  });
  it("refuses malformed cross-page/invalid evidence at SQL CHECK and composite FK",async()=>{
    const f=await fixture();
    const base={
      workspaceId:f.workspace.id,userId:f.user.id,sourceDocumentId:f.doc.id,
      ingestionRunId:f.run.id,routingGeneration:1,physicalPageIndex:3,
      sourcePdfSha256:"a".repeat(64),sourcePngSha256:"b".repeat(64),
      candidateSha256:"c".repeat(64),expiresAt:new Date(Date.now()+600_000),
    };
    await expect(prisma.pdfGraphSecondReviewRequest.create({
      data:{...base,sourcePngSha256:"invalid"},
    })).rejects.toThrow();
    await expect(prisma.pdfGraphSecondReviewRequest.create({
      data:{...base,sourceDocumentId:"not-the-document"},
    })).rejects.toThrow();
    expect(await prisma.pdfGraphSecondReviewRequest.count({
      where:{workspaceId:f.workspace.id},
    })).toBe(0);
  });
});

const graph = {schemaVersion:1,figures:[{
  id:"f1",kind:"DIAGRAM",bbox:[20,30,100,100],caption:"Synthetic diagram",
  nodes:[{id:"A",label:"Alpha"}],edges:[],
}]};
async function readyGraphRequest() {
  const f=await fixture();
  const extraction=await prisma.documentExtraction.create({data:{
    ingestionRunId:f.run.id,sourceDocumentId:f.doc.id,workspaceId:f.workspace.id,
    status:"SUCCEEDED",parserName:"pdfjs-isolated",parserVersion:"test-v1",
    normalizationVersion:"test-v1",
  }});
  await prisma.currentDocumentExtraction.create({data:{
    workspaceId:f.workspace.id,sourceDocumentId:f.doc.id,extractionId:extraction.id,
  }});
  const page=await prisma.sourcePage.create({data:{
    extractionId:extraction.id,ordinal:0,physicalPageIndex:0,
  }});
  await prisma.sourceBlock.create({data:{
    extractionId:extraction.id,sourcePageId:page.id,ordinal:0,
    kind:"PARAGRAPH",text:"Source evidence for alpha diagram.",
    contentHash:"f".repeat(64),
  }});
  const fp=pdfReviewCandidateFingerprint(graph);
  await prisma.pdfVisualReviewCandidate.create({data:{
    workspaceId:f.workspace.id,sourceDocumentId:f.doc.id,ingestionRunId:f.run.id,
    routingGeneration:1,physicalPageIndex:0,sourcePdfSha256:"a".repeat(64),
    sourcePngSha256:"b".repeat(64),candidateJson:graph,candidateSha256:fp,
    expiresAt:new Date(Date.now()+3600_000),
  }});
  const request=await prisma.pdfGraphSecondReviewRequest.create({data:{
    workspaceId:f.workspace.id,userId:f.user.id,sourceDocumentId:f.doc.id,
    ingestionRunId:f.run.id,routingGeneration:1,physicalPageIndex:0,
    sourcePdfSha256:"a".repeat(64),sourcePngSha256:"b".repeat(64),
    candidateSha256:fp,expiresAt:new Date(Date.now()+600_000),
  }});
  const provider = await prisma.providerConnection.create({data:{
    workspaceId:f.workspace.id, providerKey:"OPENAI",
    displayName:"proof-provider",status:"ACTIVE",protocol:"OPENAI_COMPATIBLE",
  }});
  await prisma.providerRouteBinding.create({data:{
    workspaceId:f.workspace.id,routeSlot:"PDF_VISUAL_STRUCTURE",connectionId:provider.id,
    modelId:"review-fixture",
  }});
  return { ...f, request, provider };
}
const verdict = {
  decision: {
    status:"PASSED" as const,
    axes:Object.fromEntries(PDF_GRAPH_REVIEW_AXES.map(axis=>[axis,{
      status:"CLEAR" as const,reason:"Visible in the original page",
    }])) as Record<(typeof PDF_GRAPH_REVIEW_AXES)[number],{status:"CLEAR";reason:string}>,
    approvedForPodcast:false as const, approvedForBookIntelligence:false as const,
  },
  invocationId:"invocation-fixture",snapshotId:"snapshot-fixture",
  approvedForPodcast:false as const,approvedForBookIntelligence:false as const,
};
type ReviewExecuteTask = Parameters<Parameters<typeof processNextPdfGraphSecondReviewRequest>[0]["execute"]>[0];
function fixtureReceiptRepository(
  getTask: () => ReviewExecuteTask | undefined,
  connectionId: string,
  override?: { malformed?: boolean; onConsume?: () => Promise<void> },
): Pick<ProviderExecutionRepository,"consumeTextResult"> {
  return {
    async consumeTextResult(input, materialize) {
      await override?.onConsume?.();
      const task = getTask();
      if (!task) throw Error("NOT_CALLED");
      const sourceText = task.sourceTextExcerpt.slice(0,1500);
      const textSha256 = createHash("sha256").update(sourceText,"utf8").digest("hex");
      // Simulate decrypted receipt but run the real DB transaction/materializer.
      await prisma.$transaction(async tx => {
        await materialize({
          tx,
          response: {
            type: "STRUCTURED",finishReason:"STOP",
            structured: {
              schemaVersion:1,
              sourceSha256:task.sourcePdfSha256,
              sourcePngSha256:task.sourcePngSha256,
              physicalPageIndex:task.physicalPageIndex,
              candidateSha256:override?.malformed?"d".repeat(64):task.candidateSha256,
              textSha256,
              axes:verdict.decision.axes,
            },
          } as Parameters<typeof materialize>[0]["response"],
          snapshot: {
            id:"snapshot-fixture",workspaceId:task.workspaceId,
            routeSlot:"PDF_VISUAL_STRUCTURE",modelId:"review-fixture",
            connectionId,
          } as Parameters<typeof materialize>[0]["snapshot"],
          receipt:{id:"fake-encrypted-receipt"},
        });
      });
      return {status:"CONSUMED",invocationId:input.invocationId,snapshotId:input.snapshotId};
    },
  };
}
describe("real PostgreSQL second review one-time worker claim",()=>{
  it("stores a bounded, non-publishable result and never bills a second execution",async()=>{
    const f=await readyGraphRequest();
    let called=0;
    let task:ReviewExecuteTask|undefined;
    const execute=async(input:ReviewExecuteTask)=>{task=input;called++;return verdict};
    const repository=fixtureReceiptRepository(()=>task,f.provider.id);
    expect(await processNextPdfGraphSecondReviewRequest({enabled:true,execute,repository})).toBe("DONE");
    expect(called).toBe(1);
    const row=await prisma.pdfGraphSecondReviewRequest.findUniqueOrThrow({where:{id:f.request.id}});
    expect(row).toMatchObject({status:"SUCCEEDED",modelDecision:"PASSED",
      claimToken:null,invocationId:"invocation-fixture",snapshotId:"snapshot-fixture",
    });
    expect(row.modelAxes).toHaveProperty("relationships");
    expect(await processNextPdfGraphSecondReviewRequest({enabled:true,execute,repository})).toBe("IDLE");
    expect(called).toBe(1);
  });
  it("rejects revoked membership before any external model admission, no retry",async()=>{
    const f=await readyGraphRequest();
    await prisma.workspaceMember.update({where:{workspaceId_userId:{
      workspaceId:f.workspace.id,userId:f.user.id,
    }},data:{role:"VIEWER"}});
    let called=0;
    let task:ReviewExecuteTask|undefined;
    const execute=async(input:ReviewExecuteTask)=>{task=input;called++;return verdict};
    const repository=fixtureReceiptRepository(()=>task,f.provider.id);
    expect(await processNextPdfGraphSecondReviewRequest({enabled:true,execute,repository})).toBe("DONE");
    expect(called).toBe(0);
    const row=await prisma.pdfGraphSecondReviewRequest.findUniqueOrThrow({where:{id:f.request.id}});
    expect(row.status).toBe("FAILED");
    expect(row.modelDecision).toBeNull();
    expect(await processNextPdfGraphSecondReviewRequest({enabled:true,execute,repository})).toBe("IDLE");
  });
  it("never reclaims an uncertain RUNNING paid action after process restart",async()=>{
    const f=await readyGraphRequest();
    await prisma.pdfGraphSecondReviewRequest.update({where:{id:f.request.id},data:{
      status:"RUNNING",claimToken:"crashed-owner",startedAt:new Date(),
    }});
    let called=0;
    expect(await processNextPdfGraphSecondReviewRequest({
      enabled:true,execute:async()=>{called++;return verdict},
      repository:fixtureReceiptRepository(()=>undefined,f.provider.id),
    })).toBe("IDLE");
    expect(called).toBe(0);
  });
  it("rejects mismatched decrypted receipt identity and does not mark PASSED",async()=>{
    const f=await readyGraphRequest();
    let task:ReviewExecuteTask|undefined,called=0;
    const execute=async(input:ReviewExecuteTask)=>{task=input;called++;return verdict};
    const repository=fixtureReceiptRepository(()=>task,f.provider.id,{malformed:true});
    expect(await processNextPdfGraphSecondReviewRequest({enabled:true,execute,repository})).toBe("DONE");
    expect(called).toBe(1);
    const row=await prisma.pdfGraphSecondReviewRequest.findUniqueOrThrow({where:{id:f.request.id}});
    expect(row).toMatchObject({status:"FAILED",modelDecision:null,
      invocationId:"invocation-fixture",claimToken:null});
    expect(await processNextPdfGraphSecondReviewRequest({enabled:true,execute,repository})).toBe("IDLE");
    expect(called).toBe(1);
  });
  it("blocks revocation after Gateway reply and before receipt consumption",async()=>{
    const f=await readyGraphRequest();
    let task:ReviewExecuteTask|undefined;
    const execute=async(input:ReviewExecuteTask)=>{task=input;return verdict};
    const repository=fixtureReceiptRepository(()=>task,f.provider.id,{
      onConsume:async()=>{await prisma.workspaceMember.update({
        where:{workspaceId_userId:{workspaceId:f.workspace.id,userId:f.user.id}},
        data:{role:"VIEWER"},
      });},
    });
    expect(await processNextPdfGraphSecondReviewRequest({enabled:true,execute,repository})).toBe("DONE");
    const row=await prisma.pdfGraphSecondReviewRequest.findUniqueOrThrow({where:{id:f.request.id}});
    expect(row.status).toBe("FAILED");
    expect(row.modelDecision).toBeNull();
  });

});
