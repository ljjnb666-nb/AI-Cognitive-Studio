"use client";
import { useEffect } from "react";
export function BetaSessionTracker() {
  useEffect(() => { const key = "acs_phase17_session"; let sessionId = sessionStorage.getItem(key); if (!sessionId) { sessionId = crypto.randomUUID(); sessionStorage.setItem(key, sessionId); } const eventKey = `acs_phase17_started:${sessionId}`; if (sessionStorage.getItem(eventKey)) return; sessionStorage.setItem(eventKey, "1"); void fetch("/api/studio/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventName: "STUDIO_SESSION_STARTED", clientEventId: crypto.randomUUID(), sessionId, route: window.location.pathname, properties: {} }) }); }, []);
  return null;
}
