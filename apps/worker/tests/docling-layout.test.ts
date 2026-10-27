import { describe, expect, it } from "vitest";
import { readEnvironment, type Environment } from "@ai-cognitive/shared/server";
import {
  DOCLING_LAYOUT_QUEUE,
  doclingLayoutJobId,
  resolveDoclingBackgroundExecutor,
} from "../src/docling-layout.js";
import { withDoclingClaimHeartbeat, type DoclingTaskClaim } from "../src/docling-task-ledger.js";
import { DoclingOwnedStorageRegistry } from "../src/docling-owned-storage.js";

describe("isolated Docling layout background admission",()=>{
  it("is off by default and does not require a Docling installation",async()=>{
    const env=readEnvironment({
      DATABASE_URL:"postgresql://local:local@localhost:5432/testing",
      REDIS_URL:"redis://localhost:6379",
    });
    expect(env.DOCLING_LAYOUT_ENABLED).toBe(false);
    await expect(resolveDoclingBackgroundExecutor(env)).resolves.toBeNull();
  });

  it("requires an explicit opt-in; orphan model paths are rejected",async()=>{
    const env={
      DOCLING_LAYOUT_ENABLED:false,
      DOCLING_LAYOUT_PYTHON_PATH:"/synthetic/python",
      DOCLING_LAYOUT_ARTIFACTS_PATH:"/synthetic/assets",
    } as Environment;
    await expect(resolveDoclingBackgroundExecutor(env))
      .rejects.toThrow("DOCLING_LAYOUT_DISABLED_WITH_CONFIG");
  });

  it("enabled but unavailable local runtime fails before queue construction",async()=>{
    const env={
      DOCLING_LAYOUT_ENABLED:true,
      DOCLING_LAYOUT_PYTHON_PATH:"/this/path/does/not/exist",
      DOCLING_LAYOUT_ARTIFACTS_PATH:"/models/not/available",
    } as Environment;
    await expect(resolveDoclingBackgroundExecutor(env))
      .rejects.toThrow("DOCLING_LAYOUT_PYTHON_UNAVAILABLE");
  });

  it("stable queue/job IDs use run, physical page and verified model only",()=>{
    const sha="a".repeat(64);
    const input={ingestionRunId:"run-A_123",physicalPageIndex:7,modelSha256:sha};
    expect(DOCLING_LAYOUT_QUEUE).toBe("source.docling-layout-candidate.v1");
    expect(doclingLayoutJobId(input)).toBe("run-A_123-7-"+sha);
    expect(doclingLayoutJobId(input)).toBe(doclingLayoutJobId({...input}));
    expect(doclingLayoutJobId({...input,physicalPageIndex:8})).not.toEqual(doclingLayoutJobId(input));
    expect(()=>doclingLayoutJobId({...input,ingestionRunId:"run:unsafe"}))
      .toThrow("DOCLING_LAYOUT_JOB_IDENTITY_INVALID");
    expect(()=>doclingLayoutJobId({...input,physicalPageIndex:-1}))
      .toThrow("DOCLING_LAYOUT_JOB_IDENTITY_INVALID");
    expect(()=>doclingLayoutJobId({...input,modelSha256:"spoofed"}))
      .toThrow("DOCLING_LAYOUT_JOB_IDENTITY_INVALID");
  });
});


