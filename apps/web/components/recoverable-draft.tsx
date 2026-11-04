"use client";
import { createContext, useContext, useEffect, useState } from "react";

const Scope = createContext("");
const prefix = "acs-draft-v1:";
export function DraftScope({ scope, children }: { scope: string; children: React.ReactNode }) { return <Scope.Provider value={scope}>{children}</Scope.Provider>; }
export type Draft = { content: string; pendingId?: string; savedAt: number };
export function clearDrafts() {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}
export function useRecoverableDraft(entity: string) {
  const scope = useContext(Scope), key = `${prefix}${scope}:${entity}`;
  const [draft, setDraft] = useState<Draft>({ content: "", savedAt: 0 });
  const [loadedKey, setLoadedKey] = useState("");
  const ready = loadedKey === key;
  useEffect(() => {
    let value: Draft = { content: "", savedAt: 0 };
    try {
      const raw = sessionStorage.getItem(key), parsed = raw ? JSON.parse(raw) as Draft : null;
      if (parsed && typeof parsed.content === "string" && parsed.content.length <= 10000 && Number.isFinite(parsed.savedAt) && parsed.savedAt <= Date.now() && Date.now() - parsed.savedAt < 86400000 && (!parsed.pendingId || /^[\da-f-]{36}$/i.test(parsed.pendingId))) value = parsed;
      else sessionStorage.removeItem(key);
    } catch { /* Retain an editable in-memory draft when persistence is unavailable. */ }
    let active = true;
    queueMicrotask(() => { if (active) { setDraft(value); setLoadedKey(key); } });
    return () => { active = false; };
  }, [key]);
  useEffect(() => {
    if (!draft.content) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft.content]);
  function save(content: string, pendingId?: string) {
    if (!ready) return;
    const next = { content, pendingId, savedAt: Date.now() }; setDraft(next);
    try { if (content) sessionStorage.setItem(key, JSON.stringify(next)); else sessionStorage.removeItem(key); } catch { /* beforeunload still guards the in-memory draft. */ }
  }
  return { draft: ready ? draft : { content: "", savedAt: 0 }, ready, save };
}
