"use client";
import { useEffect, useState } from "react";
import styles from "./resource-budget-settings.module.css";

type Budget = { dailyUnitLimit: number; runUnitLimit: number; runLimitEnabled?: boolean; bookChunkConcurrency?: number; usedUnits: number };
export function ResourceBudgetSettings() {
  const [budget, setBudget] = useState<Budget | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/studio/resource-budget", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      setBudget(await response.json() as Budget);
    }).catch(() => { if (!controller.signal.aborted) setMessage("资源设置暂时无法读取。"); });
    return () => controller.abort();
  }, []);
  return <section className={`card-panel ${styles.panel}`}>
    <h2>理解并发与资源额度</h2>
    <p>并发仅用于同一本书的分块理解，章节归并与全书综合仍按依赖顺序执行。</p>
    {budget && <form onSubmit={async event => {
      event.preventDefault();
      if (saving) return;
      setSaving(true); setMessage("");
      const response = await fetch("/api/studio/resource-budget", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ dailyUnitLimit: budget.dailyUnitLimit, runUnitLimit: budget.runUnitLimit, runLimitEnabled: budget.runLimitEnabled !== false, bookChunkConcurrency: budget.bookChunkConcurrency ?? 2 }),
      }).catch(() => null);
      setSaving(false);
      setMessage(response?.ok ? "设置已保存。并发数将在新启动或恢复的任务中生效。" : "保存失败，仅工作区所有者可以调整设置。");
    }}>
      <fieldset disabled={saving} className={styles.fields}>
        <label className={styles.field}>单书分块并发数
          <select value={budget.bookChunkConcurrency ?? 2} aria-describedby="book-concurrency-help" onChange={event => setBudget({ ...budget, bookChunkConcurrency: Number(event.target.value) })}>
            <option value={1}>1 块（串行）</option><option value={2}>2 块（推荐）</option><option value={3}>3 块</option><option value={4}>4 块</option>
          </select>
        </label>
        <p className={styles.full} id="book-concurrency-help">同时理解 1～4 个分块；修改不影响正在执行的任务。并发越高，额度消耗越快，仍受服务商限流和每日额度约束。失败后停止派发新分块，已发出的请求仍会等待结果并可能计费。</p>
        <p className={styles.full}>额度按词元或字符保守预留，每日按世界标准时间零点重置。未知结果保留预留量，实际费用以服务商账单为准。</p>
        <p className={styles.full}>今日已消费或预留：{budget.usedUnits}</p>
        <label className={styles.field}>每日上限 <input type="number" min={0} max={100000000} value={budget.dailyUnitLimit} onChange={event => setBudget({ ...budget, dailyUnitLimit: Number(event.target.value) })} /></label>
        <label className={styles.full}><input type="checkbox" checked={budget.runLimitEnabled !== false} onChange={event => setBudget({ ...budget, runLimitEnabled: event.target.checked })} />启用单任务上限</label>
        {budget.runLimitEnabled === false && <p className={styles.full}>单任务上限已取消，每日额度继续生效。</p>}
        <label className={styles.field}>单任务上限 <input disabled={budget.runLimitEnabled === false} type="number" min={0} max={10000000} value={budget.runUnitLimit} onChange={event => setBudget({ ...budget, runUnitLimit: Number(event.target.value) })} /></label>
        <div className={styles.full}><button className="btn" type="submit">{saving ? "正在保存…" : "保存设置"}</button></div>
      </fieldset>
    </form>}
    {message && <p role="status">{message}</p>}
  </section>;
}
