"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function AccountSettings({ name, email, workspace }: { name: string; email: string; workspace: string }) {
  const router = useRouter(); const [message, setMessage] = useState(""); const [pending, setPending] = useState(false);
  async function updateName(form: HTMLFormElement) { setPending(true); setMessage(""); const result = await authClient.updateUser({ name: String(new FormData(form).get("name") ?? "").trim() }); setPending(false); setMessage(result.error ? "无法更新账户信息，请稍后再试。" : "账户名称已更新。"); if (!result.error) router.refresh(); }
  async function changePassword(form: HTMLFormElement) { const data = new FormData(form); const next = String(data.get("newPassword") ?? ""); if (next !== data.get("confirmPassword")) return setMessage("两次输入的新密码不一致。"); setPending(true); setMessage(""); const result = await authClient.changePassword({ currentPassword: String(data.get("currentPassword") ?? ""), newPassword: next, revokeOtherSessions: true }); setPending(false); setMessage(result.error ? "当前密码不正确或新密码不符合要求。" : "密码已更新，其他设备已退出登录。"); if (!result.error) form.reset(); }
  return <div className="settings-stack"><section className="panel"><h2>账户信息</h2><p className="muted">邮箱：{email}</p><form className="form" onSubmit={(event) => { event.preventDefault(); void updateName(event.currentTarget); }}><label>显示名称<input name="name" autoComplete="name" required minLength={2} maxLength={80} defaultValue={name} /></label><button className="button" disabled={pending}>保存名称</button></form></section><section className="panel"><h2>当前工作区</h2><p>{workspace}</p></section><section className="panel"><h2>修改密码</h2><form className="form" onSubmit={(event) => { event.preventDefault(); void changePassword(event.currentTarget); }}><label>当前密码<input name="currentPassword" type="password" autoComplete="current-password" required /></label><label>新密码<input name="newPassword" type="password" autoComplete="new-password" minLength={10} maxLength={128} required /></label><label>确认新密码<input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} maxLength={128} required /></label><button className="button" disabled={pending}>更新密码</button></form></section><p className="form-error" aria-live="polite">{message}</p></div>;
}
