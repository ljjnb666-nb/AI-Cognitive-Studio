import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app-shell";
import { CognitionSaveButton } from "@/components/cognition-save-button";
import { StartThinkingButton } from "@/components/start-thinking-button";
import { cognitionDetail, cognitionTypeLabels } from "@/lib/cognitions";
import { resolveWebIdentity } from "@/lib/identity";
import { latestTeachBackForCognition } from "@/lib/teach-back";

export default async function CognitionDetailPage({ params }: { params: Promise<{ cognitionId: string }> }) {
  const { cognitionId } = await params;
  const identity = await resolveWebIdentity();
  const cognition = await cognitionDetail(identity, cognitionId);
  if (!cognition) notFound();
  const latest = await latestTeachBackForCognition(identity, cognition.id);
  return (
    <div>
      <PageHeader eyebrow={cognitionTypeLabels[cognition.type]} title="认知详情" description={cognition.sourceTitle} />
      <article className="card-panel" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
          <div><div className="meta-badge" style={{ marginBottom: 12 }}>{cognitionTypeLabels[cognition.type]}</div><p className="font-serif" style={{ whiteSpace: "pre-wrap", fontSize: 26, lineHeight: 1.55, margin: 0 }}>{cognition.content}</p></div>
          <CognitionSaveButton cognitionId={cognition.id} initialSaved={cognition.saved} />
        </div>
      </article>
      <section className="card-panel" style={{ marginBottom: 24 }}><h2 className="section-title">思考引导</h2><p style={{ color: "var(--outline)" }}>从这个认知开始一次属于你的追问，而不是再读一遍摘要。</p><StartThinkingButton memoryItemId={cognition.id} /></section>
      <section className="card-panel" style={{ marginBottom: 24 }}><h2 className="section-title">复述理解</h2><p style={{ color: "var(--outline)" }}>{latest?.assessment ? `最近一次：${latest.assessment.masteryState === "DEMONSTRATED" ? "已表现出理解" : latest.assessment.masteryState === "DEVELOPING" ? "正在形成" : "需要再梳理"}` : "还没有复述这条认知。"}</p><Link className="btn btn-primary" href={`/studio/cognitions/${cognition.id}/teach-back`}>用自己的话讲一遍</Link></section>
      <section className="card-panel" style={{ marginBottom: 24 }}>
        <h2 className="section-title">来源书籍</h2>
        <Link href={`/studio/library/${cognition.sourceDocumentId}`}>{cognition.sourceTitle}</Link>
      </section>
      <section className="card-panel" style={{ marginBottom: 24 }}>
        <h2 className="section-title">来源证据</h2>
        {cognition.evidence.length ? <div style={{ display: "grid", gap: 16 }}>{cognition.evidence.map((evidence) => <blockquote key={evidence.id} style={{ borderLeft: "2px solid var(--outline)", paddingLeft: 16, margin: 0 }}><p className="font-serif" style={{ margin: "0 0 8px", whiteSpace: "pre-wrap" }}>“{evidence.excerpt}”</p><footer style={{ color: "var(--outline)", fontSize: 12 }}>来源区块 #{evidence.blockOrdinal + 1}</footer></blockquote>)}</div> : <p style={{ margin: 0, color: "var(--outline)" }}>暂无可验证来源证据</p>}
      </section>
      {cognition.related.length ? <section className="card-panel"><h2 className="section-title">相关认知</h2><div style={{ display: "grid", gap: 10 }}>{cognition.related.map((item) => <Link key={item.id} href={`/studio/cognitions/${item.id}`}><span className="meta-badge">{cognitionTypeLabels[item.type]}</span>　{item.content}</Link>)}</div></section> : null}
    </div>
  );
}
