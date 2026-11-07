"use client";
import { processingDisplay } from "@/lib/processing-display";
import type { ProcessingState } from "@/lib/processing-state";


import Link from "next/link";
import { useState } from "react";
import { StatusBadge } from "./status-badge";
import { ProductIdentityPanel } from "./product-identity-panel";
import { SourceTextReader, type SourceTextPreview } from "./source-text-reader";
import { SourceProcessing } from "./source-processing";
import type { BookAnalysisProgress } from "@/lib/book-analysis-progress";
import type { ProcessingStage, ProcessingWorkerAvailability, RecoveryAction, WorkerAvailability } from "@/lib/processing-state";
import { isBibliographicMemory } from "@/lib/bibliographic-memory";
import { cognitionTypeLabels } from "@/lib/cognition-types";

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
  bookSummary?: string | null;
  textPreview?: SourceTextPreview | null;
  item: {
    id: string;
    displayName: string;
    title: string;
    titleOrigin: "WORK" | "FILENAME";
    isLatestVersion: boolean;
    mediaType: string;
    version: number;
    hasIntelligence: boolean;
    extractionSummary?: {pages:number; blocks:number; characters?:number|null;notes?:string[]}|null;
    currentExtractionId?: string | null;
    failureReason?: string;
    ingestionStatus?: string | null;
    analysisStatus?: string | null;
    analysisProgress?: BookAnalysisProgress | null;
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
};

export function BookDetailView({ item, memories, structureNodes, bookSummary, textPreview }: Props) {
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const [view, setView] = useState<"overview" | "source">(textPreview ? "source" : "overview");
  const display = processingDisplay({state: item.processingState as ProcessingState, stage:item.processingStage,recoveryAction:item.recoveryAction,stageAvailability:item.stageAvailability,failureReason:item.failureReason},item.errorCode);

  const bookFacts = memories.filter((memory) => isBibliographicMemory(memory.content));
  const insights = memories.filter((memory) => !isBibliographicMemory(memory.content));

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
    setView("source");
    requestAnimationFrame(() => document.getElementById(`evidence-${evidenceId}`)?.scrollIntoView({ behavior: "instant", block: "nearest", inline: "start" }));
  }

  return (
    <div className="book-detail-layout">
      <div className="book-view-tabs" role="group" aria-label="书籍视图">
        <span title={item.title}>{item.title}</span>
        <button type="button" className="btn btn-secondary" aria-pressed={view === "overview"} onClick={() => setView("overview")}>书籍概览</button>
        <button type="button" className="btn btn-secondary" aria-pressed={view === "source"} onClick={() => setView("source")}>原文阅读</button>
      </div>
      {/* Left Pane: System Interpretation (系统解读) */}
      <div className="interpretation-pane" hidden={view !== "overview"}>
        <div className="page-eyebrow">系统解读</div>
        <h1 className="font-serif" style={{ fontSize: 32, fontWeight: 600, color: "var(--on-surface)", margin: "0 0 20px 0" }}>
          {item.title}
        </h1>
        <p style={{ color: "var(--text-secondary)", margin: "0 0 16px 0", fontSize: 13, overflowWrap: "anywhere" }}>
          原文件：{item.displayName} · 文件版本 v{item.version}
          {!item.isLatestVersion && " · 历史版本（显示所属书籍当前正式书名）"}
        </p>
        <div className="book-state-heading"><StatusBadge value={display.label} tone={display.tone} /><span>以当前保存的处理结果为准</span></div>

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
              <StatusBadge value={display.label} tone={display.tone} />
            </div>
            <SourceProcessing
              sourceDocumentId={item.id}
              ingestionStatus={item.ingestionStatus}
              analysisStatus={item.analysisStatus}
              analysisProgress={item.analysisProgress}
              bootstrapStatus={item.bootstrapStatus}
              errorCode={item.errorCode}
              failureReason={item.failureReason}
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
          // A newly published extraction invalidates the old advisory preview
          // and any confirmation dialog based on that previous extraction.
          <ProductIdentityPanel key={`${item.id}:${item.currentExtractionId ?? "pending"}`} sourceDocumentId={item.id} sourceFileName={item.displayName} />
        )}

        {/* The full-book synthesis is projected by sourceDetail from the
            published revision, not from an unpublished candidate or raw run. */}
        {bookSummary && (
          <section className="card-panel" aria-label="全书摘要">
            <h2 className="font-serif">全书摘要</h2>
            <p>{bookSummary}</p>
          </section>
        )}

        {/* Memory Items Cards - Fully Keyboard Accessible Buttons */}
        {bookFacts.length > 0 && (
          <section className="card-panel" aria-label="书籍资料">
            <h2>书籍资料</h2>
            <ul>
              {bookFacts.map((memory) => (
                <li key={memory.id}>
                  <p>{memory.content}</p>
                  {memory.evidence[0] && (
                    <button type="button" className="btn btn-secondary" onClick={() => highlightEvidence(memory.evidence[0]!.id)}>
                      查看资料原文
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {insights.map((memory) => {
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
                  {categoryNames[memory.type] ?? "解读点"}
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

        {!insights.length && item.hasIntelligence && (
          <div className="card-panel">
            <p style={{ color: "var(--outline)", margin: 0 }}>分析已完成，等待呈现解读点。</p>
          </div>
        )}
      </div>

      {/* Right Pane: Source Evidence (原文证据 - Parchment Surface) */}
      <div className="evidence-pane" hidden={view !== "source"}>
        <div className="evidence-header">
          <h2 className="evidence-title">{textPreview ? "原文预览" : "原文证据"}</h2>
        </div>

        {textPreview && <SourceTextReader sourceDocumentId={item.id} preview={textPreview} />}
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
                  区块 #{ev.sourceBlock.ordinal + 1} · 字符位置 {ev.startOffset}-{ev.endOffset}
                </div>
              </div>
            );
          })}

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
