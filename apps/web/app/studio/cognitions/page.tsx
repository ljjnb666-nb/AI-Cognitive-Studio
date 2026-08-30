import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { cognitionTypeLabels, isCognitionType, listCognitions, type CognitionType } from "@/lib/cognitions";
import { resolveWebIdentity } from "@/lib/identity";

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

export default async function CognitionsPage({ searchParams }: { searchParams: Promise<{ filter?: string | string[]; cursor?: string | string[] }> }) {
  const query = await searchParams;
  const selected = filters.find((filter) => filter.key === stringValue(query.filter)) ?? filters[0]!;
  const identity = await resolveWebIdentity();
  const result = await listCognitions(identity, { types: selected.types, cursor: stringValue(query.cursor), pageSize: 24 });

  return (
    <div>
      <PageHeader eyebrow="COMMONPLACE BOOK" title="我的认知" description="从已完成理解分析的书籍中，回看可追溯的观点、概念与证据。" />
      <nav aria-label="认知类型筛选" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 28 }}>
        {filters.map((filter) => (
          <Link key={filter.key} href={filter.key === "all" ? "/studio/cognitions" : `/studio/cognitions?filter=${filter.key}`} className={filter.key === selected.key ? "btn btn-primary" : "btn btn-secondary"}>
            {filter.label}
          </Link>
        ))}
      </nav>
      {!result.items.length ? (
        <div className="card-panel"><p style={{ margin: 0, color: "var(--outline)" }}>还没有认知内容。先在知识库中添加并完成一本书的理解分析。</p></div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {result.items.map((item) => (
            <article key={item.id} className="card-panel" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
                <span className="meta-badge">{cognitionTypeLabels[item.type]}</span>
                {item.saved ? <span style={{ fontSize: 12, color: "var(--outline)" }}>已保存</span> : null}
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
      {result.nextCursor ? (
        <div style={{ marginTop: 24 }}><Link className="btn btn-secondary" href={`/studio/cognitions?${new URLSearchParams({ ...(selected.key === "all" ? {} : { filter: selected.key }), cursor: result.nextCursor })}`}>继续浏览</Link></div>
      ) : null}
    </div>
  );
}
