"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { mediaGenerationErrorMessage } from "@/lib/product-errors";

export function GenerationProcessing({ status, episodeId, hasScript = false, hasAudio = false, audioStatus, audioErrorCode }: { status: string; episodeId?: string; hasScript?: boolean; hasAudio?: boolean; audioStatus?: string | null; audioErrorCode?: string | null }) {
  const router = useRouter();
  const requestedAudio = useRef(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const requestAudio = useCallback(async () => {
    if (!episodeId || hasAudio || requestedAudio.current || audioStatus === "QUEUED" || audioStatus === "RUNNING") return;
    requestedAudio.current = true;
    setRequesting(true);
    try {
      const response = await fetch("/api/studio/podcast-audio", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ episodeId }) });
      setAudioError(null);
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        setAudioError(body.error ?? "PODCAST_AUDIO_REQUEST_FAILED");
        requestedAudio.current = false;
        return;
      }
      const result = await response.json() as { status?: string };
      if (result.status === "FAILED") {
        setAudioError("PODCAST_AUDIO_RECOVERY_REQUIRED");
        requestedAudio.current = false;
        return;
      }
      setSubmitted(true);
      router.refresh();
    } catch {
      setAudioError("PODCAST_AUDIO_REQUEST_FAILED");
      requestedAudio.current = false;
    } finally {
      setRequesting(false);
    }
  }, [audioStatus, episodeId, hasAudio, router]);
  useEffect(() => {
    if (hasAudio || audioError || ![status, audioStatus].some(value => value === "RUNNING" || value === "QUEUED")) return;
    const timer = window.setInterval(() => { if (!document.hidden) router.refresh(); }, 7_500);
    return () => window.clearInterval(timer);
  }, [audioError, audioStatus, hasAudio, router, status]);
  const failed = audioStatus === "FAILED";
  const failureCode = audioError ?? audioErrorCode;
  const configurationError = failureCode === "AI_PROVIDER_CONFIGURATION_REQUIRED" || failureCode === "PODCAST_TTS_CONFIGURATION_REQUIRED";
  if (hasAudio) return null;
  if (audioError === "PODCAST_AUDIO_RECOVERY_REQUIRED") return <section className="card-panel" role="alert"><p>已有音频任务需要核对，当前没有启动新的语音合成。请先处理已保存的任务结果。</p><button type="button" className="btn btn-secondary" onClick={() => router.refresh()}>重新检查状态</button></section>;
  if (failed || audioError) return <section className="card-panel" role="alert"><p className="error">音频生成失败：{mediaGenerationErrorMessage(failureCode)}</p><div className="actions">{configurationError && <Link className="btn btn-secondary" href="/studio/settings/providers">配置服务商</Link>}<button disabled={requesting || submitted} className="btn btn-secondary" onClick={() => void requestAudio()}>{requesting ? "正在提交…" : submitted ? "已提交，等待处理" : "重试音频生成"}</button></div></section>;
  if (episodeId && hasScript && !audioStatus) return <section className="card-panel"><p>文稿已保存，音频尚未生成。语音合成可能产生费用。</p><button type="button" disabled={requesting || submitted} className="btn btn-primary" onClick={() => void requestAudio()}>{requesting ? "正在提交…" : submitted ? "已提交，等待处理" : "生成音频"}</button></section>;
  return null;
}
