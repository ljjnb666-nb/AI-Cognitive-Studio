"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SourceSummary } from "@/lib/product";

const tonePresets = [
  "clear, curious, grounded",
  "analytical, rigorous, academic",
  "engaging, conversational, narrative",
  "sharp, concise, insightful",
];

export function GenerationForm({
  kind,
  sources,
  readiness,
}: {
  kind: "podcast" | "video";
  sources: SourceSummary[];
  readiness?: { state: string; missing: readonly string[] };
}) {
  const router = useRouter();
  const supported = useMemo(() => sources.filter((source) => source.hasIntelligence), [sources]);
  const supportedIds = useMemo(() => new Set(supported.map((source) => source.id)), [supported]);
  const [selected, setSelected] = useState<string[]>(() => supported.slice(0, 1).map((source) => source.id));
  const [tone, setTone] = useState("clear, curious, grounded");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedSupported = selected.filter((id) => supportedIds.has(id)).slice(0, 8);

  function toggle(id: string, checked: boolean) {
    setSelected((current) => {
      const available = current.filter((item) => supportedIds.has(item)).slice(0, 8);
      return checked
        ? available.includes(id) || available.length >= 8
          ? available
          : [...available, id]
        : available.filter((item) => item !== id);
    });
  }

  async function submit(form: FormData) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/studio/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          title: form.get("title"),
          tone,
          duration: Number(form.get("duration")),
          sourceDocumentIds: selectedSupported,
        }),
      });
      const body = (await response.json()) as { href?: string; error?: string };
      if (!response.ok || !body.href) throw new Error(body.error ?? "GENERATION_FAILED");
      router.push(body.href);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? `无法提交：${error.message}` : "无法提交，请重试");
    } finally {
      setBusy(false);
    }
  }

  const configured = readiness?.state !== "INCOMPLETE";

  return (
    <form
      className="card-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(new FormData(event.currentTarget));
      }}
      style={{ display: "grid", gap: 24, maxWidth: 680 }}
    >
      {!configured && (
        <div
          aria-live="polite"
          style={{
            backgroundColor: "var(--surface-container)",
            border: "1px solid var(--muted-terracotta)",
            borderRadius: "var(--radius-default)",
            padding: "16px",
            fontSize: 14,
            color: "var(--on-surface)",
          }}
        >
          <p style={{ margin: "0 0 8px 0" }}>请先配置可执行的 AI Provider 路由，再开始生成。</p>
          <Link href="/studio/settings/providers" className="btn btn-secondary" style={{ height: 32, fontSize: 13 }}>
            配置 AI Provider
          </Link>
        </div>
      )}

      <div className="form-group">
        <label className="form-label">标题</label>
        <input
          className="input-control"
          name="title"
          required
          maxLength={160}
          placeholder={kind === "podcast" ? "例如：理解复杂系统" : "例如：一个反直觉的观点"}
        />
      </div>

      <div className="form-group">
        <label className="form-label">选择已完成理解的书 (最多 8 本)</label>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            backgroundColor: "var(--surface-container-lowest)",
            border: "1px solid var(--surface-container-highest)",
            borderRadius: "var(--radius-default)",
            padding: "16px",
          }}
        >
          {supported.map((source) => (
            <label key={source.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selectedSupported.includes(source.id)}
                onChange={(event) => toggle(source.id, event.target.checked)}
                style={{ accentColor: "var(--primary)", width: 16, height: 16 }}
              />
              <span className="font-serif">{source.title}</span>
            </label>
          ))}
          {!supported.length && (
            <p style={{ color: "var(--outline)", margin: 0, fontSize: 13 }} aria-live="polite">
              暂无可用书籍。请先完成书籍解析和理解。
            </p>
          )}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">表达风格 (Tone)</label>
        <input
          className="input-control font-mono"
          name="tone"
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          maxLength={160}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          {tonePresets.map((preset) => (
            <button
              key={preset}
              type="button"
              className="btn btn-secondary"
              onClick={() => setTone(preset)}
              style={{ height: 28, fontSize: 11, padding: "0 10px" }}
            >
              {preset}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">{kind === "podcast" ? "时长（分钟）" : "时长（秒）"}</label>
        <input
          className="input-control font-mono"
          name="duration"
          type="number"
          min={kind === "podcast" ? 1 : 15}
          max={kind === "podcast" ? 120 : 180}
          defaultValue={kind === "podcast" ? 10 : 60}
        />
      </div>

      <p className="form-error" aria-live="polite">
        {message}
      </p>

      <button
        type="submit"
        className="btn btn-primary"
        disabled={busy || !configured || !selectedSupported.length}
        style={{ justifySelf: "start" }}
      >
        {busy ? "提交中…" : kind === "podcast" ? "开始生成播客" : "开始生成短视频"}
      </button>
    </form>
  );
}
