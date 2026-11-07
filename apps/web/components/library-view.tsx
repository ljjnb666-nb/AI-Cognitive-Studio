"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "./page-header";
import { UploadPanel } from "./upload-panel";
import { LibraryDeleteDialog } from "./library-delete-dialog";
import { SourceCard } from "./source-card";
import { processingDisplay } from "@/lib/processing-display";
import type { SourceSummary } from "@/lib/product";

export function LibraryView({ items, canDelete = false, query = {}, page = 1 }: { items: SourceSummary[]; canDelete?: boolean; query?:Record<string,string|undefined>; page?:number }) {
  const router = useRouter();
  const [search, setSearch] = useState(query.q ?? "");
  const [deleting, setDeleting] = useState<SourceSummary | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());
  const [deleteMessage, setDeleteMessage] = useState("");
  const visibleItems = useMemo(() => items.filter(item => !removedIds.has(item.id)), [items, removedIds]);
  const [formatFilter, setFormatFilter] = useState(query.format ?? "ALL");
  const [serverStatus,setServerStatus] = useState(query.status ?? "ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const needsRefresh = visibleItems.some(item => item.processing.recoveryAction === "RECHECK");
  useEffect(() => {
    if (!needsRefresh) return;
    const timer = window.setInterval(() => { if (!document.hidden) router.refresh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [needsRefresh, router]);
  const counts = visibleItems.reduce((result, item) => {
    result[processingDisplay(item.processing, item.errorCode).group]++;
    return result;
  }, { READY: 0, ACTIVE: 0, WAITING: 0, ATTENTION: 0 });

  const filteredItems = useMemo(() => {
    return visibleItems.filter((item) => {
      // Match either authoritative Work title or original file name.
      const term = search.trim().toLowerCase();
      if (term && !item.title.toLowerCase().includes(term) && !item.fileName.toLowerCase().includes(term)) {
        return false;
      }
      // Format filter
      if (formatFilter !== "ALL") {
        const media = item.mediaType.toLowerCase();
        if (formatFilter === "PDF" && !media.includes("pdf")) return false;
        if (formatFilter === "EPUB" && !media.includes("epub")) return false;
        if (formatFilter === "MD" && !media.includes("markdown") && !item.fileName.endsWith(".md")) return false;
        if (formatFilter === "TXT" && !media.includes("text/plain") && !item.fileName.endsWith(".txt")) return false;
      }
      // Status filter
      if (statusFilter !== "ALL") {
        if (processingDisplay(item.processing, item.errorCode).group !== statusFilter) return false;
      }
      return true;
    });
  }, [visibleItems, search, formatFilter, statusFilter]);

  return (
    <div>
      <PageHeader title="知识库" description="原书、解析状态与深度理解都在这里。" />

      {/* Top Upload Banner (添加新文献) */}
      <section id="upload">
        <UploadPanel />
      </section>

      <div className="library-state-summary" aria-label="书籍处理概况">
        {([['READY', '理解完成'], ['ACTIVE', '处理中'], ['WAITING', '等待处理'], ['ATTENTION', '需要处理']] as const).map(([group, label]) => (
          <button key={group} type="button" aria-pressed={statusFilter === group} onClick={() => setStatusFilter(statusFilter === group ? "ALL" : group)}>
            <span>{label}</span><strong>{counts[group]}</strong>
          </button>
        ))}
      </div>

      {/* Filter & Search Bar */}
      <form className="filter-bar" action="/studio/library" method="get">
        <div className="search-input-wrapper">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="input-control input-control-search font-serif"
            name="q" aria-label="搜索书名或文件名"
            placeholder="搜索书名或文件名…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select name="format" aria-label="文件格式" className="select-control" value={formatFilter} onChange={(e) => setFormatFilter(e.target.value)}>
          <option value="ALL">所有格式</option>
          <option value="PDF">PDF</option>
          <option value="EPUB">EPUB</option>
          <option value="MD">Markdown (.md)</option>
          <option value="TXT">纯文本 (.txt)</option>
        </select>

        <select name="status" aria-label="处理状态" className="select-control" value={serverStatus} onChange={(e) => setServerStatus(e.target.value)}>
          <option value="ALL">所有状态</option>
          <option value="SUCCEEDED">理解完成</option>
          <option value="PROCESSING">处理中</option>
          <option value="FAILED">失败</option>
        </select>
        <button type="submit" className="btn btn-secondary">搜索与筛选</button>
        <button type="button" className="btn btn-secondary" onClick={() => router.refresh()}>刷新状态</button>
      </form>
      <p className="muted library-results" aria-live="polite">本页显示 {filteredItems.length} / {visibleItems.length} 本书 · 正文提取与 AI 理解分别记录</p>

      {deleteMessage && <p role="status" className="muted">{deleteMessage}</p>}
      {deleting && <LibraryDeleteDialog key={deleting.id} item={deleting} onClose={() => setDeleting(null)} onDeleted={ids => { setRemovedIds(previous => new Set([...previous, ...ids])); setDeleteMessage(`已从知识库删除《${deleting.title}》。`); router.refresh(); }} />}
      {/* Book Cards Grid (3 Columns) */}
      <div className="cards-grid-3">
        {filteredItems.map((x) => {
          return <SourceCard key={x.id} {...x} onDelete={canDelete ? () => { setDeleteMessage(""); setDeleting(x); } : undefined} />;
        })}
      </div>

      {!filteredItems.length && (
        <div className="card-panel" style={{ textAlign: "center", padding: "48px 24px" }}>
          <p style={{ color: "var(--outline)", margin: 0, fontSize: 15 }}>
            {visibleItems.length || query.q || query.format || query.status ? "没有匹配当前搜索和筛选条件的书籍。" : page > 1 ? "这一页没有书籍，请返回上一页。" : "上传第一本书，开始构建你的知识库。"}
          </p>
        </div>
      )}
    </div>
  );
}
