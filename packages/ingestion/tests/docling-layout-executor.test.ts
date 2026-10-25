import { readFile, stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { type BoundedSpawnOptions, type BoundedSpawnResult } from "../src/mineru/mineru-process.js";
import {
  DOCLING_LAYOUT_VERSION,createDoclingLayoutCandidateExecutor,
  resolveDoclingLayoutConfig,verifyDoclingLayout,
  type DoclingLayoutConfig,
} from "../src/docling/docling-layout-executor.js";

const config:DoclingLayoutConfig={
  python:"/synthetic/python",
  artifacts:"/synthetic/offline-models",
  script:"/synthetic/docling-layout-child.py",
  timeoutMs:120000,maxOutputBytes:800000,
};
const sha="b".repeat(64);
const pdf=new Uint8Array(Buffer.from("%PDF-1.7\nONLY_SYNTHETIC_BYTES"));
const okay=(stdout:string,more:Partial<BoundedSpawnResult>={}):BoundedSpawnResult=>({
  code:0,signal:null,timedOut:false,aborted:false,
  outputOverflow:false,directChildExitObserved:true,
  treeTerminationConfirmed:false,stdout,stderr:"",...more,
});
const report=(patch:Record<string,unknown>={})=>JSON.stringify({
  schemaVersion:1,status:"SUCCEEDED",
  sourceMethod:"DOCLING_LAYOUT_CANDIDATE_ONLY",
  ocrUsed:false,fullPageReference:false,
  markdown:"# A Title\n\nA paragraph\n\n| A | B |\n|--|--|",
  textItemCount:2,pictureItemCount:1,tableItemCount:1,
  ...patch,
});

describe("Docling Standard offline layout candidate",()=>{
  it("disabled default, invalid paths and resource budgets fail before any invocation",()=>{
    expect(resolveDoclingLayoutConfig({enabled:false})).toBeNull();
    expect(()=>resolveDoclingLayoutConfig({enabled:false,python:"/unexpected"}))
      .toThrow("DOCLING_LAYOUT_DISABLED_WITH_CONFIG");
    expect(()=>resolveDoclingLayoutConfig({enabled:true,python:"python",artifacts:"/models"},()=>true,()=>true))
      .toThrow("DOCLING_LAYOUT_PYTHON_UNAVAILABLE");
    expect(()=>resolveDoclingLayoutConfig({enabled:true,python:"/python",artifacts:"/models"},()=>true,()=>false))
      .toThrow("DOCLING_LAYOUT_ARTIFACTS_UNAVAILABLE");
    expect(()=>resolveDoclingLayoutConfig({enabled:true,python:"/python",artifacts:"/models",timeoutMs:1},()=>true,()=>true))
      .toThrow("DOCLING_LAYOUT_BUDGET_INVALID");
    expect(resolveDoclingLayoutConfig({enabled:true,python:"/python",artifacts:"/models"},()=>true,()=>true))
      .toMatchObject({python:"/python",artifacts:"/models",timeoutMs:120000});
  });
  it("version/real asset digest must match pinned startup probe",async()=>{
    const runner=vi.fn(async()=>okay(JSON.stringify({
      schemaVersion:1,status:"READY",docling:DOCLING_LAYOUT_VERSION,artifactSha256:sha,
    })));
    await expect(verifyDoclingLayout(config,runner)).resolves.toEqual({artifactSha256:sha});
    expect(runner).toHaveBeenCalledTimes(1);
    await expect(verifyDoclingLayout(config,async()=>okay(JSON.stringify({
      schemaVersion:1,status:"READY",docling:"2.141.1",artifactSha256:sha,
    })))).rejects.toThrow("DOCLING_LAYOUT_PROVENANCE_REJECTED");
  });
  it("exact original physical page and private PDF bytes reach bounded subprocess, not app keys",async()=>{
    let tempPdf="";
    const runner=vi.fn(async (program:string,args:string[],options:BoundedSpawnOptions)=>{
      expect(program).toBe(config.python);
      expect(args).toEqual([config.script,"--artifacts",config.artifacts,
        "--pdf",expect.any(String),"--page","7"]);
      tempPdf=args[4]!;
      expect(await readFile(tempPdf)).toEqual(Buffer.from(pdf));
      expect(options.env?.DATABASE_URL).toBeUndefined();
      expect(options.env?.ZHIPU_API_KEY).toBeUndefined();
      expect(options.env?.PYTHONPATH).toBeUndefined();
      expect(options.timeoutMs).toBe(config.timeoutMs);
      expect(options.maxOutputBytes).toBe(config.maxOutputBytes);
      return okay(report());
    });
    const executor=createDoclingLayoutCandidateExecutor(config,{artifactSha256:sha},runner);
    const result=await executor.inspect({pdfBytes:pdf,physicalPageIndex:7});
    expect(result.status).toBe("SUCCEEDED");
    if(result.status!=="SUCCEEDED")throw Error("EXPECT_CANDIDATE");
    expect(result.candidate).toMatchObject({
      authority:"NON_AUTHORITATIVE_LAYOUT_CANDIDATE",
      sourceMethod:"DOCLING_LAYOUT_CANDIDATE_ONLY",
      physicalPageIndex:7,ocrUsed:false,fullPageReference:false,
      parserVersion:"2.141.0",artifactSha256:sha,
      textItemCount:2,pictureItemCount:1,tableItemCount:1,
    });
    await expect(stat(tempPdf)).rejects.toMatchObject({code:"ENOENT"});
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it("rejects forged gold, OCR-on and extra response field",async()=>{
    for(const extra of [{goldApproved:true},{ocrUsed:true},{fullPageReference:true},
                         {markdown:23},{textItemCount:-1}]){
      const executor=createDoclingLayoutCandidateExecutor(config,{artifactSha256:sha},
        async()=>okay(report(extra)));
      await expect(executor.inspect({pdfBytes:pdf,physicalPageIndex:1}))
        .resolves.toEqual({status:"FAILED",reason:"REJECTED"});
    }
  });
  it("rejects multi-line JSON, impossible page index and unconfirmed kill",async()=>{
    const runner=vi.fn(async()=>okay("{}\n{}"));
    const executor=createDoclingLayoutCandidateExecutor(config,{artifactSha256:sha},runner);
    await expect(executor.inspect({pdfBytes:pdf,physicalPageIndex:0}))
      .resolves.toMatchObject({status:"FAILED"});
    await expect(executor.inspect({pdfBytes:pdf,physicalPageIndex:-1}))
      .resolves.toMatchObject({status:"FAILED"});
    expect(runner).toHaveBeenCalledTimes(1);
    const dead=createDoclingLayoutCandidateExecutor(config,{artifactSha256:sha},
      async()=>okay("",{code:null,aborted:true,treeTerminationConfirmed:false}));
    await expect(dead.inspect({pdfBytes:pdf,physicalPageIndex:0}))
      .resolves.toEqual({status:"FAILED",reason:"PROCESS_UNKNOWN"});
  });
  it("shutdown aborts active layout child and rejects post-close work",async()=>{
    let ready!:()=>void;
    const started=new Promise<void>(resolve=>{ready=resolve;});
    const runner=vi.fn(async (_cmd:string,_args:string[],opts:BoundedSpawnOptions)=>{
      ready();
      return new Promise<BoundedSpawnResult>(resolve=>{
        opts.abortSignal?.addEventListener("abort",()=>{
          resolve(okay("",{code:null,aborted:true,treeTerminationConfirmed:true}));
        },{once:true});
      });
    });
    const ex=createDoclingLayoutCandidateExecutor(config,{artifactSha256:sha},runner);
    const operation=ex.inspect({pdfBytes:pdf,physicalPageIndex:0});
    await started;
    await ex.close();
    await expect(operation).resolves.toEqual({status:"FAILED",reason:"CLOSING"});
    await expect(ex.inspect({pdfBytes:pdf,physicalPageIndex:0}))
      .resolves.toEqual({status:"FAILED",reason:"CLOSING"});
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it("late success after abort is rejected and cannot acquire authority",async()=>{
    let ready!:()=>void;
    const started=new Promise<void>(resolve=>{ready=resolve;});
    const runner=vi.fn(async (_cmd:string,_args:string[],opts:BoundedSpawnOptions)=>{
      ready();
      return new Promise<BoundedSpawnResult>(resolve=>{
        opts.abortSignal?.addEventListener("abort",()=>{
          resolve(okay(report()));
        },{once:true});
      });
    });
    const ex=createDoclingLayoutCandidateExecutor(config,{artifactSha256:sha},runner);
    const operation=ex.inspect({pdfBytes:pdf,physicalPageIndex:0});
    await started;
    await ex.close();
    await expect(operation).resolves.toEqual({status:"FAILED",reason:"REJECTED"});
  });
});
