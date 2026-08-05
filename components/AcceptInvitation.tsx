"use client";

import { useState } from "react";

export function AcceptInvitation({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  async function accept() {
    setState("working");
    const response = await fetch("/api/invitations/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    if (!response.ok) { setMessage(body?.error?.message ?? "邀请无法接受，请联系管理员。"); setState("error"); return; }
    setState("done"); setMessage("邀请已接受，你现在可以进入客户项目。");
  }
  return <section className="invitation-card"><span className="brand-mark">利</span><p className="section-kicker">团队邀请</p><h1>{state === "done" ? "欢迎加入利明智耀" : "加入内容运营协作空间"}</h1><p>{message || "确认后，系统会按管理员分配的角色开放公司与客户项目权限。邀请链接只能使用一次。"}</p>{!token ? <div className="inline-alert">邀请链接缺少令牌，请让管理员重新发送。</div> : state === "done" ? <a className="primary-button link-button" href="/projects">进入客户项目</a> : <button className="primary-button" disabled={state === "working"} onClick={accept}>{state === "working" ? "正在确认…" : "接受邀请"}</button>}{state === "error" && <div className="inline-alert" role="alert">{message}</div>}</section>;
}
