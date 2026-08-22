import { Queue, Worker } from "bullmq";
import { BOOK_ANALYSIS_JOB, dispatchPendingBookAnalysis, processBookAnalysisRun, type ProcessBookAnalysisDependencies } from "../../../packages/book-intelligence/src/index.js";
import { createRedisConnection, type Environment } from "@ai-cognitive/shared/server";

export const BOOK_ANALYSIS_QUEUE = "book.analysis";
export type BookAnalysisQueueOptions = { prefix?: string };
export function createBookAnalysisWorker(environment: Environment, dependencies?: Pick<ProcessBookAnalysisDependencies, "analysisProvider" | "embeddingProvider" | "embeddingGateway">, options: BookAnalysisQueueOptions = {}) {
  if (!dependencies) throw new Error("BOOK_ANALYSIS_PROVIDER_NOT_CONFIGURED"); const { analysisProvider, embeddingProvider, embeddingGateway } = dependencies;
  if (!embeddingGateway) throw new Error("BOOK_ANALYSIS_EMBEDDING_GATEWAY_NOT_CONFIGURED");
  return new Worker<{ analysisRunId: string }>(BOOK_ANALYSIS_QUEUE, async (job) => processBookAnalysisRun(job.data.analysisRunId, { analysisProvider, embeddingProvider, embeddingGateway }), { connection: createRedisConnection(environment.REDIS_URL), ...(options.prefix ? { prefix: options.prefix } : {}) });
}
export function createBookAnalysisQueue(environment: Environment, options: BookAnalysisQueueOptions = {}) { return new Queue<{ analysisRunId: string }>(BOOK_ANALYSIS_QUEUE, { connection: createRedisConnection(environment.REDIS_URL), ...(options.prefix ? { prefix: options.prefix } : {}) }); }
export function dispatchBookAnalysisWithQueue(queue: Queue<{ analysisRunId: string }>, options?: Parameters<typeof dispatchPendingBookAnalysis>[1]): Promise<number> { return dispatchPendingBookAnalysis(queue, options); }
export async function dispatchBookAnalysis(environment: Environment): Promise<number> { const queue = createBookAnalysisQueue(environment); try { return await dispatchBookAnalysisWithQueue(queue); } finally { await queue.close(); } }
export { BOOK_ANALYSIS_JOB };
