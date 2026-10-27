import { describe, expect, it, vi } from "vitest";
import { createManagedPdfVisualReviewRuntime } from "../src/pdf-visual-review.js";

describe("on-demand visual Worker resource lifecycle",()=>{
  it("drains an admitted operation before releasing storage / gateway",async()=>{
    let resolveTask!: (value:string)=>void;
    const taskGate=new Promise<string>(resolve=>{resolveTask=resolve;});
    const run=vi.fn(async(_task:string)=>taskGate);
    const release=vi.fn(async()=>undefined);
    const runtime=createManagedPdfVisualReviewRuntime(run,release);

    const accepted=runtime.execute("first");
    const closing=runtime.close();
    await expect(runtime.execute("after-close")).rejects.toThrow("PDF_VISUAL_WORKER_CLOSING");
    expect(release).not.toHaveBeenCalled();
    resolveTask("reviewed");
    await expect(accepted).resolves.toBe("reviewed");
    await closing;
    expect(run).toHaveBeenCalledExactlyOnceWith("first");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("admits one PDF at a time to bound process memory and recovers capacity",async()=>{
    let releaseFirst!: (value:string)=>void;
    const first=new Promise<string>(resolve=>{releaseFirst=resolve;});
    const run=vi.fn((value:string)=>value==="first"?first:Promise.resolve("second-ok"));
    const release=vi.fn(async()=>undefined);
    const runtime=createManagedPdfVisualReviewRuntime(run,release);
    const accepted=runtime.execute("first");
    await expect(runtime.execute("concurrent")).rejects.toThrow("PDF_VISUAL_WORKER_BUSY");
    releaseFirst("first-ok");
    await expect(accepted).resolves.toBe("first-ok");
    await expect(runtime.execute("second")).resolves.toBe("second-ok");
    await runtime.close();
    expect(run).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it("drains failed jobs and releases clients once; late requests fail closed",async()=>{
    let rejectTask!: (reason:Error)=>void;
    const failure=new Promise<string>((_,reject)=>{rejectTask=reject;});
    const run=vi.fn(async()=>failure);
    const release=vi.fn(async()=>undefined);
    const runtime=createManagedPdfVisualReviewRuntime(run,release);
    const attempt=runtime.execute("source");
    const a=runtime.close();
    const b=runtime.close();
    expect(a).toBe(b);
    rejectTask(Error("PDF_VISUAL_WORKER_SOURCE_SHA_MISMATCH"));
    await expect(attempt).rejects.toThrow("PDF_VISUAL_WORKER_SOURCE_SHA_MISMATCH");
    await a;
    expect(release).toHaveBeenCalledTimes(1);
    await expect(runtime.execute("late")).rejects.toThrow("PDF_VISUAL_WORKER_CLOSING");
  });

  it("propagates cleanup errors and never attempts cleanup twice",async()=>{
    const release=vi.fn(async()=>{throw Error("CLOSE_FAILED");});
    const runtime=createManagedPdfVisualReviewRuntime(async()=>undefined,release);
    await expect(runtime.close()).rejects.toThrow("CLOSE_FAILED");
    await expect(runtime.close()).rejects.toThrow("CLOSE_FAILED");
    expect(release).toHaveBeenCalledTimes(1);
    await expect(runtime.execute("late")).rejects.toThrow("PDF_VISUAL_WORKER_CLOSING");
  });
});
