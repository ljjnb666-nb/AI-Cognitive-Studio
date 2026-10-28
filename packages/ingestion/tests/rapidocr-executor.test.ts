import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Environment } from "@ai-cognitive/shared/server";
import { describe, expect, it, vi } from "vitest";
import {
  RAPIDOCR_EXECUTOR_NAME, RAPIDOCR_PINNED_VERSION,
  createRapidOcrPdfOcrExecutor, rapidOcrOfflineEnv, resolveRapidOcrExecutorConfig,
  verifyRapidOcrRuntime, type RapidOcrExecutorConfig,
} from "../src/rapidocr/rapidocr-executor.js";
import type { BoundedSpawnOptions, BoundedSpawnResult } from "../src/mineru/mineru-process.js";

const fakeEnv=(overrides: Record<string,unknown> = {}) => ({
  OCR_PROVIDER:"rapidocr",
  RAPIDOCR_PYTHON_PATH:"/synthetic/python",
  WORKER_INGESTION_CONCURRENCY:1,
  ...overrides,
} as unknown as Environment);

const settings: RapidOcrExecutorConfig = {
  python:"/synthetic/python",script:"/synthetic/rapidocr-child.py",
  timeoutMs:120_000,maxOutputBytes:512_000,
};
const digest="a".repeat(64);
const success=(stdout:string,overrides:Partial<BoundedSpawnResult> = {}):BoundedSpawnResult=>({
  code:0,signal:null,timedOut:false,aborted:false,outputOverflow:false,
  directChildExitObserved:true,treeTerminationConfirmed:false,
  stdout,stderr:"",...overrides,
});
const request={
  ingestionRunId:"run",workspaceId:"ws",sourceDocumentId:"doc",
  physicalPageIndex:3,routingGeneration:1,runExecutionToken:"claim",
  pdfBytes:new Uint8Array(Buffer.from("%PDF-1.7\nSYNTHETIC_TEST_ONLY","utf8")),
};

