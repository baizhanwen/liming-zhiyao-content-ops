"use client";

import { FormEvent, useEffect, useState } from "react";

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [checking, setChecking] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/first-run", { cache: "no-store" }).then(async (setupResponse) => {
      if (setupResponse.ok) {
        const setup = await setupResponse.json() as { deliveryMode?: boolean; setupRequired?: boolean };
        if (active && setup.deliveryMode && setup.setupRequired) { window.location.replace("/first-run"); return null; }
      }
      return fetch("/api/auth/session", { cache: "no-store" });
    }).then((response) => {
      if (!response) return;
      if (active && response.ok) window.location.replace(returnTo);
      else if (active) setChecking(false);
    }).catch(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [returnTo]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setWorking(true); setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    if (!response.ok) { setError(body?.error?.message ?? "登录失败，请稍后重试。"); setWorking(false); return; }
    window.location.replace(returnTo);
  }

  return <section className="login-card"><div className="login-brand"><span className="brand-mark">利</span><div><strong>利明智耀</strong><small>AI 内容运营协作平台</small></div></div><p className="section-kicker">局域网团队协作</p><h1>登录工作台</h1><p>使用管理员为你创建或邀请时登记的邮箱和密码。</p>{checking ? <div className="management-state" role="status">正在检查登录状态…</div> : <form className="stack-form" onSubmit={login}><label>邮箱<input name="email" type="email" autoComplete="username" required placeholder="name@company.com" /></label><label>密码<input name="password" type="password" autoComplete="current-password" required /></label>{error && <div className="inline-alert" role="alert">{error}</div>}<button className="primary-button" disabled={working}>{working ? "正在登录…" : "登录"}</button></form>}<small className="login-help">首次加入团队？请使用管理员发给你的邀请链接创建账号。</small></section>;
}
