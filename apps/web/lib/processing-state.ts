export type WorkerAvailability = "AVAILABLE" | "DEGRADED" | "UNKNOWN";
export type ProcessingWorkerAvailability = { ingestion: WorkerAvailability; bookAnalysis: WorkerAvailability; podcastGeneration: WorkerAvailability; podcastAudio: WorkerAvailability; shortVideoGeneration: WorkerAvailability };
export type ProcessingState = "NOT_STARTED" | "QUEUED_FOR_INGESTION" | "INGESTING" | "WAITING_FOR_ANALYSIS" | "ANALYSIS_QUEUED" | "ANALYZING" | "SUCCEEDED" | "INGESTION_FAILED" | "ANALYSIS_FAILED" | "PROCESSING_DEGRADED";
export type ProcessingStage = "INGESTION" | "BOOK_ANALYSIS" | "COMPLETE";
export type RecoveryAction = "NONE" | "RECHECK" | "RETRY_INGESTION" | "RETRY_ANALYSIS" | "REPAIR_CURRENT_INTELLIGENCE";
export type ProcessingStatus = { state: ProcessingState; stage: ProcessingStage; recoveryAction: RecoveryAction; stageAvailability: WorkerAvailability };

type Run = { status?: string | null; createdAt?: Date | null; startedAt?: Date | null; updatedAt?: Date | null; completedAt?: Date | null; executionLeaseUntil?: Date | null } | null | undefined;

/** Pure, server-derived product state.  A missing durable run is never queued. */
export function deriveProcessingStatus(input: { ingestion?: Run; analysis?: Run; hasIntelligence: boolean; workerAvailability: WorkerAvailability | ProcessingWorkerAvailability; now?: Date; staleAfterMs?: number }): ProcessingStatus {
  const availability = (capability: "ingestion" | "bookAnalysis") => typeof input.workerAvailability === "string" ? input.workerAvailability : input.workerAvailability[capability];
  const result = (state: ProcessingState, stage: ProcessingStage, recoveryAction: RecoveryAction): ProcessingStatus => ({ state, stage, recoveryAction, stageAvailability: stage === "COMPLETE" ? "AVAILABLE" : availability(stage === "INGESTION" ? "ingestion" : "bookAnalysis") });
  if (input.hasIntelligence) return result("SUCCEEDED", "COMPLETE", "NONE");
  const ingestion = input.ingestion;
  if (!ingestion) return result("NOT_STARTED", "INGESTION", "RETRY_INGESTION");
  if (ingestion.status === "FAILED" || ingestion.status === "REJECTED" || ingestion.status === "OCR_REQUIRED" || ingestion.status === "PASSWORD_REQUIRED") return result("INGESTION_FAILED", "INGESTION", "RETRY_INGESTION");
  if (ingestion.status === "RUNNING") {
    const age = (input.now ?? new Date()).getTime() - (ingestion.startedAt ?? ingestion.createdAt ?? new Date()).getTime();
    return age > (input.staleAfterMs ?? 120_000) && availability("ingestion") !== "AVAILABLE" ? result("PROCESSING_DEGRADED", "INGESTION", "RETRY_INGESTION") : result("INGESTING", "INGESTION", "RECHECK");
  }
  if (ingestion.status !== "SUCCEEDED") {
    const age = (input.now ?? new Date()).getTime() - (ingestion.updatedAt ?? ingestion.createdAt ?? new Date()).getTime();
    return age > (input.staleAfterMs ?? 120_000) && availability("ingestion") !== "AVAILABLE" ? result("PROCESSING_DEGRADED", "INGESTION", "RETRY_INGESTION") : result("QUEUED_FOR_INGESTION", "INGESTION", "RECHECK");
  }
  const analysis = input.analysis;
  if (!analysis) return result("WAITING_FOR_ANALYSIS", "BOOK_ANALYSIS", "RETRY_ANALYSIS");
  if (analysis.status === "SUCCEEDED") return result("PROCESSING_DEGRADED", "BOOK_ANALYSIS", "REPAIR_CURRENT_INTELLIGENCE");
  if (analysis.status === "FAILED") return result("ANALYSIS_FAILED", "BOOK_ANALYSIS", "RETRY_ANALYSIS");
  if (analysis.status === "RUNNING") {
    const age = (input.now ?? new Date()).getTime() - (analysis.startedAt ?? analysis.createdAt ?? new Date()).getTime();
    return age > (input.staleAfterMs ?? 120_000) && availability("bookAnalysis") !== "AVAILABLE" ? result("PROCESSING_DEGRADED", "BOOK_ANALYSIS", "RETRY_ANALYSIS") : result("ANALYZING", "BOOK_ANALYSIS", "RECHECK");
  }
  if (analysis.status === "QUEUED") {
    const age = (input.now ?? new Date()).getTime() - (analysis.startedAt ?? analysis.updatedAt ?? analysis.createdAt ?? new Date()).getTime();
    return age > (input.staleAfterMs ?? 120_000) && availability("bookAnalysis") !== "AVAILABLE" ? result("PROCESSING_DEGRADED", "BOOK_ANALYSIS", "RETRY_ANALYSIS") : result("ANALYSIS_QUEUED", "BOOK_ANALYSIS", "RECHECK");
  }
  return result("WAITING_FOR_ANALYSIS", "BOOK_ANALYSIS", "RETRY_ANALYSIS");
}

export function deriveProcessingState(input: Parameters<typeof deriveProcessingStatus>[0]): ProcessingState { return deriveProcessingStatus(input).state; }

export const processingCopy: Record<ProcessingState, string> = {
  NOT_STARTED: "文件已经上传，但尚未创建处理任务。", QUEUED_FOR_INGESTION: "正在等待解析", INGESTING: "正在提取正文和书籍结构", WAITING_FOR_ANALYSIS: "解析完成，准备进行 AI 深度理解", ANALYSIS_QUEUED: "正在等待 AI 深度理解", ANALYZING: "正在进行 AI 深度理解", SUCCEEDED: "处理完成", INGESTION_FAILED: "文件解析失败", ANALYSIS_FAILED: "AI 深度理解失败", PROCESSING_DEGRADED: "后台处理服务暂时没有响应。你的文件已经保存，可以稍后重试。",
};

export function processingWaitLabel(since: Date | null | undefined, now = new Date()): string | null {
  if (!since) return null;
  const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1_000));
  return seconds < 60 ? `已等待 ${seconds} 秒` : `已等待 ${Math.floor(seconds / 60)} 分钟`;
}