describe("RapidOCR startup contract",()=>{
  it("default unconfigured OCR stays disabled",()=>{
    expect(resolveRapidOcrExecutorConfig({
      OCR_PROVIDER:undefined,WORKER_INGESTION_CONCURRENCY:1,
    } as unknown as Environment)).toBeNull();
  });
  it("rejects orphan RapidOCR settings, wrong binary and concurrency",()=>{
    expect(()=>resolveRapidOcrExecutorConfig(fakeEnv({OCR_PROVIDER:undefined})))
      .toThrow("OCR_RAPIDOCR_PROVIDER_REQUIRED");
    expect(()=>resolveRapidOcrExecutorConfig(fakeEnv(),()=>false))
      .toThrow("OCR_RAPIDOCR_PYTHON_INVALID");
    expect(()=>resolveRapidOcrExecutorConfig(fakeEnv({WORKER_INGESTION_CONCURRENCY:2}),()=>true))
      .toThrow("OCR_RAPIDOCR_CONCURRENCY_UNSUPPORTED");
    expect(()=>resolveRapidOcrExecutorConfig(fakeEnv({RAPIDOCR_TIMEOUT_MS:10}),()=>true))
      .toThrow("OCR_RAPIDOCR_LIMITS_INVALID");
  });
  it("accepts explicit pinned local python and rejects network-capable child env",()=>{
    const config=resolveRapidOcrExecutorConfig(fakeEnv(),()=>true);
    expect(config?.python).toBe("/synthetic/python");
    expect(config?.script.endsWith("rapidocr-child.py")).toBe(true);
    const offline=rapidOcrOfflineEnv();
    expect(offline.HF_HUB_OFFLINE).toBe("1");
    expect(offline.HTTP_PROXY).toBe("http://127.0.0.1:1");
    expect(offline.HTTPS_PROXY).toBe("http://127.0.0.1:1");
    expect(offline.ALL_PROXY).toBe("http://127.0.0.1:1");
    expect(offline.NO_PROXY).toBe("");
    expect(offline.no_proxy).toBe("");
    // In particular NO_PROXY=* would bypass the explicit refusal proxy.
    expect(offline.NO_PROXY).not.toBe("*");
    expect(offline.OPENBLAS_NUM_THREADS).toBe("2");
  });
  it("never forwards parent database, auth, provider keys or PYTHONPATH into untrusted PDF subprocess",()=>{
    const environment=rapidOcrOfflineEnv({
      PATH:"C:\\synthetic\\python", SystemRoot:"C:\\Windows",
      DATABASE_URL:"postgresql://secret", BETTER_AUTH_SECRET:"secret",
      PROVIDER_GATEWAY_KEYRING:"secret", ZHIPU_API_KEY:"secret",
      PYTHONPATH:"C:\\untrusted", PYTHONHOME:"C:\\untrusted",
      HTTP_PROXY:"http://unsafe.example",
    });
    expect(environment.PATH).toBe("C:\\synthetic\\python");
    expect(environment.SystemRoot).toBe("C:\\Windows");
    expect(environment.DATABASE_URL).toBeUndefined();
    expect(environment.BETTER_AUTH_SECRET).toBeUndefined();
    expect(environment.PROVIDER_GATEWAY_KEYRING).toBeUndefined();
    expect(environment.ZHIPU_API_KEY).toBeUndefined();
    expect(environment.PYTHONPATH).toBeUndefined();
    expect(environment.PYTHONHOME).toBeUndefined();
    expect(environment.PYTHONNOUSERSITE).toBe("1");
    expect(environment.HTTP_PROXY).toBe("http://127.0.0.1:1");
  });
  it("requires actual runtime-issued pinned versions and model SHA",async()=>{
    const good=vi.fn(async()=>success(JSON.stringify({
      schemaVersion:1,status:"READY",rapidocr:"3.9.2",
      onnxruntime:"1.22.1",modelSha256:digest,
    })));
    await expect(verifyRapidOcrRuntime(settings,good)).resolves.toEqual({modelSha256:digest});
    expect(good.mock.calls).toHaveLength(1);
    const fake=vi.fn(async()=>success(JSON.stringify({
      schemaVersion:1,status:"READY",rapidocr:"3.9.3",
      onnxruntime:"1.22.1",modelSha256:digest,
    })));
    await expect(verifyRapidOcrRuntime(settings,fake))
      .rejects.toThrow("OCR_RAPIDOCR_PROVENANCE_INVALID");
    const trace=vi.fn(async()=>success("warning\n"+JSON.stringify({
      schemaVersion:1,status:"READY",rapidocr:"3.9.2",
      onnxruntime:"1.22.1",modelSha256:digest,
    })));
    await expect(verifyRapidOcrRuntime(settings,trace))
      .rejects.toThrow("OCR_RAPIDOCR_PROVENANCE_INVALID");
  });
});

