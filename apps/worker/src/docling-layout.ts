import { Queue, Worker } from "bullmq";
import { prisma } from "@ai-cognitive/db";
import { claimDoclingTask, ensureDoclingTask, finishDoclingTask, markLegacyDoclingSnapshotSettled, permanentlyFailExhaustedDoclingTask, DOCLING_TASK_MAX_ATTEMPTS } from "./docling-task-ledger.js";
import {
  createDoclingLayoutCandidateExecutor,
  inspectAndPersistDoclingLayoutSidecar,
  parseRoutingPlan,
  resolveDoclingLayoutConfig,
  selectDoclingLayoutPages,
  verifyDoclingLayout,
  type DoclingLayoutHandle,
} from "@ai-cognitive/ingestion";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";
import { S3CompatibleStorageProvider, type StorageProvider } from "@ai-cognitive/storage";

export const DOCLING_LAYOUT_QUEUE = "source.docling-layout-candidate.v1";
export const DOCLING_LAYOUT_JOB = "docling-layout-candidate";
const MAX_SOURCE_BYTES = 110_000_000;
const MAX_RUNS_PER_SWEEP = 20;
// An operator enabling this feature should not launch an unbounded historical
// reprocessing workload. Older content must be explicitly migrated later.
const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type DoclingLayoutQueueData = {
  ingestionRunId: string;
  physicalPageIndex: number;
  modelSha256: string;
};
export type DoclingSweepCursor = { afterRunId?: string };
export type DoclingLayoutRuntime = {
  executor: DoclingLayoutHandle;
  queue: Queue<DoclingLayoutQueueData>;
  worker: Worker<DoclingLayoutQueueData>;
  cursor: DoclingSweepCursor;
};

export function doclingLayoutJobId(data: DoclingLayoutQueueData, spentAttempts = 0): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(data.ingestionRunId) ||
      !Number.isSafeInteger(data.physicalPageIndex) || data.physicalPageIndex < 0 ||
      !/^[a-f0-9]{64}$/.test(data.modelSha256))
    throw new Error("DOCLING_LAYOUT_JOB_IDENTITY_INVALID");
  // BullMQ job IDs cannot contain colons; the first-party version is part of
  // the queue name so a stable run/page/model identity is sufficient.
  if(!Number.isSafeInteger(spentAttempts)||spentAttempts<0||spentAttempts>=DOCLING_TASK_MAX_ATTEMPTS)
    throw new Error("DOCLING_LAYOUT_JOB_ATTEMPT_INVALID");
  return data.ingestionRunId + "-" + data.physicalPageIndex + "-" + data.modelSha256 +
    (spentAttempts?"-retry-"+spentAttempts:"");
}

function storageFor(environment: Environment): StorageProvider {
  return new S3CompatibleStorageProvider({
    endpoint:environment.S3_ENDPOINT,region:environment.S3_REGION,
    bucket:environment.S3_BUCKET,accessKey:environment.S3_ACCESS_KEY,
    secretKey:environment.S3_SECRET_KEY,
    forcePathStyle:environment.S3_FORCE_PATH_STYLE,
  });
}

/** Explicit startup gate; no OCR provider replacement or implicit downloads. */
export async function resolveDoclingBackgroundExecutor(
  environment:Environment,
):Promise<DoclingLayoutHandle|null> {
  const config=resolveDoclingLayoutConfig({
    enabled:environment.DOCLING_LAYOUT_ENABLED,
    python:environment.DOCLING_LAYOUT_PYTHON_PATH,
    artifacts:environment.DOCLING_LAYOUT_ARTIFACTS_PATH,
  });
  if(!config)return null;
  const verified=await verifyDoclingLayout(config);
  return createDoclingLayoutCandidateExecutor(config,verified);
}

/** Never pass the PDF or candidate Markdown through Redis. */
export function createDoclingLayoutQueue(environment:Environment,prefix?:string):
  Queue<DoclingLayoutQueueData> {
  return new Queue<DoclingLayoutQueueData>(DOCLING_LAYOUT_QUEUE,{
    connection:createRedisConnection(environment.REDIS_URL),
    ...(prefix?{prefix}:{}),
    defaultJobOptions:{
      attempts:2,
      backoff:{type:"fixed",delay:30_000},
      removeOnComplete:1000,
      // Keep final failed jobs: recurring scans cannot endlessly reissue a
      // failed model attempt while Redis still holds the terminal job.
      removeOnFail:false,
    },
  });
}

