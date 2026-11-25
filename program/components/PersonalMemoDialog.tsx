"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, NotebookPen, RotateCcw, Trash2, X } from "lucide-react";
import { scopedFetch } from "../lib/client-scope";
import { readApiError } from "../lib/client-format";

type Memo = { id: string; content: string; status: "active" | "completed"; source_type: string; project_name: string | null };

export function PersonalMemoDialog({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef(false);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    let current = true;
    (async () => {
      const response = await scopedFetch("/api/personal-memos?organizationId=" + encodeURIComponent(organizationId));
      if (!response.ok) throw new Error(await readApiError(response));
      const body = await response.json() as { memos: Memo[] };
      if (current) setMemos(body.memos);
    })().catch(reason => { if (current) setError(reason instanceof Error ? reason.message : "备忘加载失败。"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [organizationId, retry]);

  async function mutate(action: "create" | "complete" | "reopen" | "remove", id = "", form?: HTMLFormElement) {
    if (busy) return;
    const content = form ? String(new FormData(form).get("content") || "").trim() : "";
    if (form && !content) return;
    setBusy(true);
    setError("");
    try {
      const path = "/api/personal-memos" + (id ? "/" + encodeURIComponent(id) : "");
      const response = action === "remove"
        ? await scopedFetch(path + "?organizationId=" + encodeURIComponent(organizationId), { method: "DELETE" })
        : await scopedFetch(path, { method: form ? "POST" : "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify(form ? { organizationId, content } : { organizationId, action }) });
      if (!response.ok) throw new Error(await readApiError(response));
      if (action === "create") {
        const { memo } = await response.json() as { memo: Memo };
        if (active.current) { setMemos(items => [memo, ...items]); form?.reset(); }
      } else if (active.current) {
        setMemos(items => action === "remove" ? items.filter(item => item.id !== id) :
          items.map(item => item.id === id ? { ...item, status: action === "complete" ? "completed" : "active" } : item));
      }
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : "备忘更新失败。");
    } finally { if (active.current) setBusy(false); }
  }
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void mutate("create", "", event.currentTarget);
  }
  return <dialog ref={dialog} className="wp-memo-dialog" aria-labelledby="memo-title" onClose={onClose}>
    <header><div><h2 id="memo-title">我的备忘</h2><small>仅自己可见</small></div><button className="wp-icon" type="button" aria-label="关闭备忘" onClick={() => dialog.current?.close()}><X /></button></header>
    {error && <div className="wp-message" role="alert">{error}<button type="button" onClick={() => { setLoading(true); setError(""); setRetry(v => v + 1); }}>重新加载</button></div>}
    <form onSubmit={add}><textarea name="content" aria-label="新的个人备忘" rows={3} maxLength={2000} placeholder="记下稍后要处理的事…" required /><button className="wp-button primary" disabled={busy || loading} type="submit"><NotebookPen size={16} />记下</button></form>
    {loading ? <p role="status">正在加载备忘…</p> : memos.length ? <ul>{[...memos].sort((a,b) => Number(a.status === "completed") - Number(b.status === "completed")).map(memo =>
      <li key={memo.id}><button type="button" className="wp-icon" disabled={busy} aria-label={memo.status === "completed" ? "重新打开" : "标记完成"} onClick={() => void mutate(memo.status === "completed" ? "reopen" : "complete", memo.id)}>{memo.status === "completed" ? <RotateCcw /> : <Check />}</button>
        <div><p className={memo.status}>{memo.content}</p><small>{memo.source_type === "performance_report" ? "来自复盘报告" : "个人记录"}{memo.project_name && " · " + memo.project_name}</small></div>
        <button className="wp-icon" type="button" disabled={busy} aria-label="删除备忘" onClick={() => void mutate("remove", memo.id)}><Trash2 /></button></li>)}</ul> : !error && <p>还没有备忘。</p>}
  </dialog>;
}
