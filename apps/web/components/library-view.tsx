"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "./page-header";
import { UploadPanel } from "./upload-panel";
import { SourceCard } from "./source-card";
import { statusLabel } from "@/lib/product-labels";
import type { SourceSummary } from "@/lib/product";

export function LibraryView({ items }: { items: SourceSummary[] }) {
  const [search, setSearch] = useState("");
  const [formatFilter, setFormatFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      // Search title
      if (search.trim() && !item.title.toLowerCase().includes(search.trim().toLowerCase())) {
        return false;
      }
      // Format filter
      if (formatFilter !== "ALL") {
        const media = item.mediaType.toLowerCase();
        if (formatFilter === "PDF" && !media.includes("pdf")) return false;
        if (formatFilter === "EPUB" && !media.includes("epub")) return false;
        if (formatFilter === "MD" && !media.includes("markdown") && !item.title.endsWith(".md")) return false;
        if (formatFilter === "TXT" && !media.includes("text/plain") && !item.title.endsWith(".txt")) return false;
      }
      // Status filter
      if (statusFilter !== "ALL") {
        const text = item.hasIntelligence ? "理解完成" : statusLabel(item.status, item.errorCode);
        if (statusFilter === "SUCCEEDED" && text !== "理解完成") return false;
        if (statusFilter === "PROCESSING" && text !== "处理中") return false;
        if (statusFilter === "FAILED" && text !== "失败") return false;
      }
      return true;
    });
  }, [items, search, formatFilter, statusFilter]);

  return (
    <div>
      <PageHeader title="知识库" description="原书、解析状态与深度理解都在这里。" />

      {/* Top Upload Banner (添加新文献) */}
      <section id="upload">
        <UploadPanel />
      </section>

      {/* Filter & Search Bar */}
      <div className="filter-bar">
        <div className="search-input-wrapper">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="input-control input-control-search font-serif"
            placeholder="搜索标题..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select className="select-control" value={formatFilter} onChange={(e) => setFormatFilter(e.target.value)}>
          <option value="ALL">所有格式</option>
          <option value="PDF">PDF</option>
          <option value="EPUB">EPUB</option>
          <option value="MD">Markdown (.md)</option>
          <option value="TXT">纯文本 (.txt)</option>
        </select>

        <select className="select-control" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="ALL">所有状态</option>
          <option value="SUCCEEDED">理解完成</option>
          <option value="PROCESSING">处理中</option>
          <option value="FAILED">失败</option>
        </select>
      </div>

      {/* Book Cards Grid (3 Columns) */}
      <div className="cards-grid-3">
        {filteredItems.map((x) => {
          const statusText = x.hasIntelligence ? "理解完成" : statusLabel(x.status, x.errorCode);
          return <SourceCard key={x.id} {...x} statusText={statusText} />;
        })}
      </div>

      {!filteredItems.length && (
        <div className="card-panel" style={{ textAlign: "center", padding: "48px 24px" }}>
          <p style={{ color: "var(--outline)", margin: 0, fontSize: 15 }}>
            {items.length ? "没有匹配当前搜索和筛选条件的书籍。" : "上传第一本书，开始构建你的知识库。"}
          </p>
        </div>
      )}
    </div>
  );
}
