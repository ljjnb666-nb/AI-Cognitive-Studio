import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { cognitionTypeLabels, isCognitionType, listCognitions, type CognitionType } from "@/lib/cognitions";
import { resolveWebIdentity } from "@/lib/identity";
import { CognitionReviewButton } from "@/components/cognition-review-button";
import { getPersonalCognitionCorpus, getPersonalCognitionOverview, getPersonalWeakPoints, getRecommendedReviews } from "@/lib/personalized-cognition";
import { displayMastery, rubricLabel } from "@/lib/studio-display";

const filters: Array<{ key: string; label: string; types?: CognitionType[] }> = [
  { key: "all", label: "全部" },
  { key: "summary", label: "核心观点", types: ["SUMMARY"] },
  { key: "concept", label: "关键概念", types: ["CONCEPT"] },
  { key: "argument", label: "主要论证", types: ["ARGUMENT"] },
  { key: "evidence", label: "重要证据", types: ["CLAIM", "QUOTE"] },
  { key: "question", label: "值得质疑", types: ["QUESTION", "COUNTERPOINT"] },
];

function stringValue(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

const reasonLabel = { WEAK_MASTERY: "需要重新梳理", DEVELOPING_MASTERY: "还在形成", UNASSESSED: "还没有复述验证", OVERDUE: "已到复习时间", MAINTAIN_MASTERY: "保持理解", REVIEW_SOON: "即将复习" } as const;
function masteryText(value: string) { return displayMastery(value); }

export default async function CognitionsPage({ searchParams }: { searchParams: Promise<{ filter?: string | string[]; cursor?: string | string[]; view?: string | string[] }> }) {
  const query = await searchParams;
  const selected = filters.find((filter) => filter.key === stringValue(query.filter)) ?? filters[0]!;
  const identity = await resolveWebIdentity();
  const personal = stringValue(query.view) !== "all";
  const [result, corpus, overview, recommendations, weak] = await Promise.all([listCognitions(identity, { types: selected.types, cursor: stringValue(query.cursor), pageSize: 24 }), personal ? getPersonalCognitionCorpus(identity, { types: selected.types, cursor: stringValue(query.cursor), pageSize: 24 }) : Promise.resolve({ items: [], nextCursor: undefined }), personal ? getPersonalCognitionOverview(identity) : Promise.resolve(null), personal ? getRecommendedReviews(identity, 5) : Promise.resolve([]), personal ? getPersonalWeakPoints(identity) : Promise.resolve(null)]);
  const items = personal ? corpus.items : result.items;

  return (
    <div>
      <PageHeader eyebrow="COMMONPLACE BOOK" title={personal ? "我的认知" : "全部认知"} description={personal ? "这里是你实际保存、思考或复述过的当前认知。" : "浏览工作区内已完成理解分析的当前认知。"} />
      <nav aria-label="认知视图" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}><Link className={personal ? "btn btn-primary" : "btn btn-secondary"} href="/studio/cognitions">我的认知</Link><Link className={!personal ? "btn btn-primary" : "btn btn-secondary"} href="/studio/cognitions?view=all">全部认知</Link></nav>
      {personal && overview ? <section className="card-panel" aria-label="我的认知概览" style={{ marginBottom: 24 }}><h2 className="section-title">我的认知</h2><div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "var(--outline)" }}><span>总认知 {overview.total}</span><span>待复习 {overview.dueNow}</span><span>尚未验证 {overview.unassessed}</span><span>需要复习 {overview.needsReview}</span><span>正在形成 {overview.developing}</span><span>已掌握 {overview.demonstrated}</span></div></section> : null}
      {personal ? <section className="card-panel" aria-label="今天建议复习" style={{ marginBottom: 24 }}><h2 className="section-title">今天建议复习</h2>{recommendations.length ? <div style={{ display: "grid", gap: 12 }}>{recommendations.map(item => <article key={item.id} style={{ display: "grid", gap: 6 }}><div><span className="meta-badge">{cognitionTypeLabels[item.type]}</span>　<span style={{ color: "var(--outline)" }}>{masteryText(item.masteryState)} · {reasonLabel[item.reason]}</span></div><Link href={`/studio/cognitions/${item.id}`}>{item.content}</Link><small style={{ color: "var(--outline)" }}>{item.sourceTitle}{item.overdue ? " · 已到复习时间" : " · 即将复习"}</small><div style={{ display: "flex", gap: 8 }}><Link className="btn btn-secondary" href={`/studio/cognitions/${item.id}`}>查看认知</Link><Link className="btn btn-secondary" href={`/studio/cognitions/${item.id}/teach-back`}>开始复述</Link><CognitionReviewButton cognitionId={item.id} /></div></article>)}</div> : <p style={{ color: "var(--outline)", margin: 0 }}>暂时没有需要复习的认知。</p>}</section> : null}
      {personal && weak ? <section className="card-panel" aria-label="当前薄弱点" style={{ marginBottom: 24 }}><h2 className="section-title">当前薄弱点</h2><p style={{ color: "var(--outline)" }}>{weak.totalWeak ? `有 ${weak.totalWeak} 条认知需要继续梳理。` : "当前没有需要重点梳理的已验证认知。"} {weak.totalUnassessed ? `另有 ${weak.totalUnassessed} 条尚未验证。` : ""}</p>{weak.criteria.map(item => <p key={item.criterionKey} style={{ margin: "6px 0", color: "var(--outline)" }}>有 {item.affectedCognitionCount} 条认知在「{rubricLabel(item.criterionKey)}」这一项尚未达到要求。</p>)}</section> : null}
      <nav aria-label="认知类型筛选" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 28 }}>
        {filters.map((filter) => (
          <Link key={filter.key} href={`/studio/cognitions?${new URLSearchParams({ ...(personal ? {} : { view: "all" }), ...(filter.key === "all" ? {} : { filter: filter.key }) })}`} className={filter.key === selected.key ? "btn btn-primary" : "btn btn-secondary"}>
            {filter.label}
          </Link>
        ))}
      </nav>
      {!items.length ? (
        <div className="card-panel"><p style={{ margin: 0, color: "var(--outline)" }}>还没有认知内容。先在知识库中添加并完成一本书的理解分析。</p></div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {items.map((item) => (
            <article key={item.id} className="card-panel" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
                <span className="meta-badge">{cognitionTypeLabels[item.type]}</span>
                {"masteryState" in item ? <span style={{ fontSize: 12, color: "var(--outline)" }}>{masteryText(String(item.masteryState))}</span> : item.saved ? <span style={{ fontSize: 12, color: "var(--outline)" }}>已保存</span> : null}
              </div>
              <Link href={`/studio/cognitions/${item.id}`} style={{ color: "var(--on-surface)", textDecoration: "none" }}>
                <h2 className="font-serif" style={{ fontSize: 22, margin: 0 }}>{item.content}</h2>
              </Link>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13, color: "var(--outline)" }}>
                <Link href={`/studio/library/${item.sourceDocumentId}`} style={{ color: "inherit" }}>{item.sourceTitle}</Link>
                <span>认知版本</span>
              </div>
            </article>
          ))}
        </div>
      )}
      {(personal ? corpus.nextCursor : result.nextCursor) ? (
        <div style={{ marginTop: 24 }}><Link className="btn btn-secondary" href={`/studio/cognitions?${new URLSearchParams({ ...(personal ? {} : { view: "all" }), ...(selected.key === "all" ? {} : { filter: selected.key }), cursor: personal ? corpus.nextCursor! : result.nextCursor! })}`}>继续浏览</Link></div>
      ) : null}
    </div>
  );
}
