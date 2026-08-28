"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(form: HTMLFormElement) {
    const values = new FormData(form);
    const email = String(values.get("email") ?? "").trim();
    const password = String(values.get("password") ?? "");
    const name = String(values.get("name") ?? "").trim();

    if (mode === "sign-up" && password !== values.get("confirmPassword")) {
      return setError("两次输入的密码不一致。");
    }

    setPending(true);
    setError("");

    const result =
      mode === "sign-up"
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password, rememberMe: true });

    if (result.error) {
      setPending(false);
      return setError(mode === "sign-in" ? "邮箱或密码不正确。" : "无法创建账户，请检查信息或尝试登录。");
    }

    if (mode === "sign-up") {
      await authClient.signIn.email({ email, password, rememberMe: true });
    }

    setPending(false);
    router.replace("/studio");
    router.refresh();
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div style={{ marginBottom: 24 }}>
          <div className="brand-title" style={{ fontSize: 20 }}>
            AI Cognitive Studio
          </div>
          <div className="brand-subtitle" style={{ fontSize: 9 }}>
            EDITORIAL ATELIER
          </div>
        </div>

        <h1 className="font-serif" style={{ fontSize: 26, fontWeight: 600, color: "var(--on-surface)", margin: "0 0 24px 0" }}>
          {mode === "sign-up" ? "创建你的工作区" : "登录工作室"}
        </h1>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
          style={{ display: "grid", gap: 16 }}
        >
          {mode === "sign-up" && (
            <div className="form-group">
              <label className="form-label">姓名</label>
              <input className="input-control" name="name" autoComplete="name" required minLength={2} maxLength={80} placeholder="例如：Scholar" />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">邮箱</label>
            <input className="input-control font-mono" name="email" type="email" autoComplete="email" required maxLength={254} placeholder="name@example.com" />
          </div>

          <div className="form-group">
            <label className="form-label">密码</label>
            <input
              className="input-control font-mono"
              name="password"
              type="password"
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              required
              minLength={10}
              maxLength={128}
            />
          </div>

          {mode === "sign-up" && (
            <div className="form-group">
              <label className="form-label">确认密码</label>
              <input
                className="input-control font-mono"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                maxLength={128}
              />
            </div>
          )}

          <p className="form-error" aria-live="polite">
            {error}
          </p>

          <button type="submit" className="btn btn-primary" disabled={pending} style={{ width: "100%", marginTop: 8 }}>
            {pending ? "正在处理…" : mode === "sign-up" ? "注册并进入 Studio" : "登录并进入工作台"}
          </button>
        </form>

        <div style={{ marginTop: 24, fontSize: 13, color: "var(--on-surface-variant)", textAlign: "center" }}>
          {mode === "sign-up" ? (
            <>
              已有账户？{" "}
              <Link href="/sign-in" style={{ color: "var(--primary)", textDecoration: "underline" }}>
                登录
              </Link>
            </>
          ) : (
            <>
              还没有账户？{" "}
              <Link href="/sign-up" style={{ color: "var(--primary)", textDecoration: "underline" }}>
                创建账户
              </Link>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