async function readBoundedPdf(storage:StorageProvider,key:string):Promise<Uint8Array> {
  const metadata=await storage.headObject(key);
  if(!metadata||!Number.isSafeInteger(metadata.size)||
     metadata.size<5||metadata.size>MAX_SOURCE_BYTES)
    throw new Error("DOCLING_LAYOUT_SOURCE_SIZE_INVALID");
  const parts:Uint8Array[]=[];
  let count=0;
  for await(const chunk of await storage.getObjectStream(key)){
    count+=chunk.length;
    if(count>MAX_SOURCE_BYTES||count>metadata.size)
      throw new Error("DOCLING_LAYOUT_SOURCE_STREAM_TOO_LARGE");
    parts.push(chunk);
  }
  if(count!==metadata.size)throw new Error("DOCLING_LAYOUT_SOURCE_STREAM_SIZE_MISMATCH");
  const bytes=new Uint8Array(count);
  let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  return bytes;
}

export async function executeDoclingBackgroundJob(
  data:DoclingLayoutQueueData,
  storage:StorageProvider,
  executor:DoclingLayoutHandle,
):Promise<"SNAPSHOT_CREATED"|"SNAPSHOT_REUSED"|"SKIPPED_BUSY"> {
  doclingLayoutJobId(data);
  if(data.modelSha256!==executor.modelSha256)
    throw new Error("DOCLING_LAYOUT_MODEL_CHANGED");
  const run=await prisma.ingestionRun.findUnique({
    where:{id:data.ingestionRunId},
    include:{sourceDocument:true},
  });
  if(!run||run.status!=="SUCCEEDED"||
     run.sourceDocument.mediaType!=="application/pdf"||
     run.routingPlan===null||run.routingGeneration===null)
    throw new Error("DOCLING_LAYOUT_RUN_NOT_READY");
  const pages=selectDoclingLayoutPages(parseRoutingPlan(run.routingPlan));
  if(!pages.includes(data.physicalPageIndex))
    throw new Error("DOCLING_LAYOUT_PAGE_NOT_ELIGIBLE");

  const task=await ensureDoclingTask({
    ingestionRunId:run.id,physicalPageIndex:data.physicalPageIndex,
    routingGeneration:run.routingGeneration,modelSha256:data.modelSha256,
    workspaceId:run.workspaceId,sourceDocumentId:run.sourceDocumentId,
  });
  const claim=await claimDoclingTask(task.id);
  if(!claim){
    const current=await prisma.doclingLayoutTask.findUniqueOrThrow({where:{id:task.id}});
    if(current.status==="RUNNING")return "SKIPPED_BUSY";
    if(current.status!=="SUCCEEDED")throw new Error("DOCLING_LAYOUT_DURABLE_ATTEMPTS_EXHAUSTED");
    // Completed rows only replay existing immutable metadata, never call model.
    const snapshot=await prisma.doclingLayoutSnapshot.findUnique({
      where:{byPageAndModel:{
        ingestionRunId:run.id,physicalPageIndex:data.physicalPageIndex,
        routingGeneration:run.routingGeneration,parserName:"docling-standard-layout",
        parserVersion:"2.141.0",modelSha256:data.modelSha256,
      }},
    });
    if(!snapshot)throw new Error("DOCLING_LAYOUT_TASK_SNAPSHOT_MISSING");
  }

  try{
    // Bounded source read occurs after durable claim, before candidate model.
    const bytes=await readBoundedPdf(storage,run.sourceDocument.storageKey);
    const receipt=await inspectAndPersistDoclingLayoutSidecar({
      workspaceId:run.workspaceId,
      sourceDocumentId:run.sourceDocumentId,
      ingestionRunId:run.id,
      physicalPageIndex:data.physicalPageIndex,
      pdfBytes:bytes,
      storage,executor,
      ...(claim?{claim:{id:claim.id,token:claim.token}}:{}),
    });
    if(claim && !(await finishDoclingTask(claim,true)))
      throw new Error("DOCLING_LAYOUT_CLAIM_LOST");
    return receipt.reused?"SNAPSHOT_REUSED":"SNAPSHOT_CREATED";
  }catch(error){
    if(claim)await finishDoclingTask(claim,false);
    throw error;
  }
}

