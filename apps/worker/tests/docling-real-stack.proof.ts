/**
 * Synthetic original PDF -> real local Docling 2.141.0 -> BullMQ Redis ->
 * PostgreSQL durable claim -> content-addressed MinIO sidecar.
 *
 * Run ONLY on an isolated Windows owner runner with explicitly-provisioned
 * local disposable infrastructure. Never run against live application DBs.
 * Outputs are fixed status receipts, not text or private book bytes.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { prisma } from "@ai-cognitive/db";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";
import {
  createDoclingLayoutCandidateExecutor, resolveDoclingLayoutConfig,
  verifyDoclingLayout,
} from "@ai-cognitive/ingestion";
import { QueueEvents } from "bullmq";
import {
  DOCLING_LAYOUT_QUEUE, createDoclingLayoutQueue, createDoclingLayoutWorker,
  dispatchDoclingLayoutSweep, doclingLayoutJobId, executeDoclingBackgroundJob,
} from "../src/docling-layout.js";

const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function ensure(condition:unknown,code:string):asserts condition{
  if(!condition)throw new Error(code);
}
function required(name:string):string{
  const value=process.env[name];
  if(!value)throw new Error("REAL_DOCLING_E2E_CONFIG_MISSING");
  return value;
}
function localUrl(value:string,proto:string):void{
  const url=new URL(value);
  ensure(url.protocol===proto && ["127.0.0.1","localhost"].includes(url.hostname),
    "REAL_DOCLING_E2E_NONLOCAL_ENDPOINT_REJECTED");
}
async function main():Promise<void>{
  let stage="ADMISSION";
  const markStage=(value:string):void=>{
    stage=value;
    // Bounded, fixed vocabulary: no user files, model stderr or credentials.
    console.log("ACS_DOCLING_REAL_STACK_PROOF_STAGE="+value);
  };
  markStage("ADMISSION");
  // A dedicated sandbox is mandatory: this must never mutate a non-test DB.
  ensure(process.env.ACS_DOCLING_REAL_STACK_E2E==="1","REAL_DOCLING_E2E_OPT_IN_REQUIRED");
  ensure(process.platform==="win32","REAL_DOCLING_E2E_WINDOWS_REQUIRED");
  const databaseUrl=required("DATABASE_URL"), redisUrl=required("REDIS_URL");
  const s3Endpoint=required("S3_ENDPOINT");
  localUrl(databaseUrl,"postgresql:");
  localUrl(redisUrl,"redis:");
  localUrl(s3Endpoint,"http:");
  ensure(databaseUrl.includes("/acs_docling_e2e_"),"REAL_DOCLING_E2E_DB_NAME_REJECTED");
  ensure(required("S3_BUCKET")==="acs-docling-e2e","REAL_DOCLING_E2E_BUCKET_REJECTED");
  const pdf=await readFile(required("ACS_DOCLING_REAL_SYNTHETIC_PDF"));
  ensure(pdf.length>10 && pdf.subarray(0,5).toString()==="%PDF-",
    "REAL_DOCLING_E2E_SOURCE_INVALID");
  const sourceHash=hash(pdf);
  markStage("OFFLINE_MODEL_PROBE");
  const config=resolveDoclingLayoutConfig({
    enabled:true,
    python:required("DOCLING_LAYOUT_PYTHON_PATH"),
    artifacts:required("DOCLING_LAYOUT_ARTIFACTS_PATH"),
    timeoutMs:180_000,
  });
  ensure(config,"REAL_DOCLING_E2E_CONFIG_INVALID");
  const verified=await verifyDoclingLayout(config);
  const executor=createDoclingLayoutCandidateExecutor(config,verified);
  const storage=new S3CompatibleStorageProvider({
    endpoint:s3Endpoint,
    bucket:required("S3_BUCKET"),
    region:required("S3_REGION"),
    accessKey:required("S3_ACCESS_KEY"),
    secretKey:required("S3_SECRET_KEY"),
    forcePathStyle:true,
  });
  const suffix=randomUUID().replaceAll("-","");
  const workspaceName="acs-real-docling-e2e-"+suffix;
  const prefix="acsdoclinge2e"+suffix;
  const env={REDIS_URL:redisUrl} as Environment;
  // Created only after both local endpoint and unique DB-name guards.
  const queue=createDoclingLayoutQueue(env,prefix);
  const events=new QueueEvents(DOCLING_LAYOUT_QUEUE,{
    connection:createRedisConnection(redisUrl),prefix,
  });
  const worker=createDoclingLayoutWorker(env,executor,{prefix,storage});
  const sourceKey="synthetic/e2e/"+suffix+"/source.pdf";
  let workspaceId:string|undefined,userId:string|undefined,
    sourceId:string|undefined,blobId:string|undefined,docId:string|undefined,
    jobId:string|undefined,runId:string|undefined;
  let artifactKey:string|undefined;
  // BullMQ receives externally-created ioredis clients from our queue/worker
  // factories. Closing BullMQ objects alone does not close those clients.
  // Capture ownership in this isolated proof before cleanup.
  const ownedRedisClients:Array<{disconnect:()=>void}> = [];
  let cleanupRejected=false;
  async function cleanupStep(label:string,operation:()=>Promise<unknown>):Promise<void>{
    try{
      await operation();
      console.log("ACS_DOCLING_REAL_STACK_TEARDOWN_"+label+"=PASS");
    }catch{
      cleanupRejected=true;
      // Never print exception messages, connection URLs or local paths.
      console.log("ACS_DOCLING_REAL_STACK_TEARDOWN_"+label+"=REJECTED");
    }
  }
  try{
    markStage("INFRASTRUCTURE");
    await Promise.all([worker.waitUntilReady(),events.waitUntilReady()]);
    const [queueRedis,eventsRedis,workerRedis]=await Promise.all([
      queue.client,events.client,worker.client,
    ]);
    ownedRedisClients.push(queueRedis,eventsRedis,workerRedis);
    ensure(await storage.bucketExists(),"REAL_DOCLING_E2E_BUCKET_MISSING");
    await storage.putObject({key:sourceKey,body:pdf,contentType:"application/pdf"});
    const h=await storage.headObject(sourceKey);
    ensure(h?.size===pdf.length,"REAL_DOCLING_E2E_SOURCE_S3_MISMATCH");
    markStage("LINEAGE_SEED");
    const user=await prisma.user.create({data:{email:suffix+"@acs-docling-e2e.invalid"}});
    userId=user.id;
    const workspace=await prisma.workspace.create({data:{name:workspaceName}});
    workspaceId=workspace.id;
    await prisma.workspaceMember.create({data:{workspaceId,userId,role:"OWNER"}});
    const source=await prisma.source.create({
      data:{workspaceId,kind:"FILE",displayName:"synthetic-three-page.pdf"},
    });
    sourceId=source.id;
    const blob=await prisma.sourceBlob.create({
      data:{workspaceId,sha256:sourceHash,sizeBytes:BigInt(pdf.length),
        mediaType:"application/pdf",storageKey:sourceKey},
    });
    blobId=blob.id;
    const doc=await prisma.sourceDocument.create({
      data:{workspaceId,sourceId,sourceBlobId:blobId,version:1,sha256:sourceHash,
        sizeBytes:BigInt(pdf.length),mediaType:"application/pdf",storageKey:sourceKey},
    });
    docId=doc.id;
    const job=await prisma.job.create({
      data:{userId,workspaceId,type:"source.ingest",
        payload:{sourceDocumentId:docId}},
    });
    jobId=job.id;
    const routingPlan={
      schemaVersion:"pdf-routing-plan-v1",
      inspector:{version:"pdf-inspector-v1"},
      parser:{name:"pdfjs-isolated",version:"pdf-router-v1"},
      pageCount:3,
      pages:[
        {physicalPageIndex:0,route:"NATIVE_TEXT",contentEvidence:"TEXT",
          reasonCodes:["NATIVE_TEXT_PRESENT"]},
        {physicalPageIndex:1,route:"OCR_REQUIRED",contentEvidence:"NON_TEXT_CONTENT",
          reasonCodes:["IMAGE_CONTENT_WITHOUT_TEXT"]},
        {physicalPageIndex:2,route:"NATIVE_TEXT",contentEvidence:"TEXT",
          reasonCodes:["NATIVE_TEXT_PRESENT"]},
      ],
    };
    const run=await prisma.ingestionRun.create({
      data:{workspaceId,sourceDocumentId:docId,jobId,status:"SUCCEEDED",
        completedAt:new Date(),parserVersion:"pdf-router-v1",
        normalizationVersion:"canonical-text-v1",routingGeneration:1,
        routingPlan},
    });
    runId=run.id;
    const extraction=await prisma.documentExtraction.create({
      data:{ingestionRunId:runId,sourceDocumentId:docId,workspaceId,
        status:"SUCCEEDED",parserName:"pdfjs-isolated",
        parserVersion:"pdf-router-v1",
        normalizationVersion:"canonical-text-v1"},
    });
    markStage("REAL_QUEUE_MODEL");
    const data={ingestionRunId:runId,physicalPageIndex:1,
      modelSha256:verified.artifactSha256};
    const scan=await dispatchDoclingLayoutSweep(queue,verified.artifactSha256,{},{take:20});
    ensure(scan===1,"REAL_DOCLING_E2E_PAGE_ROUTING_FAILED");
    const queued=await queue.getJob(doclingLayoutJobId(data));
    ensure(queued,"REAL_DOCLING_E2E_JOB_MISSING");
    const result=await queued.waitUntilFinished(events,240_000);
    ensure(result==="SNAPSHOT_CREATED","REAL_DOCLING_E2E_WORKER_FAILED");
    markStage("EVIDENCE");
    const task=await prisma.doclingLayoutTask.findFirst({
      where:{ingestionRunId:runId,physicalPageIndex:1},
    });
    ensure(task?.status==="SUCCEEDED"&&task.attemptCount===1 &&
      task.claimToken===null,"REAL_DOCLING_E2E_CLAIM_INVALID");
    const snapshots=await prisma.doclingLayoutSnapshot.findMany({
      where:{ingestionRunId:runId},
    });
    ensure(snapshots.length===1,"REAL_DOCLING_E2E_SNAPSHOT_DUPLICATE");
    const snap=snapshots[0]!;
    artifactKey=snap.markdownStorageKey;
    ensure(snap.sourceSha256===sourceHash &&
      snap.modelSha256===verified.artifactSha256 &&
      snap.workspaceId===workspaceId && snap.physicalPageIndex===1,
      "REAL_DOCLING_E2E_LINEAGE_INVALID");
    const markdown=await storage.getObjectBytes(artifactKey);
    ensure(hash(markdown)===snap.markdownSha256,"REAL_DOCLING_E2E_S3_DIGEST_INVALID");
    const normalized=Buffer.from(markdown).toString("utf8")
      .toUpperCase().replace(/[^A-Z0-9]/g,"");
    ensure(normalized.includes("SECONDPAGELAYOUTTEST") &&
      normalized.includes("STRUCTURED PARAGRAPH CONTENT".replaceAll(" ","")) &&
      !normalized.includes("PAGEZERODONOTEXPORT") &&
      !normalized.includes("THIRDPAGEDONOTEXPORT"),
      "REAL_DOCLING_E2E_PAGE_LEAKAGE_OR_MISSING");
    ensure((await prisma.documentExtraction.findUniqueOrThrow({
      where:{ingestionRunId:runId},
    })).id===extraction.id,"REAL_DOCLING_E2E_AUTHORITATIVE_EXTRACTION_REPLACED");
    ensure((await prisma.sourceBlock.count({
      where:{extractionId:extraction.id},
    }))===0,"REAL_DOCLING_E2E_CANONICAL_BLOCK_MUST_REMAIN_UNCHANGED");
    markStage("REPLAY");
    ensure(await executeDoclingBackgroundJob(data,storage,executor)==="SNAPSHOT_REUSED",
      "REAL_DOCLING_E2E_REPLAY_FAILED");
    ensure((await prisma.doclingLayoutSnapshot.count({
      where:{ingestionRunId:runId},
    }))===1,"REAL_DOCLING_E2E_REPLAY_DUPLICATE");
    markStage("REPLAY_VERIFIED");
    console.log("ACS_DOCLING_REAL_STACK_ORIGINAL_PDF=PASS");
    console.log("ACS_DOCLING_REAL_STACK_WINDOWS_MODEL=PASS");
    console.log("ACS_DOCLING_REAL_STACK_REDIS_PG_MINIO=PASS");
    console.log("ACS_DOCLING_REAL_STACK_SINGLE_PAGE=PASS");
    console.log("ACS_DOCLING_REAL_STACK_REPLAY=PASS");
    console.log("ACS_DOCLING_REAL_STACK_GOLD=NOT_APPROVED");
  }catch{
    // The exception might contain private host information. Never print it.
    console.error("ACS_DOCLING_REAL_STACK_FAILURE_STAGE="+stage);
    throw new Error("REAL_DOCLING_E2E_REJECTED");
  }finally{
    // Namespace-local cleanup only. Do not flush Redis or touch unrelated S3.
    markStage("CLEANUP_WORKER");
    await cleanupStep("WORKER",()=>worker.close());
    markStage("CLEANUP_EVENTS");
    await cleanupStep("EVENTS",()=>events.close());
    markStage("CLEANUP_QUEUE_OBLITERATE");
    await cleanupStep("QUEUE_OBLITERATE",()=>queue.obliterate({force:true}));
    markStage("CLEANUP_QUEUE_CLOSE");
    await cleanupStep("QUEUE_CLOSE",()=>queue.close());
    markStage("CLEANUP_EXECUTOR");
    await cleanupStep("EXECUTOR",()=>executor.close());
    // Delete child rows before parents, using synthetic workspace/run IDs only.
    markStage("CLEANUP_DATABASE");
    if(runId){
      await prisma.doclingLayoutSnapshot.deleteMany({where:{ingestionRunId:runId}})
        .catch(()=>undefined);
      await prisma.doclingLayoutTask.deleteMany({where:{ingestionRunId:runId}})
        .catch(()=>undefined);
      await prisma.documentExtraction.deleteMany({where:{ingestionRunId:runId}})
        .catch(()=>undefined);
      await prisma.ingestionRun.deleteMany({where:{id:runId}}).catch(()=>undefined);
    }
    if(jobId)await prisma.job.deleteMany({where:{id:jobId}}).catch(()=>undefined);
    if(docId)await prisma.sourceDocument.deleteMany({where:{id:docId}}).catch(()=>undefined);
    if(sourceId)await prisma.source.deleteMany({where:{id:sourceId}}).catch(()=>undefined);
    if(blobId)await prisma.sourceBlob.deleteMany({where:{id:blobId}}).catch(()=>undefined);
    if(workspaceId){
      await prisma.workspaceMember.deleteMany({where:{workspaceId}}).catch(()=>undefined);
      await prisma.workspace.deleteMany({where:{id:workspaceId}}).catch(()=>undefined);
    }
    if(userId)await prisma.user.deleteMany({where:{id:userId}}).catch(()=>undefined);
    markStage("CLEANUP_S3");
    if(artifactKey)await storage.deleteObject(artifactKey).catch(()=>undefined);
    await storage.deleteObject(sourceKey).catch(()=>undefined);
    markStage("CLEANUP_DISCONNECT");
    await cleanupStep("DB_DISCONNECT",()=>prisma.$disconnect());
    // Once all BullMQ objects have drained/closed, explicitly disconnect
    // only this proof's three privately-created Redis clients. Never flush
    // Redis or disconnect shared/production connections.
    markStage("CLEANUP_REDIS_CLIENTS");
    for(const client of ownedRedisClients){
      try{client.disconnect();}
      catch{cleanupRejected=true;console.log("ACS_DOCLING_REAL_STACK_TEARDOWN_REDIS=REJECTED");}
    }
    markStage("CLEANUP_DONE");
  }
  // Do not throw from finally: a failure in the primary proof must retain its
  // original causal status, while cleanup failures still fail a successful run.
  if(cleanupRejected)throw new Error("REAL_DOCLING_E2E_TEARDOWN_REJECTED");
}
// A completed proof must exit naturally; no process.exit(0) shortcuts.
// If event-loop handles survive every explicit teardown, print only
// fixed handle categories and counts for safe Windows diagnostics.
main().then(()=>{
  console.log("ACS_DOCLING_REAL_STACK_MAIN_RESOLVED=PASS");
  const census=setTimeout(()=>{
    type InternalProcess=typeof process & {
      _getActiveHandles?:()=>unknown[];
      _getActiveRequests?:()=>unknown[];
    };
    const internal=process as InternalProcess;
    const handles=internal._getActiveHandles?.()??[];
    const requests=internal._getActiveRequests?.()??[];
    const counts={SOCKET:0,CHILD_PROCESS:0,MESSAGE_PORT:0,FS_WATCHER:0,OTHER:0};
    for(const handle of handles){
      const ctor=(handle as {constructor?:{name?:string}} | null)?.constructor?.name;
      const name=ctor==="Socket"?"SOCKET":ctor==="ChildProcess"?"CHILD_PROCESS":
        ctor==="MessagePort"?"MESSAGE_PORT":ctor==="FSWatcher"?"FS_WATCHER":"OTHER";
      counts[name]++;
    }
    for(const [label,count] of Object.entries(counts)){
      console.log("ACS_DOCLING_REAL_STACK_LINGER_"+label+"="+Math.min(count,999));
    }
    console.log("ACS_DOCLING_REAL_STACK_LINGER_REQUESTS="+Math.min(requests.length,999));
  },2000);
  census.unref();
}).catch(()=>{
  console.error("ACS_DOCLING_REAL_STACK=REJECTED");
  process.exitCode=2;
});
