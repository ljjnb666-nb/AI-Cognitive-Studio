import Link from "next/link";
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

import { PageHeader } from "./page-header";

export { PageHeader };

export async function AppShell({ children }: { children: React.ReactNode }) {
  const identity = await resolveWebIdentity();
  const workspaces = identity.workspaces;
  const workspace = workspaces.find((item) => item.id === identity.workspaceId) ?? workspaces[0];
  if (!workspace) throw new Error("WEB_IDENTITY_WORKSPACE_REQUIRED");

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
          <AccountMenu name={identity.userName || identity.email} email={identity.email} workspace={workspace} workspaces={workspaces} />
        </div>
      </aside>

      <div className="main-content flex-1">
        <header className="topbar">
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span className="font-serif" style={{ fontSize: 18, fontWeight: 600, color: "var(--on-surface)" }}>
              {workspace.name}
            </span>
            <StatusBadge value="已就绪" />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Link href="/studio/library#upload" className="btn btn-secondary" style={{ height: 32, fontSize: 13, gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              导入书籍
            </Link>
            <Link href="/studio/settings/providers" className="btn btn-primary" style={{ height: 32, fontSize: 13 }}>
              Provider 设置
            </Link>
          </div>
        </header>

        <main className="content-area">{children}</main>

        <nav className="mobile-nav" aria-label="Mobile navigation">
          {navLinks.map((item) => (
            <Link key={item.href} href={item.href} className="mobile-nav-item">
              <NavIcon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          ))}
          <Link href="/studio/settings/account" className="mobile-nav-item">
            <NavIcon name="settings" />
            <span>设置</span>
          </Link>
        </nav>
      </div>
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

function NavIcon({ name }: { name: string }) {
  switch (name) {
    case "home":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      );
    case "library":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      );
    case "podcast":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
        </svg>
      );
    case "video":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      );
    case "activity":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      );
    case "settings":
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    default:
      return null;
  }
}
