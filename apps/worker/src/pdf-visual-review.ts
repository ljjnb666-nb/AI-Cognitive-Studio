import { createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { DEFAULT_PARSER_LIMITS, extractNativePdf, assertRoutingPlanReplay, inspectPdfMixedPageVisualStructure, parseRoutingPlan } from "@ai-cognitive/ingestion";
type ParserLimits = Parameters<typeof extractNativePdf>[1];
import { createGatewayPdfVisualExecutor, WorkspaceMembershipExecutionAuthorizer, type ProviderGateway } from "@ai-cognitive/provider-gateway";
import { S3CompatibleStorageProvider, type StorageProvider } from "@ai-cognitive/storage";
import type { Environment } from "@ai-cognitive/shared/server";
import { createBookProductionGatewayRuntime } from "./provider-gateway-runtime.js";
import { persistPdfVisualReviewCandidates, type StorePdfVisualCandidateIdentity } from "./pdf-visual-review-store.js";
import type { PdfVisualStructureResult } from "@ai-cognitive/ingestion";

const MAX_PDF_BYTES=110_000_000;
const sha256=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");

export type PdfVisualReviewWorkerTask={
  enabled:true;
  /** Privacy-sensitive images may be sent to the workspace's explicitly configured vision provider. */
  allowExternalVisualModel:true;
  workspaceId:string;
  userId:string;
  sourceDocumentId:string;
  ingestionRunId:string;
  maxReviewPages?:1|2;
  /** Separate explicit consent for storing only structured unverified graph for 24h. */
  persistReviewCandidate?:true;
};
export type PdfVisualSourceRecord={
  id:string;
  workspaceId:string;
  sourceDocumentId:string;
  status:string;
  routingGeneration:number|null;
  routingPlan:unknown;
  sourceDocument:{
    id:string;workspaceId:string;sha256:string;
    sizeBytes:bigint;mediaType:string;storageKey:string;
  };
};
export type PdfVisualReviewWorkerDeps={
  authorize:(userId:string,workspaceId:string)=>Promise<void>;
  loadRun:(identity:{workspaceId:string;ingestionRunId:string})=>Promise<PdfVisualSourceRecord|null>;
  storage:Pick<StorageProvider,"headObject"|"getObjectStream">;
  gateway:ProviderGateway;
  parserLimits?:ParserLimits;
  persistReviewCandidate?:(identity:StorePdfVisualCandidateIdentity, output:PdfVisualStructureResult)=>Promise<number>;
};

/**
 * Explicit Worker-side task handler — NOT registered in any production queue.
 * No scheduled sweep, publishing, canonical text edits, raw-pixel persistence,
 * or automatic provider call. Re-use only after a trusted user action.
 */
export async function executeOnDemandPdfVisualReview(
  task:PdfVisualReviewWorkerTask,
  deps:PdfVisualReviewWorkerDeps,
){
  if(task.enabled!==true||task.allowExternalVisualModel!==true||
     !task.workspaceId||!task.userId||!task.ingestionRunId||!task.sourceDocumentId||
     (task.maxReviewPages!==undefined&&task.maxReviewPages!==1&&task.maxReviewPages!==2))
    throw new Error("PDF_VISUAL_WORKER_OPT_IN_REQUIRED");
  if(task.persistReviewCandidate===true && !deps.persistReviewCandidate)
    throw new Error("PDF_VISUAL_REVIEW_STORAGE_UNAVAILABLE");
  // Access check precedes run existence and private storage read.
  await deps.authorize(task.userId,task.workspaceId);
  const run=await deps.loadRun({workspaceId:task.workspaceId,ingestionRunId:task.ingestionRunId});
  if(!run||run.workspaceId!==task.workspaceId||run.id!==task.ingestionRunId||
     run.sourceDocumentId!==task.sourceDocumentId||run.status!=="SUCCEEDED"||
     run.sourceDocument.id!==task.sourceDocumentId||
     run.sourceDocument.workspaceId!==task.workspaceId||
     run.sourceDocument.mediaType!=="application/pdf"||
     !Number.isSafeInteger(run.routingGeneration)||run.routingGeneration===null||run.routingGeneration<1||
     !/^[0-9a-f]{64}$/.test(run.sourceDocument.sha256)||
     typeof run.sourceDocument.storageKey!=="string"||!run.sourceDocument.storageKey)
    throw new Error("PDF_VISUAL_WORKER_SOURCE_NOT_READY");
  const plan=parseRoutingPlan(run.routingPlan);
  if(plan.pages.length===0)throw new Error("PDF_VISUAL_WORKER_ROUTE_PLAN_EMPTY");
  const expectedBytes=run.sourceDocument.sizeBytes;
  if(typeof expectedBytes!=="bigint"||expectedBytes<5n||expectedBytes>BigInt(MAX_PDF_BYTES))
    throw new Error("PDF_VISUAL_WORKER_SOURCE_TOO_LARGE");
  const metadata=await deps.storage.headObject(run.sourceDocument.storageKey);
  if(!metadata||!Number.isSafeInteger(metadata.size)||
     metadata.size!==Number(expectedBytes))
    throw new Error("PDF_VISUAL_WORKER_SOURCE_SIZE_MISMATCH");
  const parts:Uint8Array[]=[];
  let size=0;
  for await(const chunk of await deps.storage.getObjectStream(run.sourceDocument.storageKey)){
    size+=chunk.byteLength;
    if(size>MAX_PDF_BYTES||size>metadata.size)
      throw new Error("PDF_VISUAL_WORKER_SOURCE_STREAM_OVERFLOW");
    parts.push(chunk);
  }
  if(size!==metadata.size)throw new Error("PDF_VISUAL_WORKER_SOURCE_STREAM_INCOMPLETE");
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  if(sha256(bytes)!==run.sourceDocument.sha256)
    throw new Error("PDF_VISUAL_WORKER_SOURCE_SHA_MISMATCH");
  if(bytes.length<5 || Buffer.from(bytes.subarray(0,5)).toString("ascii")!=="%PDF-")
    throw new Error("PDF_VISUAL_WORKER_INVALID_PDF_HEADER");
  // A stored route must be an exact replay for THESE private PDF bytes.
  // Do this BEFORE any images can reach a paid remote provider.
  const native=await extractNativePdf(bytes,deps.parserLimits??DEFAULT_PARSER_LIMITS);
  assertRoutingPlanReplay(plan,native.routingPlan);
  const executor=createGatewayPdfVisualExecutor({
    gateway:deps.gateway,
    workspaceId:task.workspaceId,
    userId:task.userId,
    sourceDocumentId:task.sourceDocumentId,
    ingestionRunId:task.ingestionRunId,
  });
  const output=await inspectPdfMixedPageVisualStructure(
    bytes,deps.parserLimits??DEFAULT_PARSER_LIMITS,
    {enabled:true,executor,maxPages:task.maxReviewPages??1},
  );
  if(output.pageCount!==plan.pages.length||
     output.pages.some(p=>!plan.pages.some(x=>x.physicalPageIndex===p.physicalPageIndex&&x.route==="NATIVE_TEXT")))
    throw new Error("PDF_VISUAL_WORKER_ROUTE_PLAN_MISMATCH");
  const stored=task.persistReviewCandidate===true
    ? await deps.persistReviewCandidate!({
      workspaceId:task.workspaceId,sourceDocumentId:task.sourceDocumentId,
      ingestionRunId:task.ingestionRunId,routingGeneration:run.routingGeneration,
      sourcePdfSha256:run.sourceDocument.sha256,
    },output)
    : 0;
  return {
    ...output,
    taskMode:"ON_DEMAND_REVIEW_ONLY" as const,
    sourceDocumentId:task.sourceDocumentId,
    ingestionRunId:task.ingestionRunId,
    reviewRequired:true as const,
    canonicalTextUpdated:false as const,
    persistedVisualContent:stored>0,
  };
}

/** Resource-complete composition, deliberately not wired to startWorkerRuntime. */
export function createOnDemandPdfVisualWorkerRuntime(environment:Environment,source:NodeJS.ProcessEnv){
  const gatewayRuntime=createBookProductionGatewayRuntime(source);
  const storage=new S3CompatibleStorageProvider({
    endpoint:environment.S3_ENDPOINT,
    region:environment.S3_REGION,
    bucket:environment.S3_BUCKET,
    accessKey:environment.S3_ACCESS_KEY,
    secretKey:environment.S3_SECRET_KEY,
    forcePathStyle:environment.S3_FORCE_PATH_STYLE,
  });
  const authorizer=new WorkspaceMembershipExecutionAuthorizer();
  const deps:PdfVisualReviewWorkerDeps={
    authorize:(userId,workspaceId)=>authorizer.authorizeExecution({userId},workspaceId),
    loadRun:async identity=>{
      const run=await prisma.ingestionRun.findFirst({
        where:{id:identity.ingestionRunId,workspaceId:identity.workspaceId},
        include:{sourceDocument:true},
      });
      return run;
    },
    storage,gateway:gatewayRuntime.gateway,
    persistReviewCandidate:persistPdfVisualReviewCandidates,
  };
  let closed=false;
  return {
    execute:(task:PdfVisualReviewWorkerTask)=>executeOnDemandPdfVisualReview(task,deps),
    async close(){
      if(closed)return;
      closed=true;
      storage.close();
      await gatewayRuntime.close();
    },
  };
}
