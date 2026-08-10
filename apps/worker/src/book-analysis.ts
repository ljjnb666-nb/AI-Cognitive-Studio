import { Queue, Worker } from "bullmq";
import { DeterministicFakeEmbeddingProvider, RecordingFakeAnalysisProvider, BOOK_ANALYSIS_JOB, dispatchPendingBookAnalysis, processBookAnalysisRun } from "../../../packages/book-intelligence/src/index.js";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export const BOOK_ANALYSIS_QUEUE = "book.analysis";
export function createBookAnalysisWorker(environment: Environment) {
  const analysisProvider = new RecordingFakeAnalysisProvider(), embeddingProvider = new DeterministicFakeEmbeddingProvider();
  return new Worker<{ analysisRunId: string }>(BOOK_ANALYSIS_QUEUE, async (job) => processBookAnalysisRun(job.data.analysisRunId, { analysisProvider, embeddingProvider }), { connection: createRedisConnection(environment.REDIS_URL) });
}
export function createBookAnalysisQueue(environment: Environment) { return new Queue<{ analysisRunId: string }>(BOOK_ANALYSIS_QUEUE, { connection: createRedisConnection(environment.REDIS_URL) }); }
export async function dispatchBookAnalysis(environment: Environment): Promise<number> { const queue = createBookAnalysisQueue(environment); try { return await dispatchPendingBookAnalysis(queue); } finally { await queue.close(); } }
export { BOOK_ANALYSIS_JOB };
