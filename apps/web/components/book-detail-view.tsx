"use client";

import Link from "next/link";
import { useState } from "react";
import { StatusBadge } from "./status-badge";
import { ProductIdentityPanel } from "./product-identity-panel";
import { SourceProcessing } from "./source-processing";
import type { ProcessingStage, ProcessingWorkerAvailability, RecoveryAction, WorkerAvailability } from "@/lib/processing-state";
import { cognitionTypeLabels } from "@/lib/cognitions";

const categoryNames: Record<string, string> = cognitionTypeLabels;

const cognitionTypes = new Set(["SUMMARY", "CONCEPT", "ARGUMENT", "CLAIM", "QUOTE", "QUESTION", "COUNTERPOINT", "EXAMPLE", "STORY"]);

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
    title: string;
    titleOrigin: "WORK" | "FILENAME";
    isLatestVersion: boolean;
    mediaType: string;
    version: number;
    hasIntelligence: boolean;
    extractionSummary?: { pages: number; blocks: number; characters?: number | null } | null;
    ingestionStatus?: string | null;
    analysisStatus?: string | null;
    bootstrapStatus?: string | null;
    errorCode?: string | null;
    processingState: string;
    processingStage: ProcessingStage;
    recoveryAction: RecoveryAction;
    stageAvailability: WorkerAvailability;
    workerAvailability: WorkerAvailability | ProcessingWorkerAvailability;
    processingSince?: string | null;
  };
  memories: MemoryItemData[];
  structureNodes: StructureNodeData[];
  textPreview?: { pageNumber: number; pageCount: number; physicalPageNumber: number | null; truncated: boolean; blocks: Array<{ id: string; ordinal: number; text: string }> } | null;
};

export function BookDetailView({ item, memories, structureNodes, textPreview }: Props) {
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
          {item.title}
        </h1>
        <p style={{ color: "var(--text-secondary)", margin: "0 0 16px 0", fontSize: 13, overflowWrap: "anywhere" }}>
          原文件：{item.displayName} · 文件版本 v{item.version}
          {!item.isLatestVersion && " · 历史版本（显示所属书籍当前正式书名）"}
        </p>

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

        {item.extractionSummary && (
          <section className="card-panel" style={{ marginBottom: 20 }} aria-label="文本提取结果">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <span className="section-title">文本提取</span><StatusBadge value="提取完成" />
            </div>
            <p>正文已识别，可在右侧查看原文。</p>
            <p className="muted">{item.extractionSummary.pages ? `${item.extractionSummary.pages} 页 · ` : ""}{item.extractionSummary.characters != null ? `${item.extractionSummary.characters.toLocaleString("zh-CN")} 个字符` : `${item.extractionSummary.blocks} 个文本区块`}</p>
          </section>
        )}

        {/* Processing State */}
        {!item.hasIntelligence && (
          <div className="card-panel" style={{ marginBottom: 32 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <span className="section-title">{item.extractionSummary ? "AI 深度理解" : "处理状态"}</span>
              <StatusBadge value={item.extractionSummary && item.processingStage === "BOOK_ANALYSIS" && item.stageAvailability === "DEGRADED" && ["ANALYSIS_QUEUED", "WAITING_FOR_ANALYSIS"].includes(item.processingState) ? "等待服务" : item.processingState === "WAITING_FOR_PROVIDER" ? "待配置 AI" : item.processingState === "SUCCEEDED" ? "完成" : item.processingState.includes("FAILED") ? "失败" : item.processingState === "PROCESSING_DEGRADED" ? "需处理" : "处理中"} />
            </div>
            <SourceProcessing
              sourceDocumentId={item.id}
              ingestionStatus={item.ingestionStatus}
              analysisStatus={item.analysisStatus}
              bootstrapStatus={item.bootstrapStatus}
              errorCode={item.errorCode}
              processingState={item.processingState}
              processingStage={item.processingStage}
              recoveryAction={item.recoveryAction}
              stageAvailability={item.stageAvailability}
              workerAvailability={item.workerAvailability}
              processingSince={item.processingSince}
            />
          </div>
        )}

        {item.mediaType === "application/epub+zip" && (
          <ProductIdentityPanel key={item.id} sourceDocumentId={item.id} sourceFileName={item.displayName} />
        )}

        {/* Memory Items Cards - Fully Keyboard Accessible Buttons */}
        {memories.map((memory) => {
          const firstEvidence = memory.evidence[0];
          const linkedNode = firstEvidence ? structureNodes.find((n) => n.id === firstEvidence.sourceBlock.structureNodeId) : null;

          return (
            <article
              key={memory.id}
              className="memory-card"
            >
              <button
                type="button"
                style={{ width: "100%", textAlign: "left", display: "block", appearance: "none", background: "transparent", border: 0, padding: 0, color: "inherit", font: "inherit", cursor: "pointer" }}
                onClick={() => {
                  if (firstEvidence) highlightEvidence(firstEvidence.id);
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
              {cognitionTypes.has(memory.type) ? (
                <Link href={`/studio/cognitions/${memory.id}`} className="btn btn-secondary">
                  查看认知详情
                </Link>
              ) : null}
            </article>
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
          <h2 className="evidence-title">{!allEvidence.length && textPreview ? "原文预览" : "原文证据"}</h2>
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

          {!allEvidence.length && textPreview && (
            <section aria-label="已提取原文">
              <p className="muted">物理页 {textPreview.physicalPageNumber ?? textPreview.pageNumber} / {textPreview.pageCount} · 来自已完成的正式提取</p>
              <nav aria-label="原文翻页" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
                {textPreview.pageNumber > 1 && <Link prefetch={false} href={`/studio/library/${item.id}?textPage=${textPreview.pageNumber - 1}`} scroll={false} className="btn btn-secondary">上一页</Link>}
                <form key={textPreview.pageNumber} method="get" action={`/studio/library/${item.id}`} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <label htmlFor="text-page">页码</label>
                  <input id="text-page" name="textPage" type="number" min="1" max={textPreview.pageCount} defaultValue={textPreview.pageNumber} required style={{ width: 72, padding: 8 }} />
                  <button className="btn btn-secondary" type="submit">跳转</button>
                </form>
                {textPreview.pageNumber < textPreview.pageCount && <Link prefetch={false} href={`/studio/library/${item.id}?textPage=${textPreview.pageNumber + 1}`} scroll={false} className="btn btn-secondary">下一页</Link>}
              </nav>
              {textPreview.blocks.map(block => <div key={block.id} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.9, marginBottom: 20 }}>{block.text}</div>)}
              {!textPreview.blocks.length && <p>本页没有提取到文字。</p>}
              {textPreview.truncated && <p className="muted">本页内容较长，当前显示部分原文。</p>}
            </section>
          )}
          {!allEvidence.length && !textPreview && (
            <div style={{ color: "#787774", fontSize: 14 }}>
              暂无可展示的原文证据。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}