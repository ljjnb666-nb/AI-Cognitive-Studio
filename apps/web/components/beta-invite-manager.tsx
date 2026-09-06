"use client";

import { useEffect, useState } from "react";

type Invite = { id: string; cohort: string; expiresAt: string; createdAt: string; redeemedAt: string | null; revokedAt: string | null };

export function BetaInviteManager() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [cohort, setCohort] = useState("closed-beta");
  const [expiresAt, setExpiresAt] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  async function refresh() { const response = await fetch("/api/studio/beta/invites", { cache: "no-store" }); if (response.ok) setInvites((await response.json()).invites); }
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/studio/beta/invites", { cache: "no-store" }).then(async (response) => {
      if (response.ok && !cancelled) setInvites((await response.json()).invites);
    });
    return () => { cancelled = true; };
  }, []);
  async function create() {
    setMessage(""); setToken(null);
    const response = await fetch("/api/studio/beta/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cohort, expiresAt }) });
    if (!response.ok) { setMessage("无法创建邀请码。请检查有效期。 "); return; }
    const result = await response.json(); setToken(result.token); setMessage("请立即通过受控渠道发送；关闭或刷新页面后不会再次显示。"); await refresh();
  }
  async function revoke(id: string) { const response = await fetch(`/api/studio/beta/invites/${id}/revoke`, { method: "POST" }); if (response.ok) await refresh(); else setMessage("该邀请码不能撤销。"); }
  return <section className="card-panel" style={{ marginTop: 32 }}><h2 className="section-title">邀请码</h2><p className="page-desc">原始邀请码仅在创建后的此页面显示一次，数据库只保存哈希。</p><div style={{ display: "grid", gap: 8, gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) auto" }}><input aria-label="测试队列" className="field-input" value={cohort} onChange={(event) => setCohort(event.target.value)} /><input aria-label="邀请码有效期" className="field-input" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /><button className="btn btn-primary" disabled={!cohort.trim() || !expiresAt} onClick={create}>创建</button></div>{token ? <p role="status" style={{ overflowWrap: "anywhere" }}><strong>仅显示一次：</strong>{token}</p> : null}{message ? <p role="status">{message}</p> : null}<div style={{ marginTop: 16 }}>{invites.map((invite) => <article key={invite.id} style={{ display: "flex", gap: 12, justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid var(--surface-container-high)" }}><span>{invite.cohort} · 到期 {new Date(invite.expiresAt).toLocaleString("zh-CN")}</span><span>{invite.redeemedAt ? "已使用" : invite.revokedAt ? "已撤销" : <button className="btn btn-secondary" onClick={() => revoke(invite.id)}>撤销</button>}</span></article>)}</div></section>;
}
