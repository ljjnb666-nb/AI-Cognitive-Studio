import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";
import { BOOK_ANALYSIS_QUEUE, createBookAnalysisWorker } from "../src/book-analysis.js";
import { PODCAST_GENERATION_QUEUE, createPodcastGenerationWorker } from "../src/podcast-generation.js";
import { SHORT_VIDEO_GENERATION_QUEUE, createShortVideoGenerationWorker } from "../src/short-video-generation.js";

const processors = vi.hoisted(() => ({
  book: vi.fn().mockResolvedValue(undefined),
  podcast: vi.fn().mockResolvedValue(undefined),
  shortVideo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../packages/book-intelligence/src/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../packages/book-intelligence/src/index.js")>(),
  processBookAnalysisRun: processors.book,
}));
vi.mock("@ai-cognitive/podcast-generation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@ai-cognitive/podcast-generation")>(),
  processPodcastGenerationRun: processors.podcast,
}));
vi.mock("@ai-cognitive/short-video-generation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@ai-cognitive/short-video-generation")>(),
  processShortVideoGenerationRun: processors.shortVideo,
}));

const resources: Array<{ queue: Queue; events: QueueEvents; worker: Worker }> = [];
afterEach(async () => { await Promise.all(resources.splice(0).flatMap(({ queue, events, worker }) => [worker.close(), events.close(), queue.obliterate({ force: true }), queue.close()])); vi.clearAllMocks(); });

const environment = { REDIS_URL: process.env.REDIS_URL!, S3_ENDPOINT: "http://localhost:9000", S3_REGION: "us-east-1", S3_BUCKET: "ai-cognitive-studio-dev", S3_ACCESS_KEY: "local-development-only", S3_SECRET_KEY: "local-development-only", S3_FORCE_PATH_STYLE: true, WORKER_BOOK_ANALYSIS_CONCURRENCY: 1, WORKER_PODCAST_GENERATION_CONCURRENCY: 1, WORKER_SHORT_VIDEO_GENERATION_CONCURRENCY: 1 } as unknown as Environment;
const invalid = [null, "0", true, false, -1, 0.5, {}, [], Number.NaN, Infinity, -Infinity];

async function exercise(name: string, field: string, processor: typeof processors.book, create: (prefix: string, counters: { provider: number; embedding: number; tts: number }) => Worker, id: string) {
  const prefix = `a2-boundary-${randomUUID()}`, counters = { provider: 0, embedding: 0, tts: 0 }, worker = create(prefix, counters), queue = new Queue(name, { connection: createRedisConnection(process.env.REDIS_URL!), prefix }), events = new QueueEvents(name, { connection: createRedisConnection(process.env.REDIS_URL!), prefix });
  resources.push({ worker, queue, events });
  await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
  for (const payload of [{ [field]: id }, { [field]: id, dispatchGeneration: 0 }, { [field]: id, dispatchGeneration: 1 }, { [field]: id, dispatchGeneration: Number.MAX_SAFE_INTEGER }]) {
    const job = await queue.add("a2-boundary", payload, { jobId: randomUUID() });
    await expect(job.waitUntilFinished(events, 10_000)).resolves.toBeNull();
  }
  expect(processor.mock.calls.map((call) => call[2])).toEqual([0, 0, 1, Number.MAX_SAFE_INTEGER]);
  const beforeInvalid = await Promise.all([prisma.bookAnalysisRun.count(), prisma.podcastGenerationRun.count(), prisma.shortVideoGenerationRun.count(), prisma.job.count(), prisma.providerInvocation.count()]);
  const processorCallsBeforeInvalid = processor.mock.calls.length;
  for (const dispatchGeneration of invalid) {
    const job = await queue.add("a2-boundary", { [field]: id, dispatchGeneration }, { jobId: randomUUID() });
    await expect(job.waitUntilFinished(events, 10_000)).resolves.toBeNull();
  }
  expect(processor).toHaveBeenCalledTimes(processorCallsBeforeInvalid);
  expect(counters).toEqual({ provider: 0, embedding: 0, tts: 0 });
  expect(await Promise.all([prisma.bookAnalysisRun.count(), prisma.podcastGenerationRun.count(), prisma.shortVideoGenerationRun.count(), prisma.job.count(), prisma.providerInvocation.count()])).toEqual(beforeInvalid);
}

describe("A2 worker dispatch-generation transport boundary", () => {
  it("Book accepts legacy and valid transport generations while invalid jobs receive zero authority", async () => exercise(BOOK_ANALYSIS_QUEUE, "analysisRunId", processors.book, (prefix, counters) => createBookAnalysisWorker(environment, { analysisProviderForRun: async () => { counters.provider++; throw new Error("UNEXPECTED_PROVIDER"); }, embeddingGatewayForRun: () => { counters.embedding++; throw new Error("UNEXPECTED_EMBEDDING"); } } as never, { prefix }), randomUUID()));
  it("Podcast accepts legacy and valid transport generations while invalid jobs receive zero authority", async () => exercise(PODCAST_GENERATION_QUEUE, "podcastGenerationRunId", processors.podcast, (prefix, counters) => createPodcastGenerationWorker(environment, { providerForRun: async () => { counters.provider++; throw new Error("UNEXPECTED_PROVIDER"); }, embeddingProviderForRun: async () => { counters.embedding++; throw new Error("UNEXPECTED_EMBEDDING"); } } as never, { prefix }), randomUUID()));
  it("Short Video accepts legacy and valid transport generations while invalid jobs receive zero authority", async () => exercise(SHORT_VIDEO_GENERATION_QUEUE, "shortVideoGenerationRunId", processors.shortVideo, (prefix, counters) => createShortVideoGenerationWorker(environment, { providerForRun: async () => { counters.provider++; throw new Error("UNEXPECTED_PROVIDER"); }, embeddingProviderForRun: async () => { counters.embedding++; throw new Error("UNEXPECTED_EMBEDDING"); }, ttsForRun: async () => { counters.tts++; throw new Error("UNEXPECTED_TTS"); } } as never, { prefix }), randomUUID()));
});
