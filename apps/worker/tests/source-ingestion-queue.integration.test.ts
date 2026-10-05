import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Queue, Worker } from "bullmq";
import { prisma } from "@ai-cognitive/db";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { createSourceIngestionQueue, createSourceIngestionWorker } from "../src/source-ingestion.js";
import { createBookAnalysisBootstrapQueue } from "../src/book-analysis-bootstrap.js";
import { INGESTION_JOB } from "../src/source-ingestion.js";

const environment = { ...readEnvironment(process.env), SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS: 3, WORKER_INGESTION_CONCURRENCY: 1 };
const prefix = `test-04b1-srcq-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
const createdJobs: Array<{ queue: Queue; jobId: string }> = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const { queue, jobId } of createdJobs.splice(0)) await queue.getJob(jobId)?.then(job => job?.remove().catch(() => undefined));
});

afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  await prisma.$disconnect();
});

const track = <T extends { close(): Promise<void> }>(closable: T): T => { closers.push(() => closable.close()); return closable; };

describe("source-ingestion queue execution attempts (real Redis, ACTUAL createSourceIngestionQueue)", () => {
  it("SOURCE_QUEUE_ACTUAL_ATTEMPTS_3 + SOURCE_QUEUE_NO_FOURTH_EXECUTION: configured max=3 yields exactly 3 executions and no fourth", async () => {
    const queue = track(createSourceIngestionQueue(environment, { prefix }));
    expect((queue.opts as { defaultJobOptions?: { attempts?: number } }).defaultJobOptions?.attempts).toBe(3);
    const executions: number[] = [];
    track(createSourceIngestionWorker(environment, { prefix, concurrency: 1 }));
    const missingId = `missing-run-${crypto.randomUUID()}`;
    await queue.add(INGESTION_JOB, { ingestionRunId: missingId }, { jobId: missingId });
    let jobId = missingId;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const job = await queue.getJob(missingId);
      if (job && await job.getState() === "failed") { jobId = missingId; break; }
    }
    const failedJob = await queue.getJob(jobId);
    expect(failedJob).not.toBeNull();
    // Exactly the three configured attempts were delivered to the processor.
    const attemptCount = (failedJob as unknown as { attemptsStarted?: number }).attemptsStarted ?? (failedJob as unknown as { attemptsMade?: number }).attemptsMade;
    expect(attemptCount).toBe(3);
    expect(failedJob!.failedReason).toBeTruthy();
    // No fourth execution appears after settle.
    executions.push(Date.now());
    await new Promise((r) => setTimeout(r, 3000));
    const settled = await queue.getJob(jobId);
    const settledCount = (settled as unknown as { attemptsStarted?: number }).attemptsStarted ?? (settled as unknown as { attemptsMade?: number }).attemptsMade;
    expect(settledCount).toBe(3);
  }, 120_000);

  it("an unrelated queue keeps its own defaults (OUTBOX_ATTEMPTS_NOT_EXECUTION_ATTEMPTS)", async () => {
    const unrelated = track(createBookAnalysisBootstrapQueue(environment, { prefix: `${prefix}-bootstrap` }));
    expect((unrelated.opts as { defaultJobOptions?: { attempts?: number } }).defaultJobOptions?.attempts).toBeUndefined();
    const plain = track(new Queue(`${prefix}-plain`, { connection: { host: new URL(environment.REDIS_URL).hostname, port: Number(new URL(environment.REDIS_URL).port || 6379) } }));
    expect((plain.opts as { defaultJobOptions?: { attempts?: number } }).defaultJobOptions).toBeUndefined();
    const executions: number[] = [];
    track(new Worker(`${prefix}-plain`, async () => { executions.push(Date.now()); throw new Error("SCRATCH_FAIL"); }, { connection: { host: new URL(environment.REDIS_URL).hostname, port: Number(new URL(environment.REDIS_URL).port || 6379) } }));
    const job = await plain.add("fail-once", {});
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await job.getState() === "failed") break;
    }
    await new Promise((r) => setTimeout(r, 1500));
    // Processor-side count is the authority: no queue defaultJobOptions -> exactly one execution.
    expect(executions.length).toBe(1);
  }, 60_000);
});
