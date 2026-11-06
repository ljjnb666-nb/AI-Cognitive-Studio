"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  bookIntelligenceErrorMessage,
  needsProviderConfiguration,
} from "@/lib/product-errors";
import { submitProcessingRecovery } from "@/lib/processing-recovery";
import { processingWaitLabel, type ProcessingStage, type ProcessingState, type ProcessingWorkerAvailability, type RecoveryAction, type WorkerAvailability } from "@/lib/processing-state";
import { processingDisplay, processingWorkersDisplay } from "@/lib/processing-display";
import { StatusBadge } from "./status-badge";

type Props = { failureReason?: string; sourceDocumentId: string; ingestionStatus?: string | null; analysisStatus?: string | null; bootstrapStatus?: string | null; errorCode?: string | null; processingState: string; processingStage: ProcessingStage; recoveryAction: RecoveryAction; stageAvailability: WorkerAvailability; workerAvailability: WorkerAvailability | ProcessingWorkerAvailability; processingSince?: string | null };

export function SourceProcessing({ failureReason, sourceDocumentId, ingestionStatus: _ingestionStatus, analysisStatus: _analysisStatus, bootstrapStatus: _bootstrapStatus, errorCode, processingState, processingStage, recoveryAction, stageAvailability, workerAvailability, processingSince }: Props) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const terminal = processingState === "SUCCEEDED" || processingState.includes("FAILED");
  useEffect(() => {
    if (terminal) return;
    let timer: number | undefined, stopped = false;
    const delay = processingState === "PROCESSING_DEGRADED" ? 45_000 : processingState === "QUEUED_FOR_INGESTION" || processingState === "INGESTING" ? 3_000 : 7_500;
    const poll = () => { if (stopped) return; if (!document.hidden) router.refresh(); timer = window.setTimeout(poll, delay); };
    timer = window.setTimeout(poll, delay);
    return () => { stopped = true; if (timer) window.clearTimeout(timer); };
  }, [processingState, router, terminal]);
  const [recovering, setRecovering] = useState(false);
  const recover = useCallback(async () => { if (recovering) return; setRecovering(true); try { const result = await submitProcessingRecovery(sourceDocumentId); if (result !== "RECOVERED") { setMessage(result); return; } router.refresh(); } finally { setRecovering(false); } }, [recovering, router, sourceDocumentId]);
  const failureCode = message ?? errorCode;
  const configurationError = processingState === "WAITING_FOR_PROVIDER" || needsProviderConfiguration(failureCode);
  const state = processingState as ProcessingState;
  const recovery = recoveryAction !== "NONE" && recoveryAction !== "RECHECK";
  // This label is relative to the current clock, so its text can legitimately
  // differ by a second between SSR and hydration while durable state is equal.
  const display = processingDisplay({ state, stage: processingStage, recoveryAction, stageAvailability, failureReason }, errorCode);
  const queued = state === "QUEUED_FOR_INGESTION" || state === "ANALYSIS_QUEUED";
  const waiting = (display.active || queued) && processingSince ? processingWaitLabel(new Date(processingSince))?.replace("已等待", display.active ? "已进行" : "已排队") : null;
  const recoveryCopy = recoveryAction === "RETRY_INGESTION" ? (state === "NOT_STARTED" ? "开始处理" : "重新提取") : "恢复深度理解";
  return <section className="source-processing" aria-label="书籍处理进度" aria-busy={recovering}>
    <div className="processing-workers" aria-label="后台处理服务状态">
      <p className="processing-workers-heading">后台处理服务</p>
      <dl>{processingWorkersDisplay(workerAvailability).map(worker => <div key={worker.capability}>
        <dt>{worker.label}</dt><dd><StatusBadge value={worker.statusLabel} tone={worker.tone} /></dd>
      </div>)}</dl>
      <p className="muted">服务在线表示可接单，本书是否开始执行以步骤状态为准。</p>
    </div>
    <ol className="processing-steps">
      <li data-state="done"><span aria-hidden="true">✓</span><div>文件已保存<small>原文件安全保留</small></div></li>
      <li data-state={processingStage !== "INGESTION" ? "done" : display.active ? "active" : "waiting"}><span aria-hidden="true">{processingStage !== "INGESTION" ? "✓" : "2"}</span><div>正文提取<small>{processingStage !== "INGESTION" ? "可查看提取原文" : display.label}</small></div></li>
      <li data-state={state === "SUCCEEDED" ? "done" : processingStage === "BOOK_ANALYSIS" && display.active ? "active" : "waiting"}><span aria-hidden="true">{state === "SUCCEEDED" ? "✓" : "3"}</span><div>AI 深度理解<small>{processingStage === "INGESTION" ? "正文提取后进行" : display.label}</small></div></li>
    </ol>
    <div className={`processing-notice processing-notice-${display.tone}`} role="status">
      <p>{display.description}</p>
      {state === "INGESTION_FAILED" && errorCode && /^SOURCE_[A-Z0-9_]{1,72}$/.test(errorCode) && <p className="muted">错误编号：{errorCode}</p>}
      {waiting && <p className="muted" suppressHydrationWarning>{waiting}</p>}
      <p className="muted">{state === "SUCCEEDED" ? "全部处理已完成。" : terminal ? "任务已停止，现有文件和已完成的结果保留。" : stageAvailability === "DEGRADED" ? "当前阶段的后台服务未就绪，页面会自动检查状态。" : stageAvailability === "UNKNOWN" ? "暂时无法确认后台服务状态，页面会自动检查，也可手动重新检查。" : display.active || queued ? "页面自动更新任务进度，无需保持页面打开。" : "当前没有正在执行的处理任务。"}</p>
    </div>
    {message && <p className="error" role="alert">{bookIntelligenceErrorMessage(message)}</p>}
    <div className="actions processing-actions">
      {configurationError && <Link className="btn btn-primary" href="/studio/settings/providers">配置 AI 服务商</Link>}
      <button type="button" className="btn btn-secondary" onClick={() => { setMessage(null); router.refresh(); }}>重新检查状态</button>
      {recovery && !configurationError && <button type="button" className="btn btn-primary" disabled={recovering} onClick={() => void recover()}>{recovering ? "正在提交恢复…" : recoveryCopy}</button>}
    </div>
  </section>;
}
