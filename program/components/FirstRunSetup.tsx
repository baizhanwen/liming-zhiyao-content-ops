"use client";

import { FormEvent, useEffect, useState } from "react";

type Status = { deliveryMode: boolean; setupRequired: boolean; setupCodeConfigured: boolean; setupCodeRequired: boolean };

async function responseMessage(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? "首次开通没有完成，请稍后重试。";
}

export function FirstRunSetup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void fetch("/api/first-run", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(await responseMessage(response));
      const body = await response.json() as Status;
      setStatus(body);
      if (!body.deliveryMode || !body.setupRequired) window.location.replace("/login");
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "无法检查开通状态。"));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true); setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/first-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companyName: form.get("companyName"), administratorName: form.get("administratorName"), email: form.get("email"),
        password: form.get("password"), confirmation: form.get("confirmation"), setupCode: form.get("setupCode"),
      }),
    });
    if (!response.ok) { setError(await responseMessage(response)); setWorking(false); return; }
    window.location.replace("/login?initialized=1");
  }

  return <section className="login-card first-run-card">
    <div className="login-brand"><span className="brand-mark">利</span><div><strong>利明智耀</strong><small>本地工作台首次设置</small></div></div>
    <p className="section-kicker">仅限主机电脑 · 一次性操作</p><h1>建立首家公司与管理员</h1>
    <p>开通完成后入口将永久关闭。其他成员由管理员登录后在“成员与权限”中邀请。</p>
    {!status && !error ? <div className="management-state" role="status">正在检查安装状态…</div> : status && (!status.setupCodeRequired || status.setupCodeConfigured) ? <form className="stack-form" onSubmit={submit}>
      <label>公司名称<input name="companyName" required minLength={2} maxLength={80} /></label>
      <label>管理员姓名<input name="administratorName" required minLength={2} maxLength={80} /></label>
      <label>管理员邮箱<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>
      <label>管理员密码<input name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} /></label>
      <label>确认密码<input name="confirmation" type="password" autoComplete="new-password" required minLength={10} maxLength={128} /></label>
      {status.setupCodeRequired && <label>一次性初始化码<input name="setupCode" type="password" autoComplete="off" required /></label>}
      {error && <div className="inline-alert" role="alert">{error}</div>}
      <button className="primary-button" disabled={working}>{working ? "正在建立…" : "完成开通"}</button>
    </form> : <div className="inline-alert" role="alert">{error || "交付包未配置初始化码，请联系软件提供方。"}</div>}
  </section>;
}
