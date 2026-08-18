"use client";

import { FormEvent, useState } from "react";

type Props = {
  organizationId: string;
  projectId: string;
  recordId: string;
  sourceType: string;
  performance: Record<string, number>;
  onUpdated: () => Promise<void>;
  onError: (message: string) => void;
};

async function readError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message || "效果数据没有保存，请稍后重试。";
}

export function PublishedCopyPerformanceEditor({ organizationId, projectId, recordId, sourceType, performance, onUpdated, onError }: Props) {
  const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false);
  const hasPerformance = Object.values(performance).some((value) => Number(value) > 0);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); setSaving(true); setSaved(false); onError("");
    const metric = (name: string) => { const value = String(form.get(name) || "").trim(); return value ? Number(value) : undefined; };
    try {
      const response = await fetch(`/api/published-copy/${recordId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, performance: { views: metric("views"), likes: metric("likes"), saves: metric("saves"), leads: metric("leads"), conversions: metric("conversions") } }) });
      if (!response.ok) throw new Error(await readError(response)); setSaved(true); await onUpdated();
    } catch (reason) { onError(reason instanceof Error ? reason.message : "效果数据没有保存，请稍后重试。"); }
    finally { setSaving(false); }
  }

  return <details className="published-copy-effect-editor">
    <summary><span>{hasPerformance ? "更新效果" : "补充效果"}</span>{saved && <em>已保存</em>}</summary>
    <form onSubmit={save}><div className="metric-grid"><label>阅读/播放<input name="views" type="number" min="0" defaultValue={performance.views ?? ""} /></label><label>点赞<input name="likes" type="number" min="0" defaultValue={performance.likes ?? ""} /></label><label>收藏<input name="saves" type="number" min="0" defaultValue={performance.saves ?? ""} /></label><label>咨询<input name="leads" type="number" min="0" defaultValue={performance.leads ?? ""} /></label><label>成交<input name="conversions" type="number" min="0" defaultValue={performance.conversions ?? ""} /></label></div><div><small>{sourceType === "publication" ? "阅读、点赞、收藏和咨询会自动采用数据复盘中的最新快照。" : "保存后立即重新计算高表现画像。"}</small><button type="submit" disabled={saving}>{saving ? "保存中…" : "保存效果"}</button></div></form>
  </details>;
}
