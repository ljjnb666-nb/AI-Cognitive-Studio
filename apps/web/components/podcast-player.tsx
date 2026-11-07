"use client";

import { useCallback, useRef, useState } from "react";

const milestones = [[0.25, "PODCAST_PLAYBACK_25"], [0.5, "PODCAST_PLAYBACK_50"], [0.75, "PODCAST_PLAYBACK_75"], [0.9, "PODCAST_PLAYBACK_90"]] as const;

export function PodcastPlayer({ revisionId, telemetryEnabled }: { revisionId: string; telemetryEnabled: boolean }) {
  const audioElement = useRef<HTMLAudioElement>(null);
  const [playback, setPlayback] = useState<"loading" | "ready" | "buffering" | "playing" | "paused" | "ended" | "failed">("loading");
  // Metadata/error events may finish before hydration attaches React handlers.
  const attachAudio = useCallback((node: HTMLAudioElement | null) => {
    audioElement.current = node;
    if (node?.error) setPlayback("failed");
    else if (node && node.readyState >= 1) setPlayback("ready");
  }, []);
  const emitted = useRef(new Set<string>());
  const seeking = useRef(false);
  const lastPosition = useRef<number | null>(null);
  const listenedSeconds = useRef(0);

  function emit(eventName: string, properties: Record<string, number> = {}) {
    if (!telemetryEnabled || emitted.current.has(eventName)) return;
    emitted.current.add(eventName);
    if (eventName === "PODCAST_PLAYBACK_90" || eventName === "PODCAST_PLAYBACK_ENDED") {
      localStorage.setItem(`acs_phase17_listened:${revisionId}`, "1");
      window.dispatchEvent(new CustomEvent("acs-phase17-podcast-listened", { detail: revisionId }));
    }
    const key = "acs_phase17_session";
    const sessionId = sessionStorage.getItem(key) ?? crypto.randomUUID();
    sessionStorage.setItem(key, sessionId);
    void fetch("/api/studio/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventName, clientEventId: crypto.randomUUID(), sessionId, entityType: "PODCAST_AUDIO_REVISION", entityId: revisionId, route: window.location.pathname, properties }) });
  }

  function recordProgress(audio: HTMLAudioElement) {
    if (seeking.current || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const previous = lastPosition.current;
    lastPosition.current = audio.currentTime;
    if (previous === null) return;
    const delta = audio.currentTime - previous;
    if (delta <= 0 || delta > 5) return;
    listenedSeconds.current += delta;
    for (const [threshold, eventName] of milestones) {
      if (listenedSeconds.current >= audio.duration * threshold) emit(eventName, { playbackPositionSeconds: audio.currentTime, durationSeconds: audio.duration });
    }
  }

  const playbackLabel = { loading: "正在加载音频…", ready: "音频已加载，可以播放", buffering: "音频缓冲中…", playing: "正在播放", paused: "已暂停", ended: "播放结束", failed: "音频加载失败，请检查登录状态与本机存储服务后重试。" }[playback];
  return <div>
    <audio ref={attachAudio} controls preload="metadata" src={`/api/studio/media/audio/${revisionId}`} style={{ width: "100%", borderRadius: 4 }}
      onLoadStart={(event) => setPlayback(event.currentTarget.error ? "failed" : "loading")} onWaiting={() => setPlayback("buffering")} onPlaying={() => setPlayback("playing")}
      onPause={(event) => { if (!event.currentTarget.ended && !event.currentTarget.error) setPlayback("paused"); }} onError={() => setPlayback("failed")}
      onLoadedMetadata={(event) => { setPlayback("ready"); lastPosition.current = event.currentTarget.currentTime; }}
      onPlay={(event) => { lastPosition.current = event.currentTarget.currentTime; emit("PODCAST_PLAYBACK_STARTED", { playbackPositionSeconds: event.currentTarget.currentTime, durationSeconds: event.currentTarget.duration }); }}
      onSeeking={() => { seeking.current = true; }} onSeeked={(event) => { seeking.current = false; lastPosition.current = event.currentTarget.currentTime; }}
      onTimeUpdate={(event) => { recordProgress(event.currentTarget); }}
      onEnded={(event) => { setPlayback("ended"); emit("PODCAST_PLAYBACK_ENDED", { playbackPositionSeconds: event.currentTarget.currentTime, durationSeconds: event.currentTarget.duration }); }}>你的浏览器不支持音频播放。</audio>
    <p role="status" className={playback === "failed" ? "error" : "muted"} style={{ fontSize: 13 }}>{playbackLabel}</p>
    {playback === "failed" && <button type="button" className="btn btn-secondary" onClick={() => audioElement.current?.load()}>重新加载音频</button>}
  </div>;
}