describe("Docling lease heartbeat and safe stop",()=>{
  const claim:DoclingTaskClaim={id:"synthetic-task",token:"synthetic-owner",attempt:1};
  it("rejects invalid tick intervals without touching a task",async()=>{
    await expect(withDoclingClaimHeartbeat(claim,async()=>42,{intervalMs:0}))
      .rejects.toThrow("DOCLING_LAYOUT_HEARTBEAT_INTERVAL_INVALID");
  });

  it("extends while running, then drains and permits a successful result",async()=>{
    let renewed!:()=>void;
    const signal=new Promise<void>(resolve=>{renewed=resolve;});
    let renewals=0;
    const renew=async()=>{
      renewals++;
      renewed();
      return true;
    };
    const result=await withDoclingClaimHeartbeat(claim,async()=>{
      await signal;
      return "CANDIDATE_ONLY";
    },{intervalMs:5,renew});
    expect(result).toBe("CANDIDATE_ONLY");
    const completed=renewals;
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(renewals).toBe(completed);
  });

  it("an explicit lost lease fences returned work even if the model already completed",async()=>{
    let tick!:()=>void;
    const attempted=new Promise<void>(resolve=>{tick=resolve;});
    let renewed=0;
    const renew=async()=>{
      renewed++;
      tick();
      return false;
    };
    await expect(withDoclingClaimHeartbeat(claim,async()=>{
      await attempted;
      return "MUST_NEVER_BE_SUCCESS";
    },{intervalMs:5,renew})).rejects.toThrow("DOCLING_LAYOUT_HEARTBEAT_LOST");
    expect(renewed).toBe(1);
  });

  it("a transport error during renew also fences successful model output",async()=>{
    let invoked!:()=>void;
    const attempted=new Promise<void>(resolve=>{invoked=resolve;});
    await expect(withDoclingClaimHeartbeat(claim,async()=>{
      await attempted;
      return "UNVERIFIED";
    },{intervalMs:5,renew:async()=>{
      invoked();
      throw new Error("SYNTHETIC_DATABASE_OUTAGE");
    }})).rejects.toThrow("DOCLING_LAYOUT_HEARTBEAT_LOST");
  });

  it("operation failure survives heartbeat cleanup and is not replaced",async()=>{
    await expect(withDoclingClaimHeartbeat(claim,async()=>{
      throw new Error("MODEL_FAILED");
    },{intervalMs:5,renew:async()=>true})).rejects.toThrow("MODEL_FAILED");
  });

  it("waits for an already running renewal before accepting output",async()=>{
    let began!:()=>void;
    let finish!:()=>void;
    const started=new Promise<void>(resolve=>{began=resolve;});
    const resumed=new Promise<void>(resolve=>{finish=resolve;});
    const result=withDoclingClaimHeartbeat(claim,async()=>{
      await started;
      return "LATE_RESULT";
    },{intervalMs:5,renew:async()=>{
      began();
      await resumed;
      return false;
    }});
    await started;
    finish();
    await expect(result).rejects.toThrow("DOCLING_LAYOUT_HEARTBEAT_LOST");
  });
  it("lease heartbeat loss aborts the model operation and never returns late success",async()=>{
    const controller=new AbortController();
    let aborted=false;
    const work=withDoclingClaimHeartbeat(claim,async()=>{
      await new Promise<void>(resolve=>{
        controller.signal.addEventListener("abort",()=>{aborted=true;resolve();},{once:true});
      });
      return "FORBIDDEN_LATE_SUCCESS";
    },{intervalMs:5,renew:async()=>false,onLost:()=>controller.abort()});
    await expect(work).rejects.toThrow("DOCLING_LAYOUT_HEARTBEAT_LOST");
    expect(aborted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

});

describe("Docling worker-owned S3 lifecycle",()=>{
  it("closes only owned resources exactly once, without touching shared storage",()=>{
    const registry=new DoclingOwnedStorageRegistry();
    const workerA={},workerB={},sharedWorker={};
    let countA=0,countB=0,countShared=0;
    registry.attach(workerA,{close:()=>{countA++;}});
    registry.attach(workerB,{close:()=>{countB++;}});
    const sharedStorage={close:()=>{countShared++;}};
    expect(sharedStorage).toBeDefined();
    expect(registry.close(sharedWorker)).toBe(false);
    expect(registry.close(workerA)).toBe(true);
    expect(registry.close(workerA)).toBe(false);
    expect(countA).toBe(1);
    expect(countB).toBe(0);
    expect(countShared).toBe(0);
    expect(registry.close(workerB)).toBe(true);
    expect(countB).toBe(1);
  });
  it("rejects duplicate ownership, propagates dispose failure and never double closes",()=>{
    const registry=new DoclingOwnedStorageRegistry(),worker={};
    let count=0;
    registry.attach(worker,{close:()=>{count++;throw new Error("SYNTHETIC_CLOSE_FAILED");}});
    expect(()=>registry.attach(worker,{close:()=>{}})).toThrow("DOCLING_OWNED_STORAGE_ALREADY_ATTACHED");
    expect(()=>registry.close(worker)).toThrow("SYNTHETIC_CLOSE_FAILED");
    expect(registry.close(worker)).toBe(false);
    expect(count).toBe(1);
  });
});
