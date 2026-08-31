import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { resolveWebIdentity } from "@/lib/identity";
import { listThinkingSessions } from "@/lib/thinking";

export default async function ThinkingPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const [identity, query] = await Promise.all([resolveWebIdentity(), searchParams]);
  const result = await listThinkingSessions(identity, { cursor: query.cursor });
  return <div><PageHeader eyebrow="THINKING NOTEBOOK" title="思考" description="从一个固定版本的认知出发，留下自己的推理轨迹。" />{result.items.length ? <div style={{ display: "grid", gap: 12 }}>{result.items.map(session => <Link key={session.id} href={`/studio/thinking/${session.id}`} className="card-panel" style={{ color: "inherit", textDecoration: "none" }}><div className="meta-badge">{session.status === "ACTIVE" ? "进行中" : "已结束"}</div><h2 className="font-serif" style={{ fontSize: 22 }}>{session.memoryItem.content.slice(0, 140)}</h2><p style={{ color: "var(--outline)" }}>{session.memoryItem.type} · {session.sourceTitle} · 更新于 {session.updatedAt.toLocaleString("zh-CN")}</p></Link>)}</div> : <div className="card-panel">还没有思考会话。先从“我的认知”中打开一条当前认知。</div>}{result.nextCursor ? <Link className="btn btn-secondary" style={{ marginTop: 20 }} href={`/studio/thinking?cursor=${result.nextCursor}`}>继续浏览</Link> : null}</div>;
}
