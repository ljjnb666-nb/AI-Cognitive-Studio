import { ListPagination, listPage } from "@/components/list-pagination";
import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { podcastList } from "@/lib/product";

export default async function PodcastsPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const page = listPage((await searchParams).page);
  const records = await podcastList(undefined, { page, pageSize: 20, lookahead: true });
  const podcasts = records.slice(0, 20);

  return (
    <div>
      <PageHeader
        title="播客"
        description="以原书证据为基础的多主持人对话。"
        action={
          <Link className="btn btn-primary" href="/studio/podcasts/new">
            生成播客
          </Link>
        }
      />

      <div className="cards-grid-2">
        {podcasts.map((p) => (
          <Link key={p.id} href={p.href} className="card-panel card-panel-interactive" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 140 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <span className="font-mono" style={{ fontSize: 11, color: "var(--outline)", textTransform: "uppercase" }}>
                  播客节目
                </span>
                <StatusBadge value={p.statusText} />
              </div>
              <h3 className="font-serif" style={{ fontSize: 18, fontWeight: 600, color: "var(--on-surface)", margin: 0 }}>
                {p.title}
              </h3>
            </div>
            <div style={{ fontSize: 12, color: "var(--outline)", marginTop: 16 }}>
              {new Date(p.createdAt).toLocaleDateString("zh-CN")}
            </div>
          </Link>
        ))}
      </div>

      {!podcasts.length && (
        <div className="card-panel" style={{ textAlign: "center", padding: "48px 24px" }}>
          <p style={{ color: "var(--outline)", margin: 0, fontSize: 15 }}>
            暂无播客节目。选择已完成理解的书，即可开始生成播客。
          </p>
        </div>
      )}
      <ListPagination page={page} hasNext={records.length > 20} path="/studio/podcasts" />
    </div>
  );
}