describe("RapidOCR executor uses existing durable page seam",()=>{
  it("uses requested physical page, exact bytes, no shell, isolated temp dir and actual provenance",async()=>{
    let savedPath="";
    const runner=vi.fn(async(_python:string,args:string[],options:unknown)=>{
      expect(args[0]).toBe(settings.script);
      expect(args[1]).toBe("--pdf");
      expect(args[3]).toBe("--page");
      expect(args[4]).toBe("3");
      savedPath=args[2]!;
      expect((await readFile(savedPath)).equals(Buffer.from(request.pdfBytes))).toBe(true);
      expect(options).toMatchObject({timeoutMs:120_000,maxOutputBytes:512_000});
      return success(JSON.stringify({schemaVersion:1,status:"SUCCEEDED",text:"扫描中文\\n第二行"}));
    });
    const executor=createRapidOcrPdfOcrExecutor(settings,{modelSha256:digest},runner);
    expect(executor.descriptor).toEqual({
      name:RAPIDOCR_EXECUTOR_NAME,version:RAPIDOCR_PINNED_VERSION,
      parserMode:"offline-pdf-1.6x",modelRevision:digest,
    });
    await expect(executor.extractPage(request)).resolves.toEqual({
      status:"SUCCEEDED",text:"扫描中文\\n第二行",
    });
    expect(runner).toHaveBeenCalledTimes(1);
    await expect(stat(savedPath)).rejects.toMatchObject({code:"ENOENT"});
  });
  it("uses verified 151.5MB file-backed input for one page without writing a second 151MB file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rapidocr-stage-path-"));
    const source = join(dir, "verified-source.pdf");
    try {
      // Sparse size is intentional: this unit test validates the executor's
      // file-path protocol, NOT image/page recognition or PDF validity.
      await writeFile(source, "%PDF-1.7\\n");
      await truncate(source, 151_495_200);
      let calls = 0;
      const runner = vi.fn(async(_python:string,args:string[],opts:BoundedSpawnOptions) => {
        calls++;
        expect(args.slice(0,2)).toEqual([settings.script,"--pdf"]);
        expect(args[2]).toBe(source);
        expect(args.slice(3)).toEqual(["--page","3"]);
        expect(opts.cwd).not.toBe(dir);
        expect((await stat(source)).size).toBe(151_495_200);
        return success(JSON.stringify({schemaVersion:1,status:"SUCCEEDED",text:"Synthetic OCR result"}));
      });
      const executor = createRapidOcrPdfOcrExecutor(settings,{modelSha256:digest},runner);
      expect(executor.extractPageFile).toBeTypeOf("function");
      const fileRequest = {
        ingestionRunId:request.ingestionRunId,workspaceId:request.workspaceId,
        sourceDocumentId:request.sourceDocumentId,physicalPageIndex:3,
        routingGeneration:1,runExecutionToken:request.runExecutionToken,pdfFilePath:source,
      };
      await expect(executor.extractPageFile!(fileRequest)).resolves.toEqual({
        status:"SUCCEEDED",text:"Synthetic OCR result",
      });
      await expect(executor.extractPageFile!(fileRequest)).resolves.toEqual({
        status:"SUCCEEDED",text:"Synthetic OCR result",
      });
      expect(calls).toBe(2);
      expect((await stat(source)).size).toBe(151_495_200);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it("rejects missing, relative, non-PDF and oversized file paths before Python launch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rapidocr-stage-negative-"));
    const runner = vi.fn(async()=>success("{}"));
    const executor = createRapidOcrPdfOcrExecutor(settings,{modelSha256:digest},runner);
    const base = {
      ingestionRunId:request.ingestionRunId,workspaceId:request.workspaceId,
      sourceDocumentId:request.sourceDocumentId,physicalPageIndex:3,
      routingGeneration:1,runExecutionToken:request.runExecutionToken,
    };
    try {
      for (const name of ["nonexistent.pdf","bad.pdf","oversized.pdf"]) {
        const path=join(dir,name);
        if (name==="bad.pdf") await writeFile(path,"INVALID FILE");
        if (name==="oversized.pdf") {
          await writeFile(path,"%PDF-1.7\\n");
          await truncate(path,200*1024*1024+1);
        }
        await expect(executor.extractPageFile!({...base,pdfFilePath:path}))
          .resolves.toMatchObject({status:"FAILED"});
      }
      await expect(executor.extractPageFile!({...base,pdfFilePath:"relative.pdf"}))
        .resolves.toMatchObject({status:"FAILED",kind:"terminal"});
      expect(runner).not.toHaveBeenCalled();
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it("rejects forged success, extra protocol output and null bytes",async()=>{
    for(const stdout of [
      JSON.stringify({schemaVersion:1,status:"SUCCEEDED",text:42}),
      JSON.stringify({schemaVersion:1,status:"SUCCEEDED",text:"abc",independent_gold:true}),
      JSON.stringify({schemaVersion:1,status:"SUCCEEDED",text:"a\0b"}),
      "{}\n{}",
    ]){
      const executor=createRapidOcrPdfOcrExecutor(settings,{modelSha256:digest},
        async()=>success(stdout));
      await expect(executor.extractPage(request)).resolves.toEqual({
        status:"FAILED",errorCode:"SOURCE_OCR_OUTPUT_INVALID",kind:"terminal",
      });
    }
  });
  it("does not reclassify an unconfirmed timed-out process as safely stopped",async()=>{
    const executor=createRapidOcrPdfOcrExecutor(settings,{modelSha256:digest},
      async()=>success("",{code:null,timedOut:true,treeTerminationConfirmed:false}));
    await expect(executor.extractPage(request)).resolves.toEqual({
      status:"FAILED",errorCode:"SOURCE_OCR_TIMEOUT",kind:"terminal",
    });
  });
  it("validated termination permits only the existing durable transient retry policy",async()=>{
    const executor=createRapidOcrPdfOcrExecutor(settings,{modelSha256:digest},
      async()=>success("",{code:null,timedOut:true,treeTerminationConfirmed:true}));
    await expect(executor.extractPage(request)).resolves.toEqual({
      status:"FAILED",errorCode:"SOURCE_OCR_TIMEOUT",kind:"transient",
    });
  });

  it("worker shutdown aborts its owned Python OCR child, waits for disposition and rejects new work",async()=>{
    let started!: () => void;
    const entered = new Promise<void>((resolve)=>{started=resolve;});
    let abortSignal: AbortSignal | undefined;
    const runner=vi.fn(async (_python:string,_args:string[],opts: BoundedSpawnOptions)=>{
      abortSignal=opts.abortSignal;
      started();
      return await new Promise<BoundedSpawnResult>((resolve)=>{
        opts.abortSignal?.addEventListener("abort",()=>{
          resolve(success("",{code:null,aborted:true,treeTerminationConfirmed:true}));
        },{once:true});
      });
    });
    const executor=createRapidOcrPdfOcrExecutor(settings,{modelSha256:digest},runner);
    const running=executor.extractPage(request);
    await entered;
    await executor.close();
    expect(abortSignal?.aborted).toBe(true);
    await expect(running).resolves.toEqual({
      status:"FAILED",errorCode:"SOURCE_OCR_PROCESS_FAILED",kind:"transient",
    });
    await expect(executor.extractPage(request)).resolves.toEqual({
      status:"FAILED",errorCode:"SOURCE_OCR_PROCESS_FAILED",kind:"transient",
    });
    expect(runner).toHaveBeenCalledTimes(1);
    await executor.close(); // idempotent: no fresh tasks
  });
  it("shutdown with unknown subprocess-tree termination is terminal, never safely retried",async()=>{
    let started!:()=>void;
    const entered=new Promise<void>((resolve)=>{started=resolve;});
    const runner=vi.fn(async (_python:string,_args:string[],opts: BoundedSpawnOptions)=>{
      started();
      return await new Promise<BoundedSpawnResult>((resolve)=>{
        opts.abortSignal?.addEventListener("abort",()=>{
          resolve(success("",{code:null,aborted:true,treeTerminationConfirmed:false}));
        },{once:true});
      });
    });
    const executor=createRapidOcrPdfOcrExecutor(settings,{modelSha256:digest},runner);
    const running=executor.extractPage(request);
    await entered;
    await executor.close();
    await expect(running).resolves.toEqual({
      status:"FAILED",errorCode:"SOURCE_OCR_PROCESS_FAILED",kind:"terminal",
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it("a successful Python stdout racing with shutdown never gains publication authority",async()=>{
    let started!:()=>void;
    const entered=new Promise<void>((resolve)=>{started=resolve;});
    const runner=vi.fn(async (_python:string,_args:string[],opts: BoundedSpawnOptions)=>{
      started();
      return await new Promise<BoundedSpawnResult>((resolve)=>{
        opts.abortSignal?.addEventListener("abort",()=>{
          resolve(success(JSON.stringify({schemaVersion:1,status:"SUCCEEDED",text:"late success"})));
        },{once:true});
      });
    });
    const executor=createRapidOcrPdfOcrExecutor(settings,{modelSha256:digest},runner);
    const running=executor.extractPage(request);
    await entered;
    await executor.close();
    await expect(running).resolves.toMatchObject({status:"FAILED",kind:"terminal"});
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid requested page before launching any child",async()=>{
    const runner=vi.fn(async()=>success("{}"));
    const executor=createRapidOcrPdfOcrExecutor(settings,{modelSha256:digest},runner);
    await expect(executor.extractPage({...request,physicalPageIndex:-1}))
      .resolves.toMatchObject({status:"FAILED",kind:"terminal"});
    expect(runner).not.toHaveBeenCalled();
  });
});
