import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import { createRedisConnection } from "@ai-cognitive/shared/server";
import type { Environment } from "@ai-cognitive/shared/server";
import { createSourceIngestionWorker } from "../src/source-ingestion.js";
import { createBookAnalysisWorker } from "../src/book-analysis.js";
import { createPodcastGenerationWorker } from "../src/podcast-generation.js";
import { createPodcastAudioWorker } from "../src/audio-generation.js";
import { createShortVideoGenerationWorker } from "../src/short-video-generation.js";

const resources: Array<{ queue: Queue; events: QueueEvents; worker: Worker }> = [];
afterEach(async () => { await Promise.all(resources.splice(0).flatMap(resource => [resource.worker.close(), resource.events.close(), resource.queue.close()])); });

async function observeConcurrency(concurrency: number) {
  const name = `phase16-concurrency-${randomUUID()}`, connection = createRedisConnection(process.env.REDIS_URL!);
  let inFlight = 0, maxInFlight = 0, signalStarted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const worker = new Worker(name, async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); if (inFlight === concurrency) signalStarted(); await gate; inFlight--; }, { connection, concurrency });
  const queue = new Queue(name, { connection: createRedisConnection(process.env.REDIS_URL!) }), events = new QueueEvents(name, { connection: createRedisConnection(process.env.REDIS_URL!) }); resources.push({ queue, events, worker }); await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
  const jobs = await Promise.all(Array.from({ length: concurrency + 1 }, (_, index) => queue.add("phase16", { index }, { jobId: `job-${index}` })));
  await started; const observed = maxInFlight; release(); await Promise.all(jobs.map(job => job.waitUntilFinished(events, 15_000))); return observed;
}

describe("Phase 16 deterministic BullMQ worker concurrency", () => {
  it("wires every repository worker factory to the configured bounded concurrency", async () => { const environment = { REDIS_URL: process.env.REDIS_URL!, S3_ENDPOINT: "http://127.0.0.1:9000", S3_REGION: "us-east-1", S3_BUCKET: "ai-cognitive-studio-dev", S3_ACCESS_KEY: "key", S3_SECRET_KEY: "secret", S3_FORCE_PATH_STYLE: true, SOURCE_MAX_UPLOAD_BYTES: 1, SOURCE_UPLOAD_URL_TTL_SECONDS: 1, SOURCE_MAX_PDF_PAGES: 1, SOURCE_UPLOAD_COMPLETION_LEASE_MS: 1, WORKER_INGESTION_CONCURRENCY: 3, WORKER_BOOK_ANALYSIS_CONCURRENCY: 3, WORKER_PODCAST_GENERATION_CONCURRENCY: 3, WORKER_AUDIO_CONCURRENCY: 3, WORKER_SHORT_VIDEO_CONCURRENCY: 3 } as Environment; const workers = [createSourceIngestionWorker(environment), createBookAnalysisWorker(environment, { analysisProvider: {}, embeddingGateway: {} } as never), createPodcastGenerationWorker(environment, { provider: {}, embeddingProvider: {} } as never), createPodcastAudioWorker(environment, { provider: {} } as never), createShortVideoGenerationWorker(environment, { provider: {}, embeddingProvider: {}, tts: {} } as never)]; try { expect(workers.map(worker => worker.opts.concurrency)).toEqual([3, 3, 3, 3, 3]); } finally { await Promise.all(workers.map(worker => worker.close())); } });
  it("holds actual in-flight work to one at concurrency=1", async () => { expect(await observeConcurrency(1)).toBe(1); });
  it("allows bounded parallel work at concurrency=3", async () => { const max = await observeConcurrency(3); expect(max).toBeGreaterThan(1); expect(max).toBeLessThanOrEqual(3); });
});
