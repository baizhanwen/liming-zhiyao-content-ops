"use client";

import { FormEvent, useEffect, useState } from "react";
import { StandalonePageHeading } from "./StandalonePageHeading";

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [checking, setChecking] = useState(true);
  const [working, setWorking] = useState(false);
  const [localDevLoginAvailable, setLocalDevLoginAvailable] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/first-run", { cache: "no-store" }).then(async (setupResponse) => {
      if (setupResponse.ok) {
        const setup = await setupResponse.json() as { deliveryMode?: boolean; setupRequired?: boolean };
        if (active && setup.deliveryMode && setup.setupRequired) { window.location.replace("/first-run"); return null; }
      }
      return fetch("/api/auth/session", { cache: "no-store" });
    }).then(async (response) => {
      if (!response) return;
      if (active && response.ok) window.location.replace(returnTo);
      else if (active) {
        const status = response.status === 401 ? await response.json<{ localDevLoginAvailable?: boolean }>().catch(() => null) : null;
        if (active) { setLocalDevLoginAvailable(status?.localDevLoginAvailable === true); setChecking(false); }
      }
    }).catch(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [returnTo]);

  async function login(payload: { email: FormDataEntryValue | null; password: FormDataEntryValue | null } | { mode: "local-dev" }) {
    setWorking(true); setError("");
    try {
      const response = await fetch("/api/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) { setError(body?.error?.message ?? "登录失败，请稍后重试。"); return; }
      window.location.replace(returnTo);
    } catch {
      setError("暂时无法连接工作台，请确认主机服务和网络正常后重试。");
    } finally {
      setWorking(false);
    }
  }

  function passwordLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void login({ email: form.get("email"), password: form.get("password") });
  }

  return <>
    <StandalonePageHeading title="登录工作台" />
    <section className="login-card"><div className="login-brand"><span className="brand-mark">利</span><div><strong>利明智耀</strong><small>AI 内容运营协作平台</small></div></div>
    {checking ? <div className="management-state" role="status">正在检查登录状态…</div> : <form className="stack-form" onSubmit={passwordLogin}>
      <label>邮箱<input name="email" type="email" autoComplete="username" required placeholder="name@company.com" /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
      {error && <div className="inline-alert" role="alert">{error}</div>}
      <button className="primary-button" disabled={working}>{working ? "正在登录…" : "登录"}</button>
      {localDevLoginAvailable && <button className="secondary-button" type="button" disabled={working} onClick={() => void login({ mode: "local-dev" })}>以本地管理员进入</button>}
    </form>}<small className="login-help">首次加入团队？请使用管理员发给你的邀请链接创建账号。</small></section>
  </>;
}
