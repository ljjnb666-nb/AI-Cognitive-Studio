import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";

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
