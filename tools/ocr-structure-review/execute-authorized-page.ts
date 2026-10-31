/** Local operator acceptance only. Does not create consent or retry a Job.
 * Without the explicit run flag this only validates private evidence. */
import {readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {prisma} from "../../packages/db/src/index.js";
import {S3CompatibleStorageProvider} from "../../packages/storage/src/index.js";
import {readOcrStructureReviewEvidence,renderOcrReviewSourcePage,OCR_MODEL_REVIEW_JOB} from "../../packages/ingestion/src/index.js";
import {createBookProductionGatewayRuntime} from "../../apps/worker/src/provider-gateway-runtime.js";
import {processNextOcrStructureReview} from "../../apps/worker/src/ocr-structure-review.js";
import {FetchProviderHttpTransport,createProviderAdapterResolver,type ProviderHttpRequest} from "../../packages/provider-gateway/src/index.js";
async function main(){
 const root=process.env.OCR_REVIEW_PRIVATE_PROOF_ROOT;if(!root||!process.env.PDF_REVIEW_PRIVATE_TEMP_ROOT)throw Error("PRIVATE_PROOF_ROOT_REQUIRED");
 const proof=JSON.parse(await readFile(join(root,"current-page.private.json"),"utf8"));
 if(proof.sourcePdfSha256!==process.env.OCR_REVIEW_EXPECTED_SOURCE_SHA256||proof.physicalPageIndex!==Number(process.env.OCR_REVIEW_PHYSICAL_PAGE)-1)throw Error("AUTHORIZED_SOURCE_PAGE_MISMATCH");
 const storage=new S3CompatibleStorageProvider({endpoint:process.env.S3_ENDPOINT!,region:process.env.S3_REGION!,bucket:process.env.S3_BUCKET!,accessKey:process.env.S3_ACCESS_KEY!,secretKey:process.env.S3_SECRET_KEY!,forcePathStyle:true});
 try{
 const evidence=await readOcrStructureReviewEvidence(proof,storage);if(evidence.receiptId!==proof.receiptId||evidence.textSha256!==proof.textSha256||evidence.text.length>6000)throw Error("AUTHORIZED_OCR_MISMATCH");
 const image=await renderOcrReviewSourcePage(evidence,storage,process.env.PDF_REVIEW_PRIVATE_TEMP_ROOT!);
 if(image.pngBytes.length>8_000_000)throw Error("AUTHORIZED_IMAGE_LIMIT");
 const expectedPrevious=process.env.OCR_REVIEW_PREVIOUS_FAILED_JOB_ID;
 const previous=expectedPrevious?await prisma.job.findUnique({where:{id:expectedPrevious}}):null;
 if(expectedPrevious&&(!previous||previous.workspaceId!==proof.workspaceId||previous.status!=="FAILED"||(previous.payload as Record<string,unknown>).receiptId!==proof.receiptId))throw Error("PREVIOUS_FAILURE_MISMATCH");
 const existingInvocations=await prisma.providerInvocation.count({where:{workspaceId:proof.workspaceId}});
 if(existingInvocations!==(expectedPrevious?1:0))throw Error("EXISTING_INVOCATION_REQUIRES_RECONCILIATION");
 console.log(JSON.stringify({status:"PREFLIGHT_OK",physicalPageIndex:proof.physicalPageIndex,ocrCharacters:evidence.text.length,imageBytes:image.pngBytes.length,width:image.width,height:image.height,actualTier:evidence.actualTier,existingInvocations}));
 if(process.env.OCR_REVIEW_RUN_AUTHORIZED_ONCE!=="true")return;
 const authorized=JSON.parse(await readFile(join(root,"authorized-job.private.json"),"utf8"));
 const jobId=authorized.jobId??authorized.job?.jobId;if(!jobId)throw Error("AUTHORIZED_UI_JOB_REQUIRED");
 const job=await prisma.job.findUniqueOrThrow({where:{id:jobId}}),payload=job.payload as Record<string,unknown>;
 if(job.workspaceId!==proof.workspaceId||job.type!==OCR_MODEL_REVIEW_JOB||job.status!=="QUEUED"||job.attemptCount!==0||payload.receiptId!==proof.receiptId||payload.physicalPageIndex!==proof.physicalPageIndex||payload.sourcePdfSha256!==proof.sourcePdfSha256||(payload.previousFailedJobId??undefined)!==expectedPrevious)throw Error("AUTHORIZED_UI_JOB_MISMATCH");
 class PrivateAcceptanceTransport extends FetchProviderHttpTransport {
  override async execute(request:ProviderHttpRequest){const result=await super.execute(request);await writeFile(join(root!,`remote-response-${jobId}.private.json`),JSON.stringify({status:result.status,body:result.body}),{mode:0o600});return result;}
 }
 const runtime=createBookProductionGatewayRuntime(process.env,{adapterResolver:createProviderAdapterResolver(new PrivateAcceptanceTransport())});
 try{
  const outcome=await processNextOcrStructureReview({gateway:runtime.gateway,repository:runtime.repository,storage,privateTempRoot:process.env.PDF_REVIEW_PRIVATE_TEMP_ROOT!},jobId);
  const event=await prisma.ocrModelReviewEvent.findUnique({where:{jobId}}),current=await prisma.job.findUniqueOrThrow({where:{id:jobId}});
  const result={outcome,jobId,status:current.status,event,invocations:await prisma.providerInvocation.findMany({where:{workspaceId:proof.workspaceId},select:{id:true,status:true,snapshotId:true}}),usage:await prisma.providerUsageEvent.findMany({where:{workspaceId:proof.workspaceId},select:{id:true,invocationId:true,status:true,inputTokens:true,outputTokens:true}}),extractions:await prisma.documentExtraction.count({where:{ingestionRunId:proof.ingestionRunId}})};
  await writeFile(join(root,`real-model-review-${jobId}.private.json`),JSON.stringify(result,null,2));
  await writeFile(join(root,"real-model-review.private.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify({outcome,status:current.status,decision:event?.decision??null,invocations:result.invocations.length,usageEvents:result.usage.length,extractions:result.extractions}));
  if(outcome!=="DONE"||!event||result.invocations.length!==existingInvocations+1||result.extractions!==0)throw Error("REAL_MODEL_REVIEW_REQUIRES_RECONCILIATION_NO_RETRY");
 }finally{await runtime.close();}
 }finally{storage.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:"ACCEPTANCE_FAILED");process.exitCode=1;}).finally(()=>prisma.$disconnect());
