"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function AccountSettings({ name, email, workspace }: { name: string; email: string; workspace: string }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function downloadPersonalRecords() {
    if (pending) return;
    setPending(true); setMessage("");
    try {
      const response = await fetch("/api/account/export", { cache: "no-store" });
      if (!response.ok) {
        setMessage(response.status === 413 ? "记录超过单次导出上限，暂时无法下载。" : response.status === 429 ? "已有导出正在处理，请稍后重试。" : response.status === 401 ? "登录已过期，请重新登录后导出。" : "导出暂时不可用，请稍后重试。");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = "studio-personal-learning-records.json";
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("导出文件已准备好，请查看浏览器下载。");
    } catch { setMessage("网络连接失败，导出未完成，请重试。"); }
    finally { setPending(false); }
  }

  async function updateName(form: HTMLFormElement) {
    setPending(true);
    setMessage("");
    try {
    const result = await authClient.updateUser({ name: String(new FormData(form).get("name") ?? "").trim() });
    setPending(false);
    setMessage(result.error ? "无法更新账户信息，请稍后再试。" : "账户名称已更新。");
    if (!result.error) router.refresh();
    } catch { setMessage("网络连接失败，请重试。"); }
    finally { setPending(false); }
  }

  async function changePassword(form: HTMLFormElement) {
    const data = new FormData(form);
    const next = String(data.get("newPassword") ?? "");
    if (next !== data.get("confirmPassword")) return setMessage("两次输入的新密码不一致。");
    setPending(true);
    setMessage("");
    try {
    const result = await authClient.changePassword({
      currentPassword: String(data.get("currentPassword") ?? ""),
      newPassword: next,
      revokeOtherSessions: true,
    });
    setPending(false);
    setMessage(result.error ? "当前密码不正确或新密码不符合要求。" : "密码已更新，其他设备已退出登录。");
    if (!result.error) form.reset();
    } catch { setMessage("网络连接失败，请重试。"); }
    finally { setPending(false); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, maxWidth: 640 }}>
      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 16 }}>
          账户信息
        </h2>
        <div className="form-group font-mono" style={{ fontSize: 13, color: "var(--outline)", marginBottom: 20 }}>
          邮箱：{email}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void updateName(event.currentTarget);
          }}
          style={{ display: "grid", gap: 16 }}
        >
          <div className="form-group">
            <label className="form-label" htmlFor="name">显示名称</label>
            <input className="input-control" id="name" name="name" autoComplete="name" required minLength={2} maxLength={80} defaultValue={name} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={pending} style={{ justifySelf: "start" }}>
            保存名称
          </button>
        </form>
      </section>

      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 12 }}>
          当前工作区
        </h2>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 500, color: "var(--on-surface)" }}>{workspace}</p>
      </section>

      <section className="card-panel">
        <h2 className="section-title" style={{ marginBottom: 20 }}>
          修改密码
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void changePassword(event.currentTarget);
          }}
          style={{ display: "grid", gap: 16 }}
        >
          <div className="form-group">
            <label className="form-label" htmlFor="currentPassword">当前密码</label>
            <input className="input-control" id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="newPassword">新密码</label>
            <input className="input-control" id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={10} maxLength={128} required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="confirmPassword">确认新密码</label>
            <input className="input-control" id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={10} maxLength={128} required />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={pending} style={{ justifySelf: "start" }}>
            更新密码
          </button>
        </form>
      </section>

      {message && <p className="form-error" role="status">{message}</p>}
      <section className="card-panel">
        <h2 className="section-title">导出账户与学习记录</h2>
        <p>下载账户信息、认知收藏、复习进度、思考对话和复述评估。此导出不包含共享书籍、音视频文件及 Beta 活动记录。</p>
        <button className="btn btn-secondary" disabled={pending} onClick={() => void downloadPersonalRecords()}>下载个人学习记录（JSON）</button>
      </section>
    </div>
  );
}
