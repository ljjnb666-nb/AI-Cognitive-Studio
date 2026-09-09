export type WorkerAvailability = "AVAILABLE" | "DEGRADED" | "UNKNOWN";
export type ProcessingState = "NOT_STARTED" | "QUEUED_FOR_INGESTION" | "INGESTING" | "WAITING_FOR_ANALYSIS" | "ANALYSIS_QUEUED" | "ANALYZING" | "SUCCEEDED" | "INGESTION_FAILED" | "ANALYSIS_FAILED" | "PROCESSING_DEGRADED";

type Run = { status?: string | null; createdAt?: Date | null; startedAt?: Date | null; updatedAt?: Date | null; completedAt?: Date | null; executionLeaseUntil?: Date | null } | null | undefined;

/** Pure, server-derived product state.  A missing durable run is never queued. */
export function deriveProcessingState(input: { ingestion?: Run; analysis?: Run; hasIntelligence: boolean; workerAvailability: WorkerAvailability; now?: Date; staleAfterMs?: number }): ProcessingState {
  if (input.hasIntelligence || input.analysis?.status === "SUCCEEDED") return "SUCCEEDED";
  const ingestion = input.ingestion;
  if (!ingestion) return "NOT_STARTED";
  if (ingestion.status === "FAILED" || ingestion.status === "REJECTED" || ingestion.status === "OCR_REQUIRED" || ingestion.status === "PASSWORD_REQUIRED") return "INGESTION_FAILED";
  if (ingestion.status === "RUNNING") {
    const age = (input.now ?? new Date()).getTime() - (ingestion.startedAt ?? ingestion.createdAt ?? new Date()).getTime();
    return age > (input.staleAfterMs ?? 120_000) && input.workerAvailability !== "AVAILABLE" ? "PROCESSING_DEGRADED" : "INGESTING";
  }
  if (ingestion.status !== "SUCCEEDED") {
    const age = (input.now ?? new Date()).getTime() - (ingestion.updatedAt ?? ingestion.createdAt ?? new Date()).getTime();
    return age > (input.staleAfterMs ?? 120_000) && input.workerAvailability !== "AVAILABLE" ? "PROCESSING_DEGRADED" : "QUEUED_FOR_INGESTION";
  }
  const analysis = input.analysis;
  if (!analysis) return "WAITING_FOR_ANALYSIS";
  if (analysis.status === "FAILED") return "ANALYSIS_FAILED";
  if (analysis.status === "RUNNING") {
    const age = (input.now ?? new Date()).getTime() - (analysis.startedAt ?? analysis.createdAt ?? new Date()).getTime();
    return age > (input.staleAfterMs ?? 120_000) && input.workerAvailability !== "AVAILABLE" ? "PROCESSING_DEGRADED" : "ANALYZING";
  }
  if (analysis.status === "QUEUED") {
    const age = (input.now ?? new Date()).getTime() - (analysis.updatedAt ?? analysis.createdAt ?? new Date()).getTime();
    return age > (input.staleAfterMs ?? 120_000) && input.workerAvailability !== "AVAILABLE" ? "PROCESSING_DEGRADED" : "ANALYSIS_QUEUED";
  }
  return "WAITING_FOR_ANALYSIS";
}

export const processingCopy: Record<ProcessingState, string> = {
  NOT_STARTED: "文件已经上传，但尚未创建处理任务。", QUEUED_FOR_INGESTION: "正在等待解析", INGESTING: "正在提取正文和书籍结构", WAITING_FOR_ANALYSIS: "解析完成，准备进行 AI 深度理解", ANALYSIS_QUEUED: "正在等待 AI 深度理解", ANALYZING: "正在进行 AI 深度理解", SUCCEEDED: "处理完成", INGESTION_FAILED: "文件解析失败", ANALYSIS_FAILED: "AI 深度理解失败", PROCESSING_DEGRADED: "后台处理服务暂时没有响应。你的文件已经保存，可以稍后重试。",
};

export function processingWaitLabel(since: Date | null | undefined, now = new Date()): string | null {
  if (!since) return null;
  const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1_000));
  return seconds < 60 ? `已等待 ${seconds} 秒` : `已等待 ${Math.floor(seconds / 60)} 分钟`;
}
