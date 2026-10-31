/** Runtime-only cold/warm benchmark, separate from production page claims.
 * A private, bounded session is closed in finally. It is never offered to
 * application jobs and supplies no production throughput or publication claim.
 * --force really means reparse in MinerU 4.0.3; both receipts must deny cache hits. */
import {afterAll,describe,it,expect} from "vitest";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {freemem} from "node:os";
import type {Environment} from "@ai-cognitive/shared/server";
import {approvedManifestText,APPROVED_MINERU_MANIFEST_SHA256} from "../../src/mineru/mineru-approved-inventory.js";
import {resolveMineruExecutorConfig,verifyMineruRuntime} from "../../src/mineru/mineru-config.js";
import {snapshotMineruStandardModels} from "../../src/mineru/mineru-model-snapshot.js";
import {createMineruServerSession} from "../../src/mineru/mineru-server.js";
import {probeFreeTcpPort,spawnBounded,recordedProcessAlive} from "../../src/mineru/mineru-process.js";
import {parseServerBaseUrl,setParseServerModeManaged,waitForStandardParseServerReady} from "../../src/mineru/mineru-standard-server-setup.js";
import {buildMineruParseArgs,judgeMineruParseExit} from "../../src/mineru/mineru-commands.js";
import {sha256Bytes} from "../../src/mineru/mineru-standard-admission.js";
const root=process.env.MINERU_REAL_PRIVATE_ROOT;
const pdf=process.env.MINERU_REAL_STANDARD_PDF;
const exe=process.env.MINERU_REAL_EXECUTABLE;
const models=process.env.MINERU_REAL_MODEL_PATH;
let retained:string|undefined;
let cleanupConfirmed=false;
afterAll(()=>{if(retained && cleanupConfirmed)rmSync(retained,{recursive:true,force:true});});
const real=root && pdf && exe && models ? describe : describe.skip;
real("MinerU isolated cold/warm runtime measurement",()=>{
 it("forces two real parses of the same scan in one isolated measured engine, without cache hits",async()=>{
  if(!root || !pdf || !exe || !models)throw new Error("REAL_PERFORMANCE_ENV_REQUIRED");
  const trial=mkdtempSync(join(root,"cold-warm-runtime-"));retained=trial;
  const manifest=join(trial,"manifest.json");writeFileSync(manifest,approvedManifestText());
  const config=resolveMineruExecutorConfig({OCR_PROVIDER:"mineru",MINERU_EXECUTABLE:exe,MINERU_MODEL_SOURCE:"local",MINERU_MODEL_PATH:models,MINERU_HOME_ROOT:join(trial,"homes"),OCR_TIER_STANDARD_EXPERIMENTAL_ENABLED:"true",OCR_TIER_STANDARD_EXECUTION_ADMISSION_ENABLED:"true",MINERU_STANDARD_MODEL_MANIFEST:manifest} as unknown as Environment)!;
  await verifyMineruRuntime(config);
  if(freemem()<config.standard!.minFreeMemoryBytes)throw new Error("REAL_PERFORMANCE_MEMORY_ADMISSION_REFUSED");
  const home=join(trial,"home"),output=join(trial,"output"),snapshot=join(trial,"models");
  await mkdir(home);await mkdir(output);
  const controller=new AbortController();
  const safety=setInterval(()=>{if(freemem()<1073741824)controller.abort();},250);
  let session:Awaited<ReturnType<typeof createMineruServerSession>>|undefined;
  const started=Date.now();
  try {
   const snapStarted=Date.now();await snapshotMineruStandardModels(models,snapshot,config.standard!,controller.signal);const snapshotMs=Date.now()-snapStarted;
   const port=await probeFreeTcpPort();const controlled=join(home,"controlled-config.yaml");writeFileSync(controlled,"{}\n");
   const denial="http://127.0.0.1:9";
   const env:NodeJS.ProcessEnv={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("MINERU_"))),NODE_ENV:process.env.NODE_ENV,HTTP_PROXY:denial,HTTPS_PROXY:denial,ALL_PROXY:denial,NO_PROXY:"",http_proxy:denial,https_proxy:denial,all_proxy:denial,no_proxy:"",MINERU_HOME:home,MINERU_CONFIG:controlled,MINERU_MODEL_SOURCE:"local",MINERU_MODEL_BASE_DIR:snapshot,MINERU_MODEL_SMALL_BACKEND:"onnx",MINERU_MODEL_VLM_ENGINE:"llama-cpp",MINERU_MODEL_VLM_SERVER_URL:"",MINERU_MODEL_VLM_MAX_CONCURRENCY:"1",MINERU_DOCLIB_PARSE_WORKERS:"1",MINERU_DOCLIB_INGEST_WORKERS:"1",MINERU_DOCLIB_MANAGED_PARSE_SERVER_HOST:"127.0.0.1",MINERU_DOCLIB_MANAGED_PARSE_SERVER_PORT:String(port),MINERU_DOCLIB_MANAGED_PARSE_SERVER_STRICT_PORT:"true",TMP:output,TEMP:output};
   session=await createMineruServerSession({executable:config.executable,executableArgs:config.executableArgs,homeDir:home,childEnvBase:env,startTimeoutMs:config.serverStartTimeoutMs,stopTimeoutMs:config.serverStopTimeoutMs,maxOutputBytes:1048576,abortSignal:controller.signal});
   expect(await session.start()).toBeNull();
   const endpoint=session.endpoint!;const base=parseServerBaseUrl(endpoint.transports);expect(base).not.toBeNull();
   const identity={pid:endpoint.pid,serverId:endpoint.serverId};const loadStarted=Date.now();
   expect(await setParseServerModeManaged(base!,5000,controller.signal,identity)).toBeNull();
   let enginePid=0;
   expect(await waitForStandardParseServerReady(base!,config.serverStartTimeoutMs,{signal:controller.signal,expectedIdentity:identity,expectedManagedPort:port,onReady:local=>{enginePid=Number(local.managed_pid);}})).toBeNull();
   const engineReadyMs=Date.now()-loadStarted;
   const parses=[];
   for(const name of ["first","warm"]){
    const path=join(output,`${name}.md`);const parseStarted=Date.now();
    const parsed=await spawnBounded(config.executable,[...config.executableArgs,...buildMineruParseArgs({inputPdfPath:pdf,tier:"standard",physicalPageIndex:0,outputMarkdownPath:path})],{env,cwd:output,timeoutMs:config.standard!.timeoutMs,maxOutputBytes:1048576,abortSignal:controller.signal});
    expect(judgeMineruParseExit({exitCode:parsed.code,stdout:parsed.stdout}).kind).toBe("OUTPUT_WRITTEN");
    const receipt=JSON.parse(parsed.stdout.trim()) as {parse:{tier:string;status:string;cache_hit:boolean}};
    expect(receipt.parse).toMatchObject({tier:"standard",status:"done",cache_hit:false});
    const bytes=readFileSync(path);expect(bytes.byteLength).toBeGreaterThan(0);
    parses.push({label:name,parseMs:Date.now()-parseStarted,cacheHit:receipt.parse.cache_hit,outputBytes:bytes.byteLength,outputSha256:sha256Bytes(bytes)});
   }
   const status=await fetch(`${base}/api/v1/server/status`,{redirect:"error",signal:AbortSignal.timeout(5000)}).then(r=>r.json()) as {pid:number;server_id:string;parse_server:{local:{managed_pid:number}}};
   expect(status.pid).toBe(endpoint.pid);expect(status.server_id).toBe(endpoint.serverId);expect(status.parse_server.local.managed_pid).toBe(enginePid);
   writeFileSync(join(root,"engine-cold-warm.private.json"),JSON.stringify({scope:"isolated engine benchmark; production still reloads per claim",manifestDigest:APPROVED_MINERU_MANIFEST_SHA256,snapshotMs,engineReadyMs,throughSecondParseMs:Date.now()-started,parses},null,2));
   const stop=await session.stop();expect(["STOPPED","ALREADY_EXITED","KILLED_BY_RECORDED_IDENTITY"]).toContain(stop.kind);
   expect(await recordedProcessAlive(enginePid)).toBe(false);
   cleanupConfirmed=true;
  } finally {
   try {if(session)await session.stop();} finally {clearInterval(safety);}
  }
 },600000);
});
