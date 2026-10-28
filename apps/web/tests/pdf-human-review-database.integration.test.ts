import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { pdfReviewCandidateFingerprint } from "@ai-cognitive/ingestion";
import { submitPdfHumanReview } from "../lib/pdf-human-review";

const graph={
  schemaVersion:1,figures:[{
    id:"f1",kind:"DIAGRAM",bbox:[0,0,200,300],caption:"fixture only",
    nodes:[{id:"n1",label:"source"},{id:"n2",label:"target"}],
    edges:[{from:"n1",to:"n2",label:"arrow",direction:"DIRECTED"}],
  }],
};
const owned:Array<{workspaceId:string,userId:string}>=[];
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
async function make() {
  const uid=randomUUID(),sourceSha=sha(uid);
  const user=await prisma.user.create({data:{email:uid+"@human-review.test"}});
  const workspace=await prisma.workspace.create({data:{name:uid}});
  owned.push({workspaceId:workspace.id,userId:user.id});
  await prisma.workspaceMember.create({data:{workspaceId:workspace.id,userId:user.id,role:"OWNER"}});
  const source=await prisma.source.create({
    data:{workspaceId:workspace.id,kind:"FILE",displayName:"fixture.pdf"},
  });
  const blob=await prisma.sourceBlob.create({data:{
    workspaceId:workspace.id,sha256:sourceSha,sizeBytes:999n,
    mediaType:"application/pdf",storageKey:"private/"+uid,
  }});
  const doc=await prisma.sourceDocument.create({data:{
    workspaceId:workspace.id,sourceId:source.id,sourceBlobId:blob.id,
    version:1,sha256:sourceSha,sizeBytes:999n,
    mediaType:"application/pdf",storageKey:"private/"+uid,
  }});
  const job=await prisma.job.create({data:{
    workspaceId:workspace.id,userId:user.id,type:"source.ingest",status:"SUCCEEDED",payload:{},
  }});
  const run=await prisma.ingestionRun.create({data:{
    workspaceId:workspace.id,sourceDocumentId:doc.id,jobId:job.id,
    status:"SUCCEEDED",parserVersion:"review-fixture",normalizationVersion:"v1",
    routingGeneration:1,routingPlan:{pages:[]},
  }});
  const extraction=await prisma.documentExtraction.create({data:{
    workspaceId:workspace.id,sourceDocumentId:doc.id,ingestionRunId:run.id,
    status:"SUCCEEDED",parserName:"PDFJS_NATIVE",parserVersion:"v1",normalizationVersion:"v1",
  }});
  await prisma.currentDocumentExtraction.create({data:{
    workspaceId:workspace.id,sourceDocumentId:doc.id,extractionId:extraction.id,
  }});
  const candidate=await prisma.pdfVisualReviewCandidate.create({data:{
    workspaceId:workspace.id,sourceDocumentId:doc.id,ingestionRunId:run.id,
    routingGeneration:1,physicalPageIndex:0,
    sourcePdfSha256:sourceSha,sourcePngSha256:sha("png"+uid),
    candidateJson:graph,candidateSha256:pdfReviewCandidateFingerprint(graph),
    expiresAt:new Date(Date.now()+3600_000),
  }});
  return {user,workspace,doc,candidate};
}
afterEach(async()=>{
  for(const x of owned.splice(0)){
    const where={workspaceId:x.workspaceId};
    await prisma.pdfVisualHumanReviewEvent.deleteMany({where});
    await prisma.pdfVisualReviewCandidate.deleteMany({where});
    await prisma.currentDocumentExtraction.deleteMany({where});
    await prisma.documentExtraction.deleteMany({where});
    await prisma.ingestionRun.deleteMany({where});
    await prisma.job.deleteMany({where});
    await prisma.sourceDocument.deleteMany({where});
    await prisma.sourceBlob.deleteMany({where});
    await prisma.source.deleteMany({where});
    await prisma.workspaceMember.deleteMany({where});
    await prisma.workspace.delete({where:{id:x.workspaceId}});
    await prisma.user.delete({where:{id:x.userId}});
  }
});
const act=(f:Awaited<ReturnType<typeof make>>,action:"CONFIRM_STRUCTURE"|"REJECT_STRUCTURE"|"WITHDRAW",prev:string|null=null)=>({
  workspaceId:f.workspace.id,sourceDocumentId:f.doc.id,reviewerUserId:f.user.id,
  submission:{candidateId:f.candidate.id,candidateSha256:f.candidate.candidateSha256,
    previousEventId:prev,action,comparedWithOriginalPdf:true as const},
});

describe("real PostgreSQL manual graph review evidence",()=>{
  it("commits immutable confirm -> withdraw -> reject events without changing candidate",async()=>{
    const f=await make();
    const first=await submitPdfHumanReview(act(f,"CONFIRM_STRUCTURE"));
    const undo=await submitPdfHumanReview(act(f,"WITHDRAW",first.eventId));
    await submitPdfHumanReview(act(f,"REJECT_STRUCTURE",undo.eventId));
    const events=await prisma.pdfVisualHumanReviewEvent.findMany({
      where:{candidateId:f.candidate.id},orderBy:[{createdAt:"asc"},{id:"asc"}],
    });
    expect(events.map(e=>e.action).sort()).toEqual(["CONFIRM_STRUCTURE","REJECT_STRUCTURE","WITHDRAW"].sort());
    expect(events.every(e=>e.sourcePdfSha256===f.doc.sha256 &&
      e.candidateSha256===f.candidate.candidateSha256 &&
      e.reviewerUserId===f.user.id)).toBe(true);
    expect(await prisma.pdfVisualReviewCandidate.findUniqueOrThrow({where:{id:f.candidate.id}}))
      .toMatchObject({candidateSha256:f.candidate.candidateSha256});
  });
  it("refuses stale parallel verdict, role downgrade and expired candidate",async()=>{
    const f=await make();
    const first=await submitPdfHumanReview(act(f,"CONFIRM_STRUCTURE"));
    await expect(submitPdfHumanReview(act(f,"REJECT_STRUCTURE")))
      .rejects.toThrow("PDF_HUMAN_REVIEW_CONFLICT");
    await prisma.workspaceMember.update({
      where:{workspaceId_userId:{workspaceId:f.workspace.id,userId:f.user.id}},
      data:{role:"VIEWER"},
    });
    await expect(submitPdfHumanReview(act(f,"WITHDRAW",first.eventId)))
      .rejects.toThrow("PDF_HUMAN_REVIEW_FORBIDDEN");
    await prisma.workspaceMember.update({
      where:{workspaceId_userId:{workspaceId:f.workspace.id,userId:f.user.id}},
      data:{role:"OWNER"},
    });
    await prisma.pdfVisualReviewCandidate.update({
      where:{id:f.candidate.id},data:{expiresAt:new Date(Date.now()-60_000)},
    });
    await expect(submitPdfHumanReview(act(f,"WITHDRAW",first.eventId)))
      .rejects.toThrow("PDF_HUMAN_REVIEW_CANDIDATE_STALE");
  });
});
