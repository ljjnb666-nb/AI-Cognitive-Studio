"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

type Workspace = { id: string; name: string };

export function AccountMenu({ name, email, workspace, workspaces }: { name: string; email: string; workspace: Workspace; workspaces: Workspace[] }) {
  const router = useRouter();

  async function switchWorkspace(workspaceId: string) {
    const response = await fetch("/api/studio/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (response.ok) router.refresh();
  }

  const initial = (name || email || "U").slice(0, 1).toUpperCase();

  return (
    <details className="account-menu-details">
      <summary className="account-menu-summary" title={email}>
        <div className="avatar-circle">{initial}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="user-name-text">{name || email}</div>
          <div className="user-sub-text">{workspace.name}</div>
        </div>
      </summary>
      <div className="account-menu-dropdown">
        <p>{email}</p>
        {workspaces.length > 1 && (
          <div className="form-group" style={{ marginBottom: 4 }}>
            <label className="form-label" style={{ fontSize: 11, color: "var(--outline)" }}>
              工作区
            </label>
            <select
              className="select-control"
              aria-label="工作区"
              value={workspace.id}
              onChange={(e) => void switchWorkspace(e.target.value)}
              style={{ height: 32, fontSize: 12, padding: "0 24px 0 8px" }}
            >
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <Link href="/studio/settings/account">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          账户设置
        </Link>
        <Link href="/studio/settings/providers">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          AI Providers
        </Link>
        <button
          type="button"
          onClick={async () => {
            await authClient.signOut();
            router.replace("/sign-in");
            router.refresh();
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          退出登录
        </button>
      </div>
    </details>
  );
}
