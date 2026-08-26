"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { SourceSummary } from "@/lib/product";

export function GenerationForm({ kind, sources }: { kind: "podcast" | "video"; sources: SourceSummary[] }) {
  const router = useRouter();
  const supported = useMemo(() => sources.filter(source => source.hasIntelligence), [sources]);
  const supportedIds = useMemo(() => new Set(supported.map(source => source.id)), [supported]);
  const [selected, setSelected] = useState<string[]>(() => supported.slice(0, 1).map(source => source.id));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedSupported = selected.filter(id => supportedIds.has(id)).slice(0, 8);
  function toggle(id: string, checked: boolean) { setSelected(current => { const available = current.filter(item => supportedIds.has(item)).slice(0, 8); return checked ? (available.includes(id) || available.length >= 8 ? available : [...available, id]) : available.filter(item => item !== id); }); }
  async function submit(form: FormData) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/studio/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, title: form.get("title"), tone: form.get("tone"), duration: Number(form.get("duration")), sourceDocumentIds: selectedSupported }) });
      const body = await response.json() as { href?: string; error?: string };
      if (!response.ok || !body.href) throw new Error(body.error ?? "GENERATION_FAILED");
      router.push(body.href); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? `无法提交：${error.message}` : "无法提交，请重试"); } finally { setBusy(false); }
  }
  return <form className="panel form" onSubmit={event => { event.preventDefault(); void submit(new FormData(event.currentTarget)); }}><label>标题<input name="title" required maxLength={160} placeholder={kind === "podcast" ? "例如：理解复杂系统" : "例如：一个反直觉的观点"} /></label><fieldset><legend>选择已完成理解的书</legend>{supported.map(source => <label className="check" key={source.id}><input type="checkbox" checked={selectedSupported.includes(source.id)} onChange={event => toggle(source.id, event.target.checked)} />{source.title}</label>)}{!supported.length ? <p className="muted">暂无可用书籍。请先完成书籍解析和理解。</p> : null}</fieldset><label>表达风格<input name="tone" defaultValue="clear, curious, grounded" maxLength={160} /></label><label>{kind === "podcast" ? "时长（分钟）" : "时长（秒）"}<input name="duration" type="number" min={kind === "podcast" ? 1 : 15} max={kind === "podcast" ? 120 : 180} defaultValue={kind === "podcast" ? 10 : 60} /></label><p aria-live="polite" className="error">{message}</p><button type="submit" className="button" disabled={busy || !selectedSupported.length}>{busy ? "提交中…" : kind === "podcast" ? "开始生成播客" : "开始生成短视频"}</button></form>;
}
