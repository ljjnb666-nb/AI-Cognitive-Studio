export type WorkerAvailability = "AVAILABLE" | "DEGRADED" | "UNKNOWN";
export type ProcessingWorkerAvailability = { ingestion: WorkerAvailability; bookAnalysis: WorkerAvailability; podcastGeneration: WorkerAvailability; podcastAudio: WorkerAvailability; shortVideoGeneration: WorkerAvailability };
export type ProcessingState = "NOT_STARTED" | "QUEUED_FOR_INGESTION" | "INGESTING" | "WAITING_FOR_ANALYSIS" | "ANALYSIS_QUEUED" | "ANALYZING" | "WAITING_FOR_PROVIDER" | "BOOTSTRAP_FAILED" | "BOOTSTRAP_SUCCEEDED" | "SUCCEEDED" | "INGESTION_FAILED" | "ANALYSIS_FAILED" | "PROCESSING_DEGRADED";
export type ProcessingStage = "INGESTION" | "BOOK_ANALYSIS" | "COMPLETE";
export type RecoveryAction = "NONE" | "RECHECK" | "RETRY_INGESTION" | "RETRY_ANALYSIS" | "REPAIR_CURRENT_INTELLIGENCE";
export type ProcessingStatus = { failureReason?: string; state: ProcessingState; stage: ProcessingStage; recoveryAction: RecoveryAction; stageAvailability: WorkerAvailability };

type Run = { routingPlan?: unknown; routingOutcome?: unknown; errorCode?: string | null; status?: string | null; createdAt?: Date | null; startedAt?: Date | null; updatedAt?: Date | null; completedAt?: Date | null; executionLeaseUntil?: Date | null; executionClaimedAt?: Date | null; job?: { startedAt?: Date | null; createdAt?: Date | null } | null } | null | undefined;

/** One projection for list, detail and polling API; historical ingestion errors cannot mask analysis. */
export function sourceProcessingSnapshot(input: Parameters<typeof deriveProcessingStatus>[0]) {
  const processing = deriveProcessingStatus(input);
  if (processing.state === "INGESTION_FAILED" && input.ingestion?.errorCode === "SOURCE_QUALITY_REJECTED") {
    const plan = input.ingestion.routingPlan as { schemaVersion?: string; pages?: Array<{ route?: string; physicalPageIndex?: number }> } | null;
    const outcome = input.ingestion.routingOutcome as { schemaVersion?: string; unresolvedPhysicalPageIndexes?: unknown[] } | null;
    if (plan?.schemaVersion === "pdf-routing-plan-v1" && outcome?.schemaVersion === "pdf-routing-outcome-v1" && Array.isArray(plan.pages) && Array.isArray(outcome.unresolvedPhysicalPageIndexes)) {
      const unresolved = new Set(outcome.unresolvedPhysicalPageIndexes.filter((value): value is number => Number.isInteger(value)));
      const count = plan.pages.filter(page => page.route === "OCR_REQUIRED" && unresolved.has(page.physicalPageIndex!)).length;
      if (count > 0) processing.failureReason = `这份 PDF 有 ${count} 页需要 OCR 识别，目前这些页面尚未获得可用正文，因此未通过质量检查。请使用可用的 OCR 服务完成识别，或导入带文字层的 PDF；重复直接提取无法读取扫描图片中的文字。`;
    }
  }
  const run = processing.stage === "INGESTION" ? input.ingestion : input.analysis ?? input.bootstrap;
  const statusError = run?.status === "PASSWORD_REQUIRED" || run?.status === "OCR_REQUIRED" ? run.status : null;
  const since = processing.stage === "BOOK_ANALYSIS" && input.analysis
    ? processing.state === "ANALYSIS_QUEUED" ? run?.job?.createdAt ?? run?.createdAt : run?.executionClaimedAt ?? run?.job?.startedAt ?? run?.startedAt ?? run?.job?.createdAt ?? run?.createdAt
    : run?.startedAt ?? run?.createdAt;
  return { processing, errorCode: processing.stage === "COMPLETE" ? null : run?.errorCode ?? statusError, processingSince: since?.toISOString() ?? null };
}

/** Pure, server-derived product state.  A missing durable run is never queued. */
export function deriveProcessingStatus(input: { ingestion?: Run; analysis?: Run; bootstrap?: Run; hasIntelligence: boolean; workerAvailability: WorkerAvailability | ProcessingWorkerAvailability; now?: Date; staleAfterMs?: number }): ProcessingStatus {
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
  const bootstrap = input.bootstrap;
  if (!analysis && bootstrap?.status === "WAITING_FOR_PROVIDER") return result("WAITING_FOR_PROVIDER", "BOOK_ANALYSIS", "RECHECK");
  if (!analysis && bootstrap?.status === "FAILED_TERMINAL") return result("BOOTSTRAP_FAILED", "BOOK_ANALYSIS", "RETRY_ANALYSIS");
  if (!analysis && bootstrap?.status === "SUCCEEDED") return result("BOOTSTRAP_SUCCEEDED", "BOOK_ANALYSIS", "REPAIR_CURRENT_INTELLIGENCE");
  if (!analysis && (bootstrap?.status === "PENDING" || bootstrap?.status === "RUNNING")) return result("ANALYSIS_QUEUED", "BOOK_ANALYSIS", "RECHECK");
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
  NOT_STARTED: "文件已经上传，但尚未创建处理任务。", QUEUED_FOR_INGESTION: "正在等待解析", INGESTING: "正在提取正文和书籍结构", WAITING_FOR_ANALYSIS: "解析完成，准备进行 AI 深度理解", ANALYSIS_QUEUED: "正在准备 AI 深度理解", ANALYZING: "正在进行 AI 深度理解", WAITING_FOR_PROVIDER: "AI Provider 尚未配置完成，配置后会自动继续", BOOTSTRAP_FAILED: "AI 深度理解准备失败，可安全地尝试恢复。", BOOTSTRAP_SUCCEEDED: "AI 深度理解准备已完成，正在核对处理结果。", SUCCEEDED: "处理完成", INGESTION_FAILED: "文件解析失败", ANALYSIS_FAILED: "AI 深度理解失败", PROCESSING_DEGRADED: "后台处理服务暂时没有响应。你的文件已经保存，可以稍后重试。",
};

export function processingWaitLabel(since: Date | null | undefined, now = new Date()): string | null {
  if (!since) return null;
  const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1_000));
  return seconds < 60 ? `已等待 ${seconds} 秒` : `已等待 ${Math.floor(seconds / 60)} 分钟`;
}
