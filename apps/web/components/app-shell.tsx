import Link from "next/link";

const links = [["/studio", "首页"], ["/studio/library", "知识库"], ["/studio/podcasts", "播客"], ["/studio/videos", "短视频"], ["/studio/activity", "任务记录"]] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  return <div className="shell"><aside className="sidebar"><Link className="brand" href="/studio">认知内容工作室</Link><nav aria-label="主导航">{links.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}</nav></aside><main className="content">{children}</main><nav className="mobile-nav" aria-label="移动导航">{links.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}</nav></div>;
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">AI COGNITIVE STUDIO</p><h1>{title}</h1>{description && <p className="muted">{description}</p>}</div>{action}</header>;
}

export function Status({ value }: { value: string }) { return <span className="status"><i aria-hidden="true" />{value}</span>; }
