import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app-shell";
import { CognitionSaveButton } from "@/components/cognition-save-button";
import { StartThinkingButton } from "@/components/start-thinking-button";
import { cognitionDetail, cognitionTypeLabels } from "@/lib/cognitions";
import { resolveWebIdentity } from "@/lib/identity";
import { latestTeachBackForCognition } from "@/lib/teach-back";
import { findCrossBookCognitionConnections } from "@/lib/cognition-associations";

export const dynamic = "force-dynamic";

export default async function CognitionDetailPage({
  params,
}: {
  params: Promise<{ cognitionId: string }>;
}) {
  const { cognitionId } = await params;
  const identity = await resolveWebIdentity();
  const cognition = await cognitionDetail(identity, cognitionId);
  if (!cognition) notFound();
  const [latest, connections] = await Promise.all([
    latestTeachBackForCognition(identity, cognition.id),
    findCrossBookCognitionConnections(identity, cognition.id),
  ]);
  return (
    <div>
      <PageHeader
        eyebrow={cognitionTypeLabels[cognition.type]}
        title="认知详情"
        description={cognition.sourceTitle}
      />
      <div className="cognition-detail-layout">
        <div className="cognition-detail-main">
          <article className="card-panel cognition-body-card">
            <div className="cognition-body-header">
              <div className="meta-badge">
                {cognitionTypeLabels[cognition.type]}
              </div>
              <span className="support-copy">{cognition.evidence.length ? "有来源依据" : "未附来源证据"}</span>
              <CognitionSaveButton
                cognitionId={cognition.id}
                initialSaved={cognition.saved}
              />
            </div>
            <h2 className="section-title">认知正文</h2>
            <p className="cognition-body-text">{cognition.content}</p>
          </article>
          <section className="card-panel">
            <h2 className="section-title">来源证据</h2>
            {cognition.evidence.length ? (
              <div className="evidence-timeline">
                {cognition.evidence.map((evidence, index) => (
                  <blockquote
                    key={evidence.id}
                    className={`evidence-item${index === 0 ? " active" : ""}`}
                  >
                    <span className="evidence-node-dot" aria-hidden="true" />
                    <p className="evidence-text font-serif">
                      “{evidence.excerpt}”
                    </p>
                    <footer className="evidence-meta">
                      来源区块 #{evidence.blockOrdinal + 1} · 字符{" "}
                      {evidence.startOffset}–{evidence.endOffset}
                    </footer>
                  </blockquote>
                ))}
              </div>
            ) : (
              <p className="empty-copy">暂无可验证来源证据</p>
            )}
          </section>
        </div>
        <aside className="cognition-detail-support" aria-label="认知支持信息">
          <section className="card-panel">
            <h2 className="section-title">当前理解状态</h2>
            <p className="support-copy">
              {latest?.assessment
                ? `最近一次：${latest.assessment.masteryState === "DEMONSTRATED" ? "已表现出理解" : latest.assessment.masteryState === "DEVELOPING" ? "正在形成" : "需要再梳理"}`
                : cognition.saved
                  ? "已收藏到你的认知库，等待你的思考或复述。"
                  : "尚未收藏到你的认知库。"}
            </p>
          </section>
          <section className="card-panel">
            <h2 className="section-title">思考</h2>
            <p className="support-copy">从这条认知开始一次属于你的追问。</p>
            <StartThinkingButton memoryItemId={cognition.id} />
          </section>
          <section className="card-panel">
            <h2 className="section-title">复述</h2>
            <p className="support-copy">
              用自己的语言检验理解，而不是重读摘要。
            </p>
            <Link
              className="btn btn-primary"
              href={`/studio/cognitions/${cognition.id}/teach-back`}
            >
              用自己的话讲一遍
            </Link>
          </section>
          <section className="card-panel">
            <h2 className="section-title">来源书籍</h2>
            <Link href={`/studio/library/${cognition.sourceDocumentId}`}>
              {cognition.sourceTitle}
            </Link>
          </section>
          <section className="card-panel">
            <h2 className="section-title">跨书关联</h2>
            {connections.length ? (
              <div className="related-list">
                {connections.map((item) => (
                  <Link key={item.id} href={`/studio/cognitions/${item.id}`}>
                    <span className="meta-badge">
                      {cognitionTypeLabels[item.type]}
                    </span>
                    　{item.content}
                    <small>{item.sourceTitle} · 可能相关的认知</small>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="empty-copy">暂无可用的跨书关联。</p>
            )}
          </section>
          {cognition.related.length ? (
            <section className="card-panel">
              <h2 className="section-title">相关认知</h2>
              <div className="related-list">
                {cognition.related.map((item) => (
                  <Link key={item.id} href={`/studio/cognitions/${item.id}`}>
                    <span className="meta-badge">
                      {cognitionTypeLabels[item.type]}
                    </span>
                    　{item.content}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
