"use client";

import { useRef } from "react";

const milestones = [[0.25, "PODCAST_PLAYBACK_25"], [0.5, "PODCAST_PLAYBACK_50"], [0.75, "PODCAST_PLAYBACK_75"], [0.9, "PODCAST_PLAYBACK_90"]] as const;

export function PodcastPlayer({ revisionId, telemetryEnabled }: { revisionId: string; telemetryEnabled: boolean }) {
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

  return <audio controls preload="metadata" src={`/api/studio/media/audio/${revisionId}`} style={{ width: "100%", borderRadius: 4 }} onLoadedMetadata={(event) => { lastPosition.current = event.currentTarget.currentTime; }} onPlay={(event) => { lastPosition.current = event.currentTarget.currentTime; emit("PODCAST_PLAYBACK_STARTED", { playbackPositionSeconds: event.currentTarget.currentTime, durationSeconds: event.currentTarget.duration }); }} onSeeking={() => { seeking.current = true; }} onSeeked={(event) => { lastPosition.current = event.currentTarget.currentTime; seeking.current = false; }} onTimeUpdate={(event) => { recordProgress(event.currentTarget); }} onEnded={(event) => emit("PODCAST_PLAYBACK_ENDED", { playbackPositionSeconds: event.currentTarget.currentTime, durationSeconds: event.currentTarget.duration })}>你的浏览器不支持音频播放。</audio>;
}
