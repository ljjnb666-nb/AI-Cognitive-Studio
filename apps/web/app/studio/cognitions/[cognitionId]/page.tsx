import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app-shell";
import { CognitionSaveButton } from "@/components/cognition-save-button";
import { cognitionDetail, cognitionTypeLabels } from "@/lib/cognitions";
import { resolveWebIdentity } from "@/lib/identity";

export default async function CognitionDetailPage({ params }: { params: Promise<{ cognitionId: string }> }) {
  const { cognitionId } = await params;
  const identity = await resolveWebIdentity();
  const cognition = await cognitionDetail(identity, cognitionId);
  if (!cognition) notFound();
  return (
    <div>
      <PageHeader eyebrow={cognitionTypeLabels[cognition.type]} title="认知详情" description={cognition.sourceTitle} />
      <article className="card-panel" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
          <div><div className="meta-badge" style={{ marginBottom: 12 }}>{cognitionTypeLabels[cognition.type]}</div><p className="font-serif" style={{ whiteSpace: "pre-wrap", fontSize: 26, lineHeight: 1.55, margin: 0 }}>{cognition.content}</p></div>
          <CognitionSaveButton cognitionId={cognition.id} initialSaved={cognition.saved} />
        </div>
      </article>
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