export function createDoclingLayoutWorker(
  environment:Environment,executor:DoclingLayoutHandle,options?:{prefix?:string;storage?:StorageProvider},
):Worker<DoclingLayoutQueueData> {
  const storage=options?.storage??storageFor(environment);
  return new Worker<DoclingLayoutQueueData>(DOCLING_LAYOUT_QUEUE,async(job)=>{
    // Do not store provider/DB credentials or raw stderr in failed BullMQ
    // jobs. This candidate is never authoritative text publication.
    try{return await executeDoclingBackgroundJob(job.data,storage,executor);}
    catch{throw new Error("DOCLING_LAYOUT_BACKGROUND_JOB_REJECTED");}
  },{
    connection:createRedisConnection(environment.REDIS_URL),
    concurrency:1,
    ...(options?.prefix?{prefix:options.prefix}:{}),
  });
}

/**
 * Source-of-truth scan of SUCCEEDED ingestions (not a second publication
 * queue). Exact-run BullMQ IDs and the DB snapshot unique key deduplicate
 * scheduled candidates. Cursor advances only after the entire page is
 * enqueued; a transient Redis error replays safely on next sweep.
 */
export async function dispatchDoclingLayoutSweep(
  queue:Pick<Queue<DoclingLayoutQueueData>,"add">,
  modelSha256:string,cursor:DoclingSweepCursor,
  options:{now?:Date;take?:number}={},
):Promise<number> {
  if(!/^[a-f0-9]{64}$/.test(modelSha256))
    throw new Error("DOCLING_LAYOUT_MODEL_INVALID");
  const take=options.take??MAX_RUNS_PER_SWEEP;
  if(!Number.isSafeInteger(take)||take<1||take>MAX_RUNS_PER_SWEEP)
    throw new Error("DOCLING_LAYOUT_SWEEP_BUDGET_INVALID");
  const earliest=new Date((options.now??new Date()).getTime()-MAX_LOOKBACK_MS);
  const runs=await prisma.ingestionRun.findMany({
    where:{
      status:"SUCCEEDED",
      completedAt:{gte:earliest},
      sourceDocument:{mediaType:"application/pdf"},
      extraction:{is:{status:"SUCCEEDED"}},
    },
    orderBy:[{completedAt:"asc"},{id:"asc"}],
    take,
    ...(cursor.afterRunId?{cursor:{id:cursor.afterRunId},skip:1}:{}),
    select:{
      id:true,routingGeneration:true,routingPlan:true,
      sourceDocumentId:true,workspaceId:true,
    },
  });
  if(!runs.length){delete cursor.afterRunId;return 0;}
  let enqueued=0;
  for(const run of runs){
    if(run.routingPlan!==null&&run.routingGeneration!==null){
      // Malformed historical routing plans must not starve all later runs.
      let pages:number[]=[];
      try{pages=selectDoclingLayoutPages(parseRoutingPlan(run.routingPlan));}
      catch{pages=[];}
      for(const physicalPageIndex of pages){
        const existing=await prisma.doclingLayoutSnapshot.findUnique({
          where:{byPageAndModel:{
            ingestionRunId:run.id,physicalPageIndex,
            routingGeneration:run.routingGeneration,
            parserName:"docling-standard-layout",parserVersion:"2.141.0",
            modelSha256,
          }},
          select:{id:true},
        });
        const task=await ensureDoclingTask({
          ingestionRunId:run.id,physicalPageIndex,
          routingGeneration:run.routingGeneration,modelSha256,
          workspaceId:run.workspaceId,sourceDocumentId:run.sourceDocumentId,
        });
        if(existing){
          await markLegacyDoclingSnapshotSettled(task.id);
          continue;
        }
        if(task.status==="SUCCEEDED"||task.status==="FAILED")continue;
        if(task.attemptCount>=DOCLING_TASK_MAX_ATTEMPTS){
          await permanentlyFailExhaustedDoclingTask(task.id);
          continue;
        }
        if(task.status==="RUNNING"&&task.leaseUntil&&task.leaseUntil>new Date())continue;
        const payload={ingestionRunId:run.id,physicalPageIndex,modelSha256};
        await queue.add(DOCLING_LAYOUT_JOB,payload,{
          // A retry gets a NEW Redis delivery ID while sharing the same
          // DB claim and total-attempt budget, surviving total Redis loss.
          jobId:doclingLayoutJobId(payload,task.attemptCount),
        });
        enqueued++;
      }
    }
    // Advancing once per fully scanned run is safe under partial queue
    // errors; a retry repeats only this run, with deduped IDs.
    cursor.afterRunId=run.id;
  }
  return enqueued;
}
