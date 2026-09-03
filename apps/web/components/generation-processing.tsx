"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { mediaGenerationErrorMessage } from "@/lib/product-errors";

export function GenerationProcessing({ status, episodeId, hasAudio = false, audioStatus, audioErrorCode }: { status: string; episodeId?: string; hasAudio?: boolean; audioStatus?: string | null; audioErrorCode?: string | null }) {
  const router = useRouter();
  const requestedAudio = useRef(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const requestAudio = useCallback(async (manual = false) => {
    if (!episodeId || hasAudio || (!manual && requestedAudio.current)) return;
    requestedAudio.current = true;
    try {
      const response = await fetch("/api/studio/podcast-audio", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ episodeId }) });
      setAudioError(null);
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        setAudioError(body.error ?? "PODCAST_AUDIO_REQUEST_FAILED");
        requestedAudio.current = false;
        return;
      }
      router.refresh();
    } catch {
      setAudioError("PODCAST_AUDIO_REQUEST_FAILED");
      requestedAudio.current = false;
    }
  }, [episodeId, hasAudio, router]);
  useEffect(() => { if (status === "SUCCEEDED" && episodeId && !hasAudio && !audioStatus) queueMicrotask(() => void requestAudio()); }, [audioStatus, episodeId, hasAudio, requestAudio, status]);
  useEffect(() => {
    if (hasAudio || status === "FAILED" || audioStatus === "FAILED" || audioError) return;
    const timer = window.setInterval(() => router.refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [audioError, audioStatus, hasAudio, router, status]);
  const failed = audioStatus === "FAILED";
  const failureCode = audioError ?? audioErrorCode;
  const configurationError = failureCode === "AI_PROVIDER_CONFIGURATION_REQUIRED" || failureCode === "PODCAST_TTS_CONFIGURATION_REQUIRED";
  if (failed) return <section className="panel"><p className="error">音频生成失败：{mediaGenerationErrorMessage(audioErrorCode)}</p><div className="actions">{configurationError && <Link className="button" href="/studio/settings/providers">配置 Provider</Link>}<button className="button secondary" onClick={() => void requestAudio(true)}>重试音频生成</button></div></section>;
  if (audioError) return <section className="panel"><p className="error">{mediaGenerationErrorMessage(audioError)}</p><div className="actions">{configurationError && <Link className="button" href="/studio/settings/providers">配置 Provider</Link>}<button className="button secondary" onClick={() => void requestAudio(true)}>重试音频生成</button></div></section>;
  return null;
}
