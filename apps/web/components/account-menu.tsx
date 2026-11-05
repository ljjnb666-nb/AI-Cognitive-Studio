"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { clearDrafts } from "./recoverable-draft";
import { authClient } from "@/lib/auth-client";

type Workspace = { id: string; name: string };

export function AccountMenu({ name, email, workspace, workspaces }: { name: string; email: string; workspace: Workspace; workspaces: Workspace[] }) {
  const router = useRouter();
  const details = useRef<HTMLDetailsElement>(null);
  const [switching, setSwitching] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [switchError, setSwitchError] = useState(false);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (details.current?.open && event.target instanceof Node && !details.current.contains(event.target)) details.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);

  async function switchWorkspace(workspaceId: string) {
    if (switching || refreshing || workspaceId === workspace.id) return;
    setSwitching(true);
    setSwitchError(false);
    try {
      const response = await fetch("/api/studio/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
      if (!response.ok) { setSwitchError(true); return; }
      startTransition(() => router.refresh());
    } catch { setSwitchError(true); }
    finally { setSwitching(false); }
  }

  const initial = (name || email || "U").slice(0, 1).toUpperCase();

  return (
    <details ref={details} className="account-menu-details" onKeyDown={(event) => {
      if (event.key === "Escape" && details.current?.open) {
        details.current.open = false;
        details.current.querySelector("summary")?.focus();
      }
    }}>
      <summary className="account-menu-summary" title={email}>
        <div className="avatar-circle">{initial}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="user-name-text">{name || email}</div>
          <div className="user-sub-text" title={workspace.name}>{workspace.name}</div>
        </div>
        <svg className="account-menu-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 14 6-6 6 6" /></svg>
      </summary>
      <div className="account-menu-dropdown">
        <div className="account-menu-identity"><span>已登录账户</span><p>{email}</p></div>
        {workspaces.length > 1 && (
          <div className="account-workspace-field">
            <label className="form-label" htmlFor="account-workspace">
              工作区
            </label>
            <select
              className="select-control"
              id="account-workspace"
              aria-label="工作区"
              title={workspace.name}
              disabled={switching || refreshing}
              value={workspace.id}
              onChange={(e) => void switchWorkspace(e.target.value)}
            >
              {workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            {(switching || refreshing) && <p role="status">正在切换工作区…</p>}
            {switchError && <p role="alert">工作区切换失败，请重试。</p>}
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
          AI 服务配置
        </Link>
        <button
          className="account-menu-signout"
          type="button"
          onClick={async () => {
            await authClient.signOut();
            clearDrafts();
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
