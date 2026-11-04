"use client";
import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export function PasswordRecovery({ token, available }: { token?: string; available: boolean }) {
  const [message, setMessage] = useState(""), [pending, setPending] = useState(false), [complete, setComplete] = useState(false);
  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    if (token && data.get("password") !== data.get("confirm")) { setMessage("两次输入的密码不一致。"); return; }
    setPending(true); setMessage("");
    try {
      if (token) {
        const result = await authClient.resetPassword({ token, newPassword: String(data.get("password")) });
        if (result.error) { setMessage("链接已失效或密码不符合要求，请重新申请重置链接。"); return; }
        setComplete(true); form.reset(); setMessage("密码已重置，请重新登录。");
        history.replaceState(null, "", "/reset-password");
      } else {
        const result = await authClient.requestPasswordReset({ email: String(data.get("email")).trim(), redirectTo: `${location.origin}/reset-password` });
        if (result.error) { setMessage("暂时无法发送邮件，请稍后重试。"); return; }
        setMessage("如果该邮箱已注册，我们会发送重置链接。请同时检查垃圾邮件。");
      }
    } catch { setMessage("网络暂时不可用，请稍后重试。"); }
    finally { setPending(false); }
  }
  return <main className="auth-page"><section className="auth-card">
    <h1>{token ? "设置新密码" : "找回密码"}</h1>
    {!available && !token ? <p>此部署尚未配置邮件服务，请联系部署管理员恢复账户。</p> : !complete && <form onSubmit={event => { event.preventDefault(); void submit(event.currentTarget); }}>
      {token ? <><label htmlFor="password">新密码</label><input className="input-control" id="password" name="password" type="password" autoComplete="new-password" minLength={10} maxLength={128} required /><label htmlFor="confirm">确认新密码</label><input className="input-control" id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} maxLength={128} required /></> : <><label htmlFor="email">注册邮箱</label><input className="input-control" id="email" name="email" type="email" autoComplete="email" maxLength={254} required /></>}
      <button className="btn btn-primary" disabled={pending}>{pending ? "正在处理…" : token ? "保存新密码" : "发送重置链接"}</button>
    </form>}
    <p role="status">{message}</p><Link href="/sign-in">返回登录</Link>
  </section></main>;
}
