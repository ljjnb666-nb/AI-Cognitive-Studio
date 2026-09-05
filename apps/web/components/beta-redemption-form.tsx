"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function BetaRedemptionForm() {
  const router = useRouter(); const [code, setCode] = useState(""); const [consent, setConsent] = useState(false); const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  async function redeem() { setPending(true); setError(""); const response = await fetch("/api/beta/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, consent }) }); setPending(false); if (!response.ok) { setError("邀请码无效、已失效或已被使用。请联系 Beta 运营人员。"); return; } router.replace("/studio"); router.refresh(); }
  return <main className="auth-page"><section className="auth-card"><p className="page-eyebrow">CLOSED BETA</p><h1 className="font-serif">访问 AI Cognitive Studio</h1><p className="page-desc">此封闭测试会收集有限的第一方产品遥测与您主动提交的反馈，用于改善产品体验。</p><label className="field-label" htmlFor="beta-code">邀请码</label><input id="beta-code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" className="field-input" /><label style={{ display: "flex", gap: 8, marginTop: 16, fontSize: 14 }}><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />我同意上述 Closed Beta 遥测说明。</label>{error ? <p role="alert">{error}</p> : null}<button className="btn btn-primary" disabled={!consent || !code || pending} onClick={redeem}>{pending ? "正在验证…" : "接受邀请并进入"}</button></section></main>;
}
