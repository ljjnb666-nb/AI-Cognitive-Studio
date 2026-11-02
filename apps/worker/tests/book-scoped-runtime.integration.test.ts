import { expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { startWorkerRuntime } from "../src/runtime.js";
import { createBookAnalysisQueue } from "../src/book-analysis.js";
import { createBookAnalysisBootstrapQueue } from "../src/book-analysis-bootstrap.js";
it("rejects a scope sharing the ingestion queue namespace before starting workers", async () => {
  for (const prefix of ["", "bull", "shared"]) await expect(startWorkerRuntime(readEnvironment(), { ...(prefix === "shared" ? { bullmqPrefix: "shared" } : {}), bookScope: { prefix, bootstrapIds: async () => [], analysisIds: async () => [] } })).rejects.toThrow("BOOK_SCOPE_QUEUE_PREFIX_INVALID");
});
it("does not dispatch any peer Book intents when the authorized scope is empty", async () => {
  const suffix=crypto.randomUUID(), topic=`book-scope-test-${suffix}`, prefix=`scope-test-${suffix}`;
  const first=await prisma.outboxEvent.create({data:{topic:topic+"-bootstrap",aggregateId:crypto.randomUUID(),payload:{bootstrapId:crypto.randomUUID(),dispatchGeneration:0}}});
  const second=await prisma.outboxEvent.create({data:{topic:topic+"-analysis",aggregateId:crypto.randomUUID(),payload:{analysisRunId:crypto.randomUUID(),dispatchGeneration:0}}});
  let runtime: Awaited<ReturnType<typeof startWorkerRuntime>> | undefined;
  try {
    runtime=await startWorkerRuntime(readEnvironment(), { source:{...process.env,WORKER_EXECUTION_MODE:"FULL",BOOK_ANALYSIS_PROVIDER:"",PODCAST_GENERATION_PROVIDER:"",AUDIO_GENERATION_PROVIDER:"",SHORT_VIDEO_GENERATION_PROVIDER:"",PDF_VISUAL_REVIEW_ON_DEMAND_ENABLED:"false"}, bullmqPrefix:prefix, bookScope:{prefix:prefix+"-book",bootstrapIds:async()=>[],analysisIds:async()=>[]}, outboxTopics:{sourceIngestion:topic+"-ingestion",bookAnalysisBootstrap:topic+"-bootstrap",bookAnalysis:topic+"-analysis"}, bookDependencies:{analysisProviderForRun:async()=>{throw new Error("UNAUTHORIZED_EXECUTION");},embeddingGatewayForRun:async()=>{throw new Error("UNAUTHORIZED_EXECUTION");}} });
    await runtime.bookWorker!.waitUntilReady();
    expect((await prisma.outboxEvent.findUniqueOrThrow({where:{id:first.id}})).status).toBe("PENDING");
    expect((await prisma.outboxEvent.findUniqueOrThrow({where:{id:second.id}})).status).toBe("PENDING");
    expect(runtime.bookWorker!.opts.prefix).toBe(prefix+"-book");
    expect(runtime.ingestionWorker.opts.prefix).toBe(prefix);
    // Bypass the outbox dispatcher deliberately: the consumer must still reject
    // a foreign delivery before looking up or claiming a durable Book run.
    const analysisQueue = createBookAnalysisQueue(readEnvironment(), { prefix: prefix + "-book" });
    const bootstrapQueue = createBookAnalysisBootstrapQueue(readEnvironment(), { prefix: prefix + "-book" });
    try {
      const analysisDenied = new Promise<string>(resolve => runtime!.bookWorker!.once("failed", (_job, error) => resolve(error.message)));
      const bootstrapDenied = new Promise<string>(resolve => runtime!.bookBootstrapWorker!.once("failed", (_job, error) => resolve(error.message)));
      await analysisQueue.add("foreign", { analysisRunId: crypto.randomUUID() });
      await bootstrapQueue.add("foreign", { bootstrapId: crypto.randomUUID(), dispatchGeneration: 0 });
      expect(await analysisDenied).toBe("BOOK_SCOPE_DENIED");
      expect(await bootstrapDenied).toBe("BOOK_SCOPE_DENIED");
    } finally { await analysisQueue.close(); await bootstrapQueue.close(); }
  } finally { await runtime?.close(); await prisma.outboxEvent.deleteMany({where:{id:{in:[first.id,second.id]}}}); }
});
