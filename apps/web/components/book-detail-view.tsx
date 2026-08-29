"use client";

import Link from "next/link";
import { useState } from "react";
import { StatusBadge } from "./status-badge";
import { SourceProcessing } from "./source-processing";

const categoryNames: Record<string, string> = {
  SUMMARY: "核心观点",
  CONCEPT: "关键概念",
  ARGUMENT: "主要论证",
  CLAIM: "重要证据",
  QUESTION: "质疑焦点",
  COUNTERPOINT: "反面视角",
  EXAMPLE: "案例阐释",
  STORY: "叙事隐喻",
  QUOTE: "重要引用",
};

type EvidenceItemData = {
  id: string;
  startOffset: number;
  endOffset: number;
  sourceBlock: {
    id: string;
    text: string;
    ordinal: number;
    structureNodeId?: string | null;
  };
};

type MemoryItemData = {
  id: string;
  type: string;
  content: string;
  ordinal: number;
  evidence: EvidenceItemData[];
};

type StructureNodeData = {
  id: string;
  title?: string | null;
  kind: string;
  ordinal: number;
};

type Props = {
  item: {
    id: string;
    displayName: string;
    mediaType: string;
    version: number;
    hasIntelligence: boolean;
    ingestionStatus: string;
    analysisStatus?: string | null;
    errorCode?: string | null;
  };
  memories: MemoryItemData[];
  structureNodes: StructureNodeData[];
};

export function BookDetailView({ item, memories, structureNodes }: Props) {
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);

  // Flatten evidence items from memories for right pane display
  const allEvidence = memories.flatMap((m) =>
    m.evidence.map((e) => {
      const node = structureNodes.find((n) => n.id === e.sourceBlock.structureNodeId);
      return {
        ...e,
        memoryType: m.type,
        memoryContent: m.content,
        nodeTitle: node?.title ?? node?.kind ?? null,
      };
    })
  );

  function highlightEvidence(evidenceId: string) {
    setActiveEvidenceId(evidenceId);
    const element = document.getElementById(`evidence-${evidenceId}`);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  return (
    <div className="book-detail-layout">
      {/* Left Pane: System Interpretation (系统解读) */}
      <div className="interpretation-pane">
        <div className="page-eyebrow">系统解读</div>
        <h1 className="font-serif" style={{ fontSize: 32, fontWeight: 600, color: "var(--on-surface)", margin: "0 0 20px 0" }}>
          {item.displayName}
        </h1>

        {item.hasIntelligence && (
          <div style={{ display: "flex", gap: 12, marginBottom: 32 }}>
            <Link href={`/studio/podcasts/new?source=${item.id}`} className="btn btn-secondary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              </svg>
              生成播客
            </Link>
            <Link href={`/studio/videos/new?source=${item.id}`} className="btn btn-secondary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
              生成短视频
            </Link>
          </div>
        )}

        {/* Processing State */}
        {!item.hasIntelligence && (
          <div className="card-panel" style={{ marginBottom: 32 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <span className="section-title">处理状态</span>
              <StatusBadge value={item.analysisStatus === "FAILED" ? "失败" : item.ingestionStatus === "SUCCEEDED" ? "处理中" : "等待处理"} />
            </div>
            <SourceProcessing
              sourceDocumentId={item.id}
              ingestionStatus={item.ingestionStatus}
              analysisStatus={item.analysisStatus}
              errorCode={item.errorCode}
            />
          </div>
        )}

        {/* Memory Items Cards - Fully Keyboard Accessible Buttons */}
        {memories.map((memory) => {
          const firstEvidence = memory.evidence[0];
          const linkedNode = firstEvidence ? structureNodes.find((n) => n.id === firstEvidence.sourceBlock.structureNodeId) : null;

          return (
            <button
              type="button"
              key={memory.id}
              className="memory-card"
              style={{ width: "100%", textAlign: "left", display: "block" }}
              onClick={() => {
                if (firstEvidence) highlightEvidence(firstEvidence.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (firstEvidence) highlightEvidence(firstEvidence.id);
                }
              }}
              aria-label={`查看 ${categoryNames[memory.type] ?? "解读点"} 对应的原文证据`}
            >
              <div style={{ fontSize: 11, color: "var(--outline)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>
                {categoryNames[memory.type] ?? "BOOK MEMORY"}
              </div>
              <h3 className="memory-card-title">{categoryNames[memory.type] ?? "解读点"}</h3>
              <p className="memory-card-body">{memory.content}</p>

              <div className="memory-meta-box">
                <div className="meta-field">
                  <span className="meta-label">结构节点 / Node</span>
                  <span className="meta-value">{linkedNode?.title ?? linkedNode?.kind ?? "--"}</span>
                </div>
                <div className="meta-field">
                  <span className="meta-label">来源区块 / Block</span>
                  <span className="meta-value">{firstEvidence ? `#${firstEvidence.sourceBlock.ordinal + 1}` : "--"}</span>
                </div>
                <div className="meta-field" style={{ gridColumn: "span 2", marginTop: 4 }}>
                  <span className="meta-label">字符范围 / Offset</span>
                  <span className="meta-value">
                    {firstEvidence ? (
                      <span className="meta-badge">{`${firstEvidence.startOffset}-${firstEvidence.endOffset}`}</span>
                    ) : (
                      "--"
                    )}
                  </span>
                </div>
              </div>
            </button>
          );
        })}

        {!memories.length && item.hasIntelligence && (
          <div className="card-panel">
            <p style={{ color: "var(--outline)", margin: 0 }}>分析已完成，等待呈现解读点。</p>
          </div>
        )}
      </div>

      {/* Right Pane: Source Evidence (原文证据 - Parchment Surface) */}
      <div className="evidence-pane">
        <div className="evidence-header">
          <h2 className="evidence-title">原文证据</h2>
        </div>

        <div className="evidence-timeline">
          {allEvidence.map((ev) => {
            const excerpt = ev.sourceBlock.text.slice(ev.startOffset, ev.endOffset) || ev.sourceBlock.text;
            const isHighlighted = activeEvidenceId === ev.id;

            return (
              <div
                key={ev.id}
                id={`evidence-${ev.id}`}
                className={`evidence-item ${isHighlighted ? "highlighted active" : ""}`}
                tabIndex={0}
                onClick={() => setActiveEvidenceId(ev.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveEvidenceId(ev.id);
                  }
                }}
              >
                <div className="evidence-node-dot" />
                <blockquote className="evidence-text">“{excerpt}”</blockquote>
                <div className="evidence-meta">
                  {ev.nodeTitle ? `${ev.nodeTitle} · ` : ""}
                  区块 #{ev.sourceBlock.ordinal + 1} · 字符 offset {ev.startOffset}-{ev.endOffset}
                </div>
              </div>
            );
          })}

          {!allEvidence.length && (
            <div style={{ color: "#787774", fontSize: 14 }}>
              暂无可展示的原文证据。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
