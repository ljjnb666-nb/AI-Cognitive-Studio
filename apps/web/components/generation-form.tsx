"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./generation-form.module.css";
import { mediaGenerationErrorMessage } from "@/lib/product-errors";
import type { SourceSummary } from "@/lib/product";

const tonePresets = [
  { value: "clear, curious, grounded", label: "清晰自然", description: "循序渐进，有据可依" },
  { value: "analytical, rigorous, academic", label: "严谨分析", description: "逻辑清楚，深入探讨" },
  { value: "engaging, conversational, narrative", label: "轻松叙事", description: "口语表达，用故事展开" },
  { value: "sharp, concise, insightful", label: "简洁有力", description: "直击重点，突出洞见" },
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
      // The destination renders its own fresh data; avoid racing navigation
      // against an immediate refresh of this creation page.
      router.push(body.href);
    } catch (error) {
      setMessage(mediaGenerationErrorMessage(error instanceof Error ? error.message : undefined));
    } finally {
      setBusy(false);
    }
  }

  const configured = readiness?.state !== "INCOMPLETE";

  const id = `generation-${kind}`;
  return (
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(new FormData(event.currentTarget)); }}>
      {!configured && <div className={styles.notice} role="status"><div><strong>生成前还需要完成模型配置</strong><p>请先设置{kind === "video" ? "短视频脚本、向量检索及配音" : "播客脚本及向量检索"}所需的服务商和模型。</p></div><Link href="/studio/settings/providers#provider-models" className="btn btn-secondary">前往配置</Link></div>}
      <div className={styles.layout}>
        <section className={styles.content} aria-label="内容来源">
          <div className={styles.heading}><h2>内容与书籍</h2><p>为这次创作命名，并选择已经完成理解的书。</p></div>
          <div className={styles.field}><label htmlFor={`${id}-title`}>标题</label><input id={`${id}-title`} className="input-control" name="title" required maxLength={160} placeholder={kind === "podcast" ? "例如：理解复杂系统" : "例如：一个反直觉的观点"} disabled={busy} /></div>
          <div className={styles.bookHeading}><h3>选择书籍</h3><span>已选 {selectedSupported.length} / 8 本</span></div>
          <div className={styles.books} role="group" aria-label="选择已完成理解的书">
            {supported.map(source => <label key={source.id} className={styles.book} data-selected={selectedSupported.includes(source.id)}><input type="checkbox" checked={selectedSupported.includes(source.id)} disabled={busy || (!selectedSupported.includes(source.id) && selectedSupported.length >= 8)} onChange={event => toggle(source.id, event.target.checked)} /><span>{source.title}</span></label>)}
            {!supported.length && <div className={styles.empty}><strong>暂无可用书籍</strong><p>请先在知识库完成书籍提取与理解，再回来选择。</p><Link href="/studio/library" className="btn btn-secondary">前往知识库</Link></div>}
          </div>
          {supported.length > 0 && <p className={styles.hint}>仅展示已完成理解的书籍，最多可选择 8 本。</p>}
        </section>
        <section className={styles.options} aria-label="生成设置">
          <div className={styles.heading}><h2>表达与时长</h2><p>选择适合内容的表达方式和目标时长。</p></div>
          <div className={styles.field}><label htmlFor={`${id}-tone`}>表达风格</label><div className={styles.presets}>{tonePresets.map(preset => <button type="button" key={preset.value} aria-pressed={tone === preset.value} disabled={busy} onClick={() => setTone(preset.value)}><strong>{preset.label}</strong><span>{preset.description}</span></button>)}</div><input id={`${id}-tone`} className="input-control" name="tone" value={tonePresets.find(preset => preset.value === tone)?.label ?? tone} onChange={event => setTone(event.target.value)} maxLength={160} disabled={busy} aria-label="自定义表达风格" placeholder="也可以填写你希望的表达风格" /></div>
          <div className={styles.field}><label htmlFor={`${id}-duration`}>{kind === "podcast" ? "目标时长（分钟）" : "目标时长（秒）"}</label><input id={`${id}-duration`} className="input-control" name="duration" type="number" min={kind === "podcast" ? 1 : 15} max={kind === "podcast" ? 120 : 180} defaultValue={kind === "podcast" ? 10 : 60} required disabled={busy} /><p className={styles.hint}>{kind === "podcast" ? "可设置 1～120 分钟。" : "可设置 15～180 秒，实际时长随旁白和镜头调整。"}</p></div>
        </section>
      </div>
      <footer className={styles.footer}><div>{message ? <p className="form-error" role="alert">{message}</p> : <p>{!supported.length ? "完成书籍理解后即可选择内容。" : !configured ? "完成模型配置后即可开始生成。" : !selectedSupported.length ? "请至少选择一本书。" : `已选择 ${selectedSupported.length} 本书，可以开始生成。`}</p>}</div><button type="submit" className="btn btn-primary" disabled={busy || !configured || !selectedSupported.length}>{busy ? "提交中…" : kind === "podcast" ? "开始生成播客" : "开始生成短视频"}</button></footer>
    </form>
  );
}
