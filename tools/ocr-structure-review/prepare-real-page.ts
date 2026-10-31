/** Explicit machine-local single-page product acceptance. No model cloud call,
 * no production switches, no synthetic execution/source claims. Keep all
 * original bytes, output and credentials under the operator's private root. */
import {readFile,writeFile,stat,mkdir} from "node:fs/promises";
import {join,basename} from "node:path";
import {createHash} from "node:crypto";
import {freemem} from "node:os";
import {prisma} from "../../packages/db/src/index.js";
import {S3CompatibleStorageProvider} from "../../packages/storage/src/index.js";
import {createIngestionService,createMineruPdfOcrExecutor,resolveMineruExecutorConfig,verifyMineruRuntime,verifyMineruStandardModels} from "../../packages/ingestion/src/index.js";
import {approvedManifestText} from "../../packages/ingestion/src/mineru/mineru-approved-inventory.js";

async function main(){
 const sourcePath=process.env.OCR_REVIEW_SOURCE_PDF,root=process.env.PDF_REVIEW_PRIVATE_TEMP_ROOT,proofRoot=process.env.OCR_REVIEW_PRIVATE_PROOF_ROOT,expectedSha=process.env.OCR_REVIEW_EXPECTED_SOURCE_SHA256,email=process.env.OCR_REVIEW_ACCEPTANCE_EMAIL;
 const physicalPage=Number(process.env.OCR_REVIEW_PHYSICAL_PAGE);
 if(!sourcePath||!root||!proofRoot||!email||!expectedSha||!/^[a-f0-9]{64}$/.test(expectedSha)||!Number.isSafeInteger(physicalPage)||physicalPage<1||physicalPage>2000)throw Error("REAL_REVIEW_ACCEPTANCE_INPUT_REQUIRED");
 const info=await stat(sourcePath);if(info.size>200*1024*1024)throw Error("REAL_REVIEW_SOURCE_SIZE_LIMIT");
 await mkdir(root,{recursive:true});await mkdir(proofRoot,{recursive:true});
 const manifest=join(proofRoot,"approved-model-manifest.json");await writeFile(manifest,approvedManifestText());
 const config=resolveMineruExecutorConfig({...process.env,OCR_PROVIDER:"mineru",MINERU_MODEL_SOURCE:"local",MINERU_HOME_ROOT:join(root,"mineru"),OCR_HOST_ID:"ocr-structure-review-acceptance",OCR_TIER_STANDARD_EXPERIMENTAL_ENABLED:"true",OCR_TIER_STANDARD_EXECUTION_ADMISSION_ENABLED:"true",MINERU_STANDARD_MODEL_MANIFEST:manifest} as unknown as Parameters<typeof resolveMineruExecutorConfig>[0]);
 if(!config?.standard)throw Error("REAL_REVIEW_STANDARD_CONFIGURATION_REQUIRED");
 // Do not lower the default floor or spend a page attempt on known pressure.
 if(freemem()<config.standard.minFreeMemoryBytes+info.size*2)throw Error("REAL_REVIEW_WAIT_FOR_HOST_MEMORY");
 await verifyMineruRuntime(config);if(!(await verifyMineruStandardModels(config.modelPath,config.standard)).ok)throw Error("REAL_REVIEW_MODELS_NOT_APPROVED");
 const user=await prisma.user.findUniqueOrThrow({where:{email},include:{memberships:true}});
 const workspaceId=user.defaultWorkspaceId??user.memberships[0]?.workspaceId;if(!workspaceId||!user.memberships.some(m=>m.workspaceId===workspaceId&&m.role==="OWNER"))throw Error("REAL_REVIEW_ACCEPTANCE_OWNER_REQUIRED");
 const storage=new S3CompatibleStorageProvider({endpoint:process.env.S3_ENDPOINT!,region:process.env.S3_REGION!,bucket:process.env.S3_BUCKET!,accessKey:process.env.S3_ACCESS_KEY!,secretKey:process.env.S3_SECRET_KEY!,forcePathStyle:true});
 const handle=createMineruPdfOcrExecutor(config,{standardModelsVerified:true});
 try{
  const bytes=await readFile(sourcePath);if(bytes.length!==info.size||createHash("sha256").update(bytes).digest("hex")!==expectedSha)throw Error("REAL_REVIEW_SOURCE_CHANGED");
  const service=createIngestionService(storage,{maxUploadBytes:200*1024*1024,uploadTtlSeconds:900,maxPdfPages:2000,completionLeaseMs:900000,processMaxAttempts:3,pdfOcrExecutor:handle.executor,ocrStandardAdmissionEnabled:true});
  const context={workspaceId,userId:user.id};
  const upload=await service.createUploadIntent(context,{filename:basename(sourcePath),mediaType:"application/pdf",sizeBytes:bytes.length});
  await storage.putObject({key:upload.session.temporaryStorageKey,body:bytes,contentType:"application/pdf"});
  const document=await service.completeUpload(context,upload.session.id,{outboxTopic:"ocr-structure-review-private-acceptance"});
  const run=await prisma.ingestionRun.findFirstOrThrow({where:{sourceDocumentId:document.id},orderBy:{createdAt:"desc"}});
  let errorCode:string|null=null;try{await service.processIngestionRun(run.id,{physicalPageIndex:physicalPage-1});}catch(error){errorCode=error instanceof Error?error.message:"UNKNOWN";}
  const page=await prisma.ocrPageAttempt.findUniqueOrThrow({where:{ingestionRunId_physicalPageIndex_routingGeneration:{ingestionRunId:run.id,physicalPageIndex:physicalPage-1,routingGeneration:1}}});
  const receipt=page.claimToken?await prisma.ocrPageExecution.findUnique({where:{pageClaimToken:page.claimToken}}):null;
  const proof={sourceDocumentId:document.id,workspaceId,ingestionRunId:run.id,physicalPageIndex:physicalPage-1,sourcePdfSha256:document.sha256,errorCode,actualTier:receipt?.actualTier,modelRevision:receipt?.modelRevision,receiptId:receipt?.id,textSha256:page.textSha256,qualityStatus:page.qualityStatus,extractions:await prisma.documentExtraction.count({where:{ingestionRunId:run.id}}),reviewUrl:`http://127.0.0.1:3217/studio/library/${document.id}/review?page=${physicalPage-1}`,calls:handle.executor.calls.map(c=>({outcome:c.outcome,errorCode:c.errorCode,timings:c.execution?.timings}))};
  await writeFile(join(proofRoot,`real-page-${Date.now()}.private.json`),JSON.stringify(proof,null,2));
  if(errorCode!=="SOURCE_OCR_REVIEW_REQUIRED"||receipt?.actualTier!=="standard"||page.qualityStatus!=="REVIEW_REQUIRED"||proof.extractions!==0)throw Error("REAL_REVIEW_PAGE_ACCEPTANCE_FAILED");
  await writeFile(join(proofRoot,"current-page.private.json"),JSON.stringify(proof,null,2));
  console.log(JSON.stringify({status:"STANDARD_PAGE_READY_FOR_REVIEW",physicalPageIndex:physicalPage-1,actualTier:receipt.actualTier,extractions:0}));
 }finally{await handle.close();storage.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:"REAL_REVIEW_FAILED");process.exitCode=1;}).finally(()=>prisma.$disconnect());
