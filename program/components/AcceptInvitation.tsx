"use client";

import { FormEvent, useState } from "react";

export function AcceptInvitation({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("working");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/invitations/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, displayName: form.get("displayName"), password: form.get("password"), confirmation: form.get("confirmation") }) });
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    if (!response.ok) { setMessage(body?.error?.message ?? "邀请无法接受，请联系管理员。"); setState("error"); return; }
    setState("done"); setMessage("邀请已接受，你现在可以进入企业空间。");
  }
  return <section className="invitation-card"><span className="brand-mark">利</span><p className="section-kicker">局域网团队邀请</p><h1>{state === "done" ? "欢迎加入利明智耀" : "创建你的团队账号"}</h1><p>{message || "设置姓名和登录密码后，系统会按管理员分配的角色开放公司与企业空间权限。"}</p>{!token ? <div className="inline-alert">邀请链接缺少令牌，请让管理员重新发送。</div> : state === "done" ? <a className="primary-button link-button" href="/projects">进入企业空间</a> : <form className="stack-form invitation-form" onSubmit={accept}><label>姓名<input name="displayName" minLength={2} maxLength={40} autoComplete="name" required placeholder="例如：李晓" /></label><label>登录密码<input name="password" type="password" minLength={10} maxLength={128} autoComplete="new-password" required placeholder="至少 10 个字符" /></label><label>确认密码<input name="confirmation" type="password" minLength={10} maxLength={128} autoComplete="new-password" required /></label><button className="primary-button" disabled={state === "working"}>{state === "working" ? "正在创建账号…" : "接受邀请并登录"}</button></form>}{state === "error" && <div className="inline-alert" role="alert">{message}</div>}</section>;
}
