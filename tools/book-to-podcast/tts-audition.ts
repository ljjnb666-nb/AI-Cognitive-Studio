/** Explicit, private voice audition. This is not a book PodcastScriptRevision
 * and never creates publication authority. Uses the production Gateway vault,
 * receipts, usage and private storage; rerunning cannot restart its Job. */
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {prisma,Prisma} from "../../packages/db/src/index.js";
import {ProviderGatewayRepository,resolveCredentialKeyring,FetchProviderHttpTransport,createProviderAdapterResolver,type ProviderHttpRequest,type SpeechResponse} from "../../packages/provider-gateway/src/index.js";
import {createBookProductionGatewayRuntime} from "../../apps/worker/src/provider-gateway-runtime.js";
import {S3CompatibleStorageProvider} from "../../packages/storage/src/index.js";
const hash=(s:string|Uint8Array)=>createHash("sha256").update(s).digest("hex");
const json=(s:unknown)=>JSON.parse(JSON.stringify(s)) as Prisma.InputJsonValue;
async function main(){
 const diagnostic=process.env.GLM_TTS_SINGLE_DIAGNOSTIC==="true";
 const completion=process.env.GLM_TTS_COMPLETE_REMAINING==="true";
 const root=process.env.BOOK_PODCAST_PRIVATE_ROOT;if(!root||(diagnostic&&completion)||process.env.GLM_TTS_AUDITION_APPROVED_CNY!==(diagnostic?"0.01":completion?"0.03":"0.10"))throw Error("EXPLICIT_AUDITION_APPROVAL_REQUIRED");
 const plan=JSON.parse(await readFile(join(root,"tts-audition-plan.private.json"),"utf8")) as {turns:Array<{ordinal:number;voice:string;text:string}>};
 const chars=plan.turns.reduce((n,t)=>n+t.text.length,0);if(plan.turns.length!==4||chars!==132||chars>500||chars*2/10000>0.10||plan.turns.some((t,i)=>t.ordinal!==i+1||t.voice!==(i%2===0?"tongtong":"xiaochen")||t.text.length>1024))throw Error("AUDITION_SCOPE_MISMATCH");
 if(diagnostic)plan.turns=plan.turns.slice(0,1);
 if(completion){
  plan.turns=plan.turns.slice(1);
  const proof=JSON.parse(await readFile(join(root,"offline-recovery.private.json"),"utf8")),bytes=await readFile(join(root,"recovered-tongtong.private.wav"));
  if(hash(bytes)!==proof.normalizedSha256||proof.watermarkAndPcmUnchanged!==true)throw Error("RECOVERED_TURN_IDENTITY_MISMATCH");
  await writeFile(join(root,"audition-turn-1.private.wav"),bytes);
 }
 const callCharacters=plan.turns.reduce((n,t)=>n+t.text.length,0);
 if(completion&&(plan.turns.length!==3||callCharacters!==99||callCharacters>150))throw Error("COMPLETION_SCOPE_MISMATCH");
 const identity=JSON.parse(await readFile(join(root,"podcast-product-preparation.private.json"),"utf8")) as {workspaceId:string;userId:string};
 const ctx={workspaceId:identity.workspaceId,userId:identity.userId},planHash=hash(JSON.stringify(plan.turns)),key=(diagnostic?"glm-tts-diagnostic-v1:":completion?"glm-tts-completion-v1:":"glm-tts-audition-v1:")+planHash;
 const existing=await prisma.job.findUnique({where:{idempotencyKey:key}});if(existing)throw Error("AUDITION_ALREADY_REQUESTED_NO_AUTOMATIC_RETRY");
 const cipher=resolveCredentialKeyring(process.env);if(!cipher)throw Error("CREDENTIAL_VAULT_REQUIRED");
 const store=new ProviderGatewayRepository(prisma,cipher);
 let connection=await prisma.providerConnection.findFirst({where:{workspaceId:ctx.workspaceId,providerKey:"zhipu",protocol:"CUSTOM_SPEECH",displayName:"GLM-TTS private audition",status:"ACTIVE"}});
 if(!connection){
  const old=await prisma.providerRouteBinding.findUniqueOrThrow({where:{workspaceId_routeSlot:{workspaceId:ctx.workspaceId,routeSlot:"PDF_VISUAL_STRUCTURE"}},include:{connection:{include:{credentialVersions:{where:{status:"ACTIVE"},orderBy:{credentialVersion:"desc"},take:1}}}}});
  const c=old.connection.credentialVersions[0];if(old.connection.providerKey!=="zhipu"||old.connection.status!=="ACTIVE"||!c)throw Error("EXISTING_ZHIPU_CREDENTIAL_REQUIRED");
  // Plaintext exists only inside the vault call; never returned or logged.
  const saved=await store.createConnectionWithCredential(ctx,{providerKey:"zhipu",protocol:"CUSTOM_SPEECH",displayName:"GLM-TTS private audition",endpoint:"https://open.bigmodel.cn/api/paas/v4/audio/speech",secret:cipher.decrypt(c,{workspaceId:ctx.workspaceId,connectionId:old.connection.id,credentialVersionId:c.id,providerKey:"zhipu"})});connection=saved.connection;
 }
 await store.setRoute(ctx,{routeSlot:"PODCAST_TTS",connectionId:connection.id,modelId:"glm-tts",configuration:{outputFormat:"wav",sampleRate:24000,channels:1}});
 if(diagnostic&&plan.turns[0]!.text.length>50)throw Error("DIAGNOSTIC_SCOPE_MISMATCH");
 const job=await prisma.job.create({data:{...ctx,type:"podcast.tts.audition",status:"RUNNING",attemptCount:1,startedAt:new Date(),idempotencyKey:key,payload:{planHash,approval:diagnostic?"separate-single-diagnostic-0.01-CNY":completion?"separate-three-turn-completion-0.03-CNY":"explicit-user-20261030-0.10-CNY",maxCalls:diagnostic?1:completion?3:4,maxAttemptsPerCall:1,maxCharacters:diagnostic?50:completion?150:500,budgetCeilingCny:diagnostic?0.01:completion?0.03:0.10}}});
 class PrivateAuditionTransport extends FetchProviderHttpTransport {
  private ordinal=0;
  override async executeBinary(request:ProviderHttpRequest){const response=await super.executeBinary(request),n=++this.ordinal;
   // Preserve exact private response before any WAV validation; do not retain
   // Authorization headers or put raw supplier content into public logs.
   await writeFile(join(root!,`audition-response-${job.id}-${n}.private.bin`),response.bytes,{mode:0o600});
   const h=response.headers instanceof Headers?response.headers:new Headers(Object.entries(response.headers).filter((p):p is [string,string]=>typeof p[1]==="string"));
   await writeFile(join(root!,`audition-response-${job.id}-${n}.private.json`),JSON.stringify({status:response.status,bytes:response.bytes.length,sha256:hash(response.bytes),contentType:h.get("content-type"),requestId:h.get("x-request-id")??h.get("request-id")}),{mode:0o600});return response;
  }
 }
 const runtime=createBookProductionGatewayRuntime(process.env,{adapterResolver:createProviderAdapterResolver(new PrivateAuditionTransport())}),storage=new S3CompatibleStorageProvider({endpoint:process.env.S3_ENDPOINT!,region:process.env.S3_REGION!,bucket:process.env.S3_BUCKET!,accessKey:process.env.S3_ACCESS_KEY!,secretKey:process.env.S3_SECRET_KEY!,forcePathStyle:true});
 const artifacts:Array<{ordinal:number;voice:string;sha256:string;storageKey:string;durationMs?:number;invocationId:string;snapshotId:string}>=[];
 await mkdir(root,{recursive:true});
 try{
  for(const turn of plan.turns){
   const speech={text:turn.text,language:"zh-CN",voice:{providerVoiceId:turn.voice,voiceVersion:"glm-tts-system-v1",speakingRate:1,pitch:0},outputFormat:"wav"};
   const result=await runtime.gateway.execute({workspaceId:ctx.workspaceId,routeSlot:"PODCAST_TTS",correlationId:job.id,idempotencyKey:`${key}:turn:${turn.ordinal}`,inputHash:hash(JSON.stringify(speech)),capability:{family:"SPEECH",outputFormat:"wav"},speech,budget:{maxSpeechCharacters:turn.text.length,maxAttempts:1},estimates:{speechCharacters:turn.text.length},pipelineVersion:"private-glm-tts-audition-v1"},{userId:ctx.userId});
   if(result.status!=="SUCCEEDED"||!result.invocationId)throw Error("AUDITION_RECONCILIATION_REQUIRED");
   const audio=result.response as SpeechResponse;if(audio.format!=="wav"||!audio.bytes.length)throw Error("AUDITION_AUDIO_INVALID");
   const sha=hash(audio.bytes),storageKey=`private-auditions/${ctx.workspaceId}/${job.id}/${turn.ordinal}-${sha}.wav`;
   await storage.putObject({key:storageKey,body:audio.bytes,contentType:"audio/wav"});if(hash(await storage.getObjectBytes(storageKey))!==sha)throw Error("AUDITION_STORAGE_MISMATCH");
   await writeFile(join(root,`audition-turn-${turn.ordinal}.private.wav`),audio.bytes);
   artifacts.push({ordinal:turn.ordinal,voice:turn.voice,sha256:sha,storageKey,durationMs:audio.durationMs,invocationId:result.invocationId,snapshotId:result.snapshot.id});
   await runtime.repository.consumeSpeechResult({workspaceId:ctx.workspaceId,invocationId:result.invocationId,snapshotId:result.snapshot.id,consumerKind:"PRIVATE_TTS_AUDITION",consumerKey:job.id+":"+turn.ordinal,consumerFingerprint:hash(JSON.stringify(artifacts.at(-1)))},async({tx})=>{await tx.job.update({where:{id:job.id},data:{result:json({artifacts,publicationAuthorized:false})}});});
  }
  if(diagnostic){await prisma.job.update({where:{id:job.id},data:{status:"SUCCEEDED",completedAt:new Date(),result:json({artifacts,diagnosticOnly:true,publicationAuthorized:false})}});return;}
  const assemblyTurns=completion?[{ordinal:1},...plan.turns]:plan.turns;
  const output=join(root,"glm-tts-audition.private.wav"),args=["-nostdin","-hide_banner","-y",...assemblyTurns.flatMap(t=>["-i",join(root,`audition-turn-${t.ordinal}.private.wav`)]),"-filter_complex","[0:a]apad=pad_dur=0.3[a0];[1:a]apad=pad_dur=0.3[a1];[2:a]apad=pad_dur=0.3[a2];[a0][a1][a2][3:a]concat=n=4:v=0:a=1[out]","-map","[out]","-ar","24000","-ac","1","-c:a","pcm_s16le",output];
  await promisify(execFile)("ffmpeg",args,{windowsHide:true,timeout:30000,maxBuffer:65536});
  const bytes=await readFile(output),combinedSha=hash(bytes),combinedKey=`private-auditions/${ctx.workspaceId}/${job.id}/combined-${combinedSha}.wav`;
  await storage.putObject({key:combinedKey,body:bytes,contentType:"audio/wav"});if(hash(await storage.getObjectBytes(combinedKey))!==combinedSha)throw Error("AUDITION_STORAGE_MISMATCH");
  await prisma.job.update({where:{id:job.id},data:{status:"SUCCEEDED",completedAt:new Date(),result:json({artifacts,combinedKey,combinedSha,characters:callCharacters,estimatedCny:callCharacters*2/10000,providerReportedCost:null,publicationAuthorized:false,...(completion?{recoveredFirstTurn:"offline-recovery.private.json"}:{})})}});
 }catch(error){await prisma.job.update({where:{id:job.id},data:{status:"FAILED",completedAt:new Date(),error:{code:error instanceof Error&&"code"in error?String(error.code):"AUDITION_FAILED_RECONCILIATION_REQUIRED"}}});throw error;
 }finally{
  const final=await prisma.job.findUniqueOrThrow({where:{id:job.id}}),invocations=await prisma.providerInvocation.findMany({where:{workspaceId:ctx.workspaceId,correlationId:job.id},select:{id:true,status:true,attempts:{select:{status:true,failureCode:true,remoteRequestId:true}}}}),usage=await prisma.providerUsageEvent.findMany({where:{invocationId:{in:invocations.map(i=>i.id)}}});
  await writeFile(join(root,diagnostic?"tts-diagnostic-result.private.json":completion?"tts-completion-result.private.json":"tts-audition-result.private.json"),JSON.stringify({jobId:job.id,status:final.status,error:final.error,result:final.result,invocations,usage},null,2));console.log(JSON.stringify({status:final.status,invocations:invocations.length,usageEvents:usage.length,completedTurns:artifacts.length}));await runtime.close();storage.close();
 }
}
main().catch(error=>{console.error(error instanceof Error&&"code"in error?String(error.code):error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:"AUDITION_FAILED_RECONCILIATION_REQUIRED");process.exitCode=1;}).finally(()=>prisma.$disconnect());
