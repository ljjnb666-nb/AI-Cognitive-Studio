import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnBounded } from "../mineru/mineru-process.js";
import { rapidOcrOfflineEnv } from "../rapidocr/rapidocr-executor.js";

export const DOCLING_LAYOUT_VERSION = "2.141.0";
export const DOCLING_LAYOUT_ID = "docling-standard-layout";
const MAX_PDF_BYTES = 110_000_000;
const MAX_MARKDOWN_CHARS = 160_000;
const MAX_OUTPUT_BYTES = 800_000;

export type DoclingLayoutConfig = {
  python: string;
  artifacts: string;
  script: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type DoclingLayoutRequest = {
  pdfBytes: Uint8Array;
  physicalPageIndex: number;
  /** Optional parent lease cancellation: abort the bounded Python process. */
  signal?: AbortSignal;
};

/** Never an authoritative transcription, canonical block or independently approved gold. */
export type DoclingLayoutCandidate = {
  authority: "NON_AUTHORITATIVE_LAYOUT_CANDIDATE";
  sourceMethod: "DOCLING_LAYOUT_CANDIDATE_ONLY";
  physicalPageIndex: number;
  ocrUsed: false;
  fullPageReference: false;
  parserName: typeof DOCLING_LAYOUT_ID;
  parserVersion: typeof DOCLING_LAYOUT_VERSION;
  artifactSha256: string;
  markdown: string;
  textItemCount: number;
  pictureItemCount: number;
  tableItemCount: number;
};

export type DoclingLayoutResult =
  | {status:"SUCCEEDED";candidate:DoclingLayoutCandidate}
  | {status:"FAILED";reason:"REJECTED"|"TIMEOUT"|"CLOSING"|"PROCESS_UNKNOWN"};

export type DoclingLayoutHandle = {
  readonly parserName: typeof DOCLING_LAYOUT_ID;
  /** Immutable model identity, bound to a successful startup asset digest. */
  readonly modelSha256: string;
  inspect(request: DoclingLayoutRequest): Promise<DoclingLayoutResult>;
  close(): Promise<void>;
};

type Runner = typeof spawnBounded;
type ProcessReply = Awaited<ReturnType<Runner>>;

function isFile(path:string):boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
function isDirectory(path:string):boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
export function resolveDoclingLayoutConfig(input:{
  enabled:boolean;python?:string;artifacts?:string;
  timeoutMs?:number;maxOutputBytes?:number;
},hasFile=isFile,hasDir=isDirectory):DoclingLayoutConfig|null {
  if(!input.enabled){
    if(input.python!==undefined||input.artifacts!==undefined||
       input.timeoutMs!==undefined||input.maxOutputBytes!==undefined)
      throw new Error("DOCLING_LAYOUT_DISABLED_WITH_CONFIG");
    return null;
  }
  if(!input.python||!isAbsolute(input.python)||!hasFile(input.python))
    throw new Error("DOCLING_LAYOUT_PYTHON_UNAVAILABLE");
  if(!input.artifacts||!isAbsolute(input.artifacts)||!hasDir(input.artifacts))
    throw new Error("DOCLING_LAYOUT_ARTIFACTS_UNAVAILABLE");
  const timeoutMs=input.timeoutMs??120_000;
  const maxOutputBytes=input.maxOutputBytes??MAX_OUTPUT_BYTES;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>180_000||
     !Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<4096||
     maxOutputBytes>MAX_OUTPUT_BYTES)
    throw new Error("DOCLING_LAYOUT_BUDGET_INVALID");
  return {
    python:input.python,artifacts:input.artifacts,
    script:fileURLToPath(new URL("./docling-layout-child.py",import.meta.url)),
    timeoutMs,maxOutputBytes,
  };
}
function parseObject(stdout:string):Record<string,unknown>|null {
  if(!stdout||stdout.length>MAX_OUTPUT_BYTES||stdout.trim().split("\n").length!==1)
    return null;
  try{
    const candidate:unknown=JSON.parse(stdout.trim());
    return typeof candidate==="object"&&candidate!==null&&!Array.isArray(candidate)
      ?candidate as Record<string,unknown>:null;
  }catch{return null;}
}
function exactKeys(value:Record<string,unknown>,keys:string[]):boolean {
  return Object.keys(value).sort().join(",")===keys.sort().join(",");
}
function failed(reason:"REJECTED"|"TIMEOUT"|"CLOSING"|"PROCESS_UNKNOWN"):DoclingLayoutResult {
  return {status:"FAILED",reason};
}

/** Startup admission: pinned Docling + SHA of actual offline layout assets. */
export async function verifyDoclingLayout(
  config:DoclingLayoutConfig,run:Runner=spawnBounded,
):Promise<{artifactSha256:string}> {
  const response=await run(config.python,[
    config.script,"--artifacts",config.artifacts,"--probe",
  ],{
    env:rapidOcrOfflineEnv(),timeoutMs:Math.min(config.timeoutMs,120_000),
    maxOutputBytes:4096,
  });
  if(response.code!==0||response.timedOut||response.aborted||
     response.spawnErrorCode||response.outputOverflow||response.signal)
    throw new Error("DOCLING_LAYOUT_PROBE_REJECTED");
  const parsed=parseObject(response.stdout);
  if(!parsed||!exactKeys(parsed,["schemaVersion","status","docling","artifactSha256"])||
     parsed.schemaVersion!==1||parsed.status!=="READY"||
     parsed.docling!==DOCLING_LAYOUT_VERSION||
     typeof parsed.artifactSha256!=="string"||
     !/^[a-f0-9]{64}$/.test(parsed.artifactSha256))
    throw new Error("DOCLING_LAYOUT_PROVENANCE_REJECTED");
  return {artifactSha256:parsed.artifactSha256};
}

