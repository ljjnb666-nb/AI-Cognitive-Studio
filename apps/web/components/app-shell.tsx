import Link from "next/link";
import { prisma } from "@ai-cognitive/db";
import { resolveWebIdentity } from "@/lib/identity";
import { AccountMenu } from "./account-menu";
import { StatusBadge } from "./status-badge";

const navLinks = [
  { href: "/studio", label: "首页", icon: "home" },
  { href: "/studio/library", label: "知识库", icon: "library" },
  { href: "/studio/podcasts", label: "播客", icon: "podcast" },
  { href: "/studio/videos", label: "短视频", icon: "video" },
  { href: "/studio/activity", label: "活动", icon: "activity" },
] as const;

export async function AppShell({ children }: { children: React.ReactNode }) {
  const identity = await resolveWebIdentity();
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: identity.userId },
    select: {
      name: true,
      email: true,
      memberships: {
        select: { workspaceId: true, workspace: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const workspaces = user.memberships.map(({ workspaceId, workspace }) => ({ id: workspaceId, name: workspace.name }));
  const workspace = workspaces.find((item) => item.id === identity.workspaceId);
  if (!workspace) throw new Error("WORKSPACE_ACCESS_DENIED");

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <div className="brand-lockup">
            <Link href="/studio" className="brand-title" style={{ display: "block" }}>
              AI Cognitive
              <br />
              Studio
            </Link>
            <div className="brand-subtitle">EDITORIAL ATELIER</div>
          </div>

          <nav className="sidebar-nav" aria-label="Primary navigation">
            {navLinks.map((item) => (
              <SidebarNavLink key={item.href} href={item.href} label={item.label} icon={item.icon} />
            ))}
          </nav>
        </div>

        <div className="sidebar-footer">
          <Link href="/studio/settings/account" className="sidebar-nav-item" style={{ height: 40 }}>
            <NavIcon name="settings" />
            <span>设置</span>
          </Link>
          <AccountMenu name={user.name || user.email} email={user.email} workspace={workspace} workspaces={workspaces} />
        </div>
      </aside>

      <div className="content-wrapper">
        <header className="top-bar">
          <Link href="/studio/activity" className="icon-btn" aria-label="任务记录" title="任务记录">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </Link>
          <Link href="/studio/settings/account" className="icon-btn" aria-label="账户设置" title="账户设置">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </Link>
        </header>

        <main className="main-content">{children}</main>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navLinks.map((item) => (
          <Link key={item.href} href={item.href} className="mobile-nav-item">
            <NavIcon name={item.icon} size={18} />
            <span>{item.label}</span>
          </Link>
        ))}
        <Link href="/studio/settings/account" className="mobile-nav-item">
          <NavIcon name="settings" size={18} />
          <span>设置</span>
        </Link>
      </nav>
    </div>
  );
}

function SidebarNavLink({ href, label, icon }: { href: string; label: string; icon: string }) {
  return (
    <Link href={href} className="sidebar-nav-item">
      <NavIcon name={icon} />
      <span>{label}</span>
    </Link>
  );
}

function NavIcon({ name, size = 20 }: { name: string; size?: number }) {
  if (name === "home") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    );
  }
  if (name === "library") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    );
  }
  if (name === "podcast") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    );
  }
  if (name === "video") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
    );
  }
  if (name === "activity") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    );
  }
  if (name === "settings") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    );
  }
  return null;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-header" style={{ marginBottom: 36, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24 }}>
      <div>
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {action && <div>{action}</div>}
    </header>
  );
}

export function Status({ value }: { value: string }) {
  return <StatusBadge value={value} />;
}
