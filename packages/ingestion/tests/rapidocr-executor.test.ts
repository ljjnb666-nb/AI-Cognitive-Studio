import { readFile, stat } from "node:fs/promises";
import type { Environment } from "@ai-cognitive/shared/server";
import { describe, expect, it, vi } from "vitest";
import {
  RAPIDOCR_EXECUTOR_NAME, RAPIDOCR_PINNED_VERSION,
  createRapidOcrPdfOcrExecutor, rapidOcrOfflineEnv, resolveRapidOcrExecutorConfig,
  verifyRapidOcrRuntime, type RapidOcrExecutorConfig,
} from "../src/rapidocr/rapidocr-executor.js";
import type { BoundedSpawnResult } from "../src/mineru/mineru-process.js";

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
  it("rejects invalid requested page before launching any child",async()=>{
    const runner=vi.fn(async()=>success("{}"));
    const executor=createRapidOcrPdfOcrExecutor(settings,{modelSha256:digest},runner);
    await expect(executor.extractPage({...request,physicalPageIndex:-1}))
      .resolves.toMatchObject({status:"FAILED",kind:"terminal"});
    expect(runner).not.toHaveBeenCalled();
  });
});
