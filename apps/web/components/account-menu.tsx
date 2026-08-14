"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

type Workspace = { id: string; name: string };

export function AccountMenu({ name, email, workspace, workspaces }: { name: string; email: string; workspace: Workspace; workspaces: Workspace[] }) {
  const router = useRouter();
  async function switchWorkspace(workspaceId: string) {
    const response = await fetch("/api/studio/workspace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
    if (response.ok) router.refresh();
  }
  return <details className="account-menu">
    <summary>{name.slice(0, 1).toUpperCase()} <span>{name} · {workspace.name}</span></summary>
    <p>{email}</p>
    {workspaces.length > 1 && <label>Workspace <select aria-label="Workspace" value={workspace.id} onChange={(event) => void switchWorkspace(event.target.value)}>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    <Link href="/studio/settings/account">Account settings</Link>
    <button onClick={async () => { await authClient.signOut(); router.replace("/sign-in"); router.refresh(); }}>Sign out</button>
  </details>;
}
