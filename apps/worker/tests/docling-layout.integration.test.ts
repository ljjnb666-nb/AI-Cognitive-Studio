import { afterAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import type { StorageProvider } from "@ai-cognitive/storage";
import type { DoclingLayoutHandle } from "@ai-cognitive/ingestion";
import type { Queue } from "bullmq";
import {
  DOCLING_LAYOUT_JOB,
  dispatchDoclingLayoutSweep,
  doclingLayoutJobId,
  executeDoclingBackgroundJob,
  type DoclingLayoutQueueData,
} from "../src/docling-layout.js";

const modelSha="b".repeat(64);
const future=new Date("2099-01-02T00:00:00.000Z");
const bytes=Buffer.from("%PDF-1.7\nOWNED_SYNTHETIC_ONLY");
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");

function routingPlan(){
  return {
    schemaVersion:"pdf-routing-plan-v1",
    inspector:{version:"pdf-inspector-v1"},
    parser:{name:"pdfjs-isolated",version:"pdf-router-v1"},
    pageCount:3,
    pages:[
      {physicalPageIndex:0,route:"NATIVE_TEXT",contentEvidence:"TEXT",reasonCodes:["NATIVE_TEXT_PRESENT"]},
      {physicalPageIndex:1,route:"OCR_REQUIRED",contentEvidence:"NON_TEXT_CONTENT",reasonCodes:["IMAGE_CONTENT_WITHOUT_TEXT"]},
      {physicalPageIndex:2,route:"NATIVE_TEXT",contentEvidence:"TEXT",reasonCodes:["NATIVE_TEXT_PRESENT"]},
    ],
  };
}
async function fixture(){
  const user=await prisma.user.create({
    data:{email:"docling-queue-"+randomUUID()+"@test.invalid",name:"Layout Test"},
  });
  const workspace=await prisma.workspace.create({data:{name:"docling-queue-"+randomUUID()}});
  await prisma.workspaceMember.create({
    data:{workspaceId:workspace.id,userId:user.id,role:"OWNER"},
  });
  const storageKey="private/"+randomUUID()+"/synthetic.pdf";
  const blob=await prisma.sourceBlob.create({
    data:{workspaceId:workspace.id,sha256:digest(bytes),
      sizeBytes:BigInt(bytes.length),mediaType:"application/pdf",storageKey},
  });
  const source=await prisma.source.create({
    data:{workspaceId:workspace.id,kind:"FILE",displayName:"docling-candidate-synthetic.pdf"},
  });
  const document=await prisma.sourceDocument.create({
    data:{sourceId:source.id,sourceBlobId:blob.id,workspaceId:workspace.id,
      version:1,sha256:digest(bytes),sizeBytes:BigInt(bytes.length),
      mediaType:"application/pdf",storageKey},
  });
  const job=await prisma.job.create({
    data:{userId:user.id,workspaceId:workspace.id,type:"source.ingest",
      payload:{sourceDocumentId:document.id}},
  });
  const run=await prisma.ingestionRun.create({
    data:{sourceDocumentId:document.id,workspaceId:workspace.id,jobId:job.id,
      status:"SUCCEEDED",completedAt:future,
      parserVersion:"pdf-router-v1",normalizationVersion:"canonical-text-v1",
      routingGeneration:1,routingPlan:routingPlan()},
  });
  await prisma.documentExtraction.create({
    data:{ingestionRunId:run.id,sourceDocumentId:document.id,
      workspaceId:workspace.id,status:"SUCCEEDED",
      parserName:"pdfjs-isolated",parserVersion:"pdf-router-v1",
      normalizationVersion:"canonical-text-v1"},
  });
  return {user,workspace,source,document,job,run,blob,storageKey};
}
async function cleanup(f:Awaited<ReturnType<typeof fixture>>){
  await prisma.doclingLayoutSnapshot.deleteMany({where:{ingestionRunId:f.run.id}});
  await prisma.documentExtraction.deleteMany({where:{ingestionRunId:f.run.id}});
  await prisma.ingestionRun.delete({where:{id:f.run.id}});
  await prisma.job.delete({where:{id:f.job.id}});
  await prisma.sourceDocument.delete({where:{id:f.document.id}});
  await prisma.source.delete({where:{id:f.source.id}});
  await prisma.sourceBlob.delete({where:{id:f.blob.id}});
  await prisma.workspaceMember.deleteMany({where:{workspaceId:f.workspace.id}});
  await prisma.workspace.delete({where:{id:f.workspace.id}});
  await prisma.user.delete({where:{id:f.user.id}});
}

class SyntheticStorage {
  readonly objects=new Map<string,Uint8Array>();
  async headObject(key:string){
    const item=this.objects.get(key);
    return item?{key,size:item.length,contentType:"application/pdf"}:null;
  }
  async getObjectStream(key:string){
    const item=this.objects.get(key);
    if(!item)throw new Error("OBJECT_MISSING");
    return (async function*(){yield item;})();
  }
  async getObjectBytes(key:string){
    const item=this.objects.get(key);
    if(!item)throw new Error("OBJECT_MISSING");
    return item;
  }
  async putObject({key,body}:{key:string;body:Uint8Array}){
    this.objects.set(key,body);
  }
}

describe("Docling background dispatch (real PostgreSQL, synthetic source only)",()=>{
  afterAll(async()=>{await prisma.$disconnect();});

  it("bounded sweep schedules exact physical-page job and skips durable model snapshot",async()=>{
    const f=await fixture();
    try{
      const attempts:Array<{name:string;payload:DoclingLayoutQueueData;jobId:string}>=[];
      const queue={add:vi.fn(async(name:string,payload:DoclingLayoutQueueData,options:{jobId?:string})=>{
        attempts.push({name,payload,jobId:options.jobId??""});
      })} as unknown as Pick<Queue<DoclingLayoutQueueData>,"add">;
      const cursor:{afterRunId?:string}={};
      expect(await dispatchDoclingLayoutSweep(queue,modelSha,cursor,{now:future,take:2})).toBe(1);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toEqual({
        name:DOCLING_LAYOUT_JOB,
        payload:{ingestionRunId:f.run.id,physicalPageIndex:1,modelSha256:modelSha},
        jobId:doclingLayoutJobId({ingestionRunId:f.run.id,physicalPageIndex:1,modelSha256:modelSha}),
      });
      expect(cursor.afterRunId).toBe(f.run.id);
      expect(await dispatchDoclingLayoutSweep(queue,modelSha,cursor,{now:future,take:2})).toBe(0);
      expect(cursor.afterRunId).toBeUndefined();
      await prisma.doclingLayoutSnapshot.create({
        data:{workspaceId:f.workspace.id,sourceDocumentId:f.document.id,ingestionRunId:f.run.id,
          physicalPageIndex:1,routingGeneration:1,sourceSha256:digest(bytes),
          parserName:"docling-standard-layout",parserVersion:"2.141.0",
          modelSha256:modelSha,markdownSha256:digest(Buffer.from("# layout")),
          markdownStorageKey:"workspaces/"+f.workspace.id+"/synthetic-layout",
          textItemCount:1,pictureItemCount:0,tableItemCount:0},
      });
      expect(await dispatchDoclingLayoutSweep(queue,modelSha,cursor,{now:future,take:2})).toBe(0);
      expect(attempts).toHaveLength(1);
      await prisma.documentExtraction.update({
        where:{ingestionRunId:f.run.id},data:{status:"FAILED"},
      });
      expect(await dispatchDoclingLayoutSweep(queue,modelSha,{}, {now:future,take:2})).toBe(0);
    }finally{await cleanup(f);}
  },30_000);

  it("queued worker reads bounded original bytes and creates only a non-authoritative snapshot",async()=>{
    const f=await fixture();
    try{
      const storage=new SyntheticStorage();
      storage.objects.set(f.storageKey,bytes);
      const inspect=vi.fn(async({pdfBytes,physicalPageIndex}:{pdfBytes:Uint8Array;physicalPageIndex:number})=>{
        expect(Buffer.from(pdfBytes)).toEqual(bytes);
        return {
          status:"SUCCEEDED" as const,
          candidate:{
            authority:"NON_AUTHORITATIVE_LAYOUT_CANDIDATE" as const,
            sourceMethod:"DOCLING_LAYOUT_CANDIDATE_ONLY" as const,
            physicalPageIndex,ocrUsed:false as const,fullPageReference:false as const,
            parserName:"docling-standard-layout" as const,parserVersion:"2.141.0" as const,
            artifactSha256:modelSha,markdown:"# Synthetic Candidate",
            textItemCount:1,pictureItemCount:0,tableItemCount:0,
          },
        };
      });
      const executor:DoclingLayoutHandle={
        parserName:"docling-standard-layout",modelSha256:modelSha,
        inspect,close:async()=>undefined,
      };
      const data={ingestionRunId:f.run.id,physicalPageIndex:1,modelSha256:modelSha};
      expect(await executeDoclingBackgroundJob(data,storage as unknown as StorageProvider,executor))
        .toBe("SNAPSHOT_CREATED");
      expect(await executeDoclingBackgroundJob(data,storage as unknown as StorageProvider,executor))
        .toBe("SNAPSHOT_REUSED");
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(await prisma.doclingLayoutSnapshot.count({where:{ingestionRunId:f.run.id}})).toBe(1);
      await expect(executeDoclingBackgroundJob({...data,physicalPageIndex:0},storage as unknown as StorageProvider,executor))
        .rejects.toThrow("DOCLING_LAYOUT_PAGE_NOT_ELIGIBLE");
      await expect(executeDoclingBackgroundJob({...data,modelSha256:"d".repeat(64)},storage as unknown as StorageProvider,executor))
        .rejects.toThrow("DOCLING_LAYOUT_MODEL_CHANGED");
      expect(inspect).toHaveBeenCalledTimes(1);
    }finally{await cleanup(f);}
  },30_000);
});
