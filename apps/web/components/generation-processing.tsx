"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export function GenerationProcessing({ status, episodeId, hasAudio = false }: { status: string; episodeId?: string; hasAudio?: boolean }) {
  const router = useRouter();
  const requestedAudio = useRef(false);
  useEffect(() => {
    if (status === "SUCCEEDED" && episodeId && !hasAudio && !requestedAudio.current) {
      requestedAudio.current = true;
      void fetch("/api/studio/podcast-audio", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ episodeId }) }).finally(() => router.refresh());
    }
    if (status === "FAILED") return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [episodeId, hasAudio, router, status]);
  return status === "FAILED" ? null : <p className="muted" aria-live="polite">This page refreshes automatically while the durable generation job runs.</p>;
}