export function createDoclingLayoutCandidateExecutor(
  config:DoclingLayoutConfig,verified:{artifactSha256:string},run:Runner=spawnBounded,
):DoclingLayoutHandle {
  if(!/^[a-f0-9]{64}$/.test(verified.artifactSha256))
    throw new Error("DOCLING_LAYOUT_PROVENANCE_REJECTED");
  let closing=false;
  const live=new Set<{controller:AbortController;done:Promise<void>}>();
  async function inspectInternal(request:DoclingLayoutRequest,signal:AbortSignal):Promise<DoclingLayoutResult>{
    if(signal.aborted)return failed("CLOSING");
    if(!Number.isSafeInteger(request.physicalPageIndex)||request.physicalPageIndex<0||
       request.pdfBytes.length<5||request.pdfBytes.length>MAX_PDF_BYTES)
      return failed("REJECTED");
    let folder:string|null=null;
    try{
      folder=await mkdtemp(join(tmpdir(),"acs-docling-layout-"));
      if(signal.aborted)return failed("CLOSING");
      const pdf=join(folder,"source.pdf");
      await writeFile(pdf,request.pdfBytes,{flag:"wx"});
      if(signal.aborted)return failed("CLOSING");
      const response:ProcessReply=await run(config.python,[
        config.script,"--artifacts",config.artifacts,
        "--pdf",pdf,"--page",String(request.physicalPageIndex),
      ],{
        cwd:folder,env:rapidOcrOfflineEnv(),
        timeoutMs:config.timeoutMs,maxOutputBytes:config.maxOutputBytes,
        abortSignal:signal,
      });
      if(response.timedOut)return failed("TIMEOUT");
      if(response.aborted||response.signal||response.spawnErrorCode)
        return failed(response.treeTerminationConfirmed?"CLOSING":"PROCESS_UNKNOWN");
      if(response.code!==0||response.outputOverflow||signal.aborted)
        return failed("REJECTED");
      const item=parseObject(response.stdout);
      if(!item||!exactKeys(item,[
         "schemaVersion","status","sourceMethod","ocrUsed","fullPageReference",
         "markdown","textItemCount","pictureItemCount","tableItemCount",
      ])||item.schemaVersion!==1||item.status!=="SUCCEEDED"||
         item.sourceMethod!=="DOCLING_LAYOUT_CANDIDATE_ONLY"||
         item.ocrUsed!==false||item.fullPageReference!==false||
         typeof item.markdown!=="string"||item.markdown.length>MAX_MARKDOWN_CHARS||
         item.markdown.includes("\0")||
         !["textItemCount","pictureItemCount","tableItemCount"].every(
           key=>Number.isSafeInteger(item[key])&&(item[key] as number)>=0&&(item[key] as number)<=100000,
         ))
        return failed("REJECTED");
      return {
        status:"SUCCEEDED",
        candidate:{
          authority:"NON_AUTHORITATIVE_LAYOUT_CANDIDATE",
          sourceMethod:"DOCLING_LAYOUT_CANDIDATE_ONLY",
          physicalPageIndex:request.physicalPageIndex,
          ocrUsed:false,fullPageReference:false,
          parserName:DOCLING_LAYOUT_ID,
          parserVersion:DOCLING_LAYOUT_VERSION,
          artifactSha256:verified.artifactSha256,
          markdown:item.markdown,
          textItemCount:item.textItemCount as number,
          pictureItemCount:item.pictureItemCount as number,
          tableItemCount:item.tableItemCount as number,
        },
      };
    }catch{
      return failed(signal.aborted?"CLOSING":"REJECTED");
    }finally{
      if(folder!==null)await rm(folder,{recursive:true,force:true}).catch(()=>undefined);
    }
  }
  return {
    parserName:DOCLING_LAYOUT_ID,
    modelSha256:verified.artifactSha256,
    async inspect(request){
      if(closing||request.signal?.aborted)return failed("CLOSING");
      const controller=new AbortController();
      const onAbort=()=>controller.abort();
      request.signal?.addEventListener("abort",onAbort,{once:true});
      // A race with the initial aborted check must not start a live model.
      if(request.signal?.aborted)controller.abort();
      const result=inspectInternal(request,controller.signal);
      const active={controller,done:result.then(()=>undefined,()=>undefined)};
      live.add(active);
      try{return await result;}finally{
        request.signal?.removeEventListener("abort",onAbort);
        live.delete(active);
      }
    },
    async close(){
      closing=true;
      const running=[...live];
      for(const item of running)item.controller.abort();
      await Promise.all(running.map(item=>item.done));
    },
  };
}
