"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function GenerationProcessing({ status, episodeId, hasAudio = false }: { status: string; episodeId?: string; hasAudio?: boolean }) {
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
  useEffect(() => { if (status === "SUCCEEDED" && episodeId && !hasAudio) queueMicrotask(() => void requestAudio()); }, [episodeId, hasAudio, requestAudio, status]);
  useEffect(() => {
    if (hasAudio || status === "FAILED" || audioError) return;
    const timer = window.setInterval(() => router.refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [audioError, hasAudio, router, status]);
  if (audioError) return <section className="panel"><p className="error">音频生成请求失败：{audioError}</p><button className="button secondary" onClick={() => void requestAudio(true)}>重试音频生成</button></section>;
  return null;
}
