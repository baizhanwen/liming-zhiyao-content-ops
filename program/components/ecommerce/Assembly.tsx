"use client";

import { useState } from "react";
import type { EcommercePack } from "../../lib/ecommerce/contracts";
import { Checks, displayTime, ecommerceApi, Field, Notices, splitLines, TextField, useEcommerceAction, type Scope } from "./shared";
import { editSegment, roles, scriptText, sourceTypes, type SourceSnapshot, type TaskDetail, type Version } from "./task-types";

export function Assembly({ scope, detail, enabled, dirty, changed, replace }: { scope: Scope; detail: TaskDetail; enabled: boolean; dirty: (value: boolean) => void; changed: () => Promise<void>; replace: (role: "hook" | "evidence" | "cta") => Promise<void> }) {
  const [selectedId, setSelectedId] = useState(detail.versions[0]?.id ?? ""), [edited, setEdited] = useState(false);
  const version = detail.versions.find(v => v.id === selectedId);
  const updateDirty = (value: boolean) => { setEdited(value); dirty(value); };
  if (!version) return <section className="ec-panel"><h2>素材装配台</h2><p className="ec-muted">任务条件补齐并生成后，这里显示口播、镜头和每条来源的应用说明。</p></section>;
  return <section className="ec-panel"><header className="ec-panel-head"><h2>素材装配台</h2><Field label="查看稿件版本"><select value={selectedId} onChange={e => { if (!edited || window.confirm("放弃尚未保存的稿件修改并切换版本吗？")) { updateDirty(false); setSelectedId(e.target.value); } }}>{detail.versions.map(v => <option key={v.id} value={v.id}>v{v.version} · {v.mode === "manual" ? "人工修改" : v.mode === "patch" ? "局部替换" : "AI 生成"}</option>)}</select></Field></header><p className="ec-muted">{displayTime(version.created_at)} · {version.change_summary}</p>
    <PackEditor key={version.id} scope={scope} detail={detail} version={version} enabled={enabled && version.version === detail.task.current_version} dirty={updateDirty} changed={changed} replace={replace} />
  </section>;
}

function PackEditor({ scope, detail, version, enabled, dirty, changed, replace }: { scope: Scope; detail: TaskDetail; version: Version; enabled: boolean; dirty: (value: boolean) => void; changed: () => Promise<void>; replace: (role: "hook" | "evidence" | "cta") => Promise<void> }) {
  const [pack, setPack] = useState<EcommercePack>(() => JSON.parse(version.pack_json)), [editing, setEditing] = useState(false), [modified, setModified] = useState(false), [summary, setSummary] = useState("");
  const [checklist, setChecklist] = useState(pack.filmingChecklist.join("\n")), [pending, setPending] = useState(pack.pendingConfirmations.join("\n"));
  const [note, setNote] = useState(""), [confirmations, setConfirmations] = useState<string[]>([]), action = useEcommerceAction();
  const snapshot = JSON.parse(version.input_snapshot_json) as SourceSnapshot;
  const validation = JSON.parse(version.validation_json) as { ok: boolean; issues?: string[] };
  const touch = () => { setModified(true); dirty(true); };
  const sourceName = (type: string, id: string) => snapshot.sources.find(s => s.type === type && s.id === id)?.title ?? id;
  async function review(decision: string) {
    await ecommerceApi(scope, `tasks/${detail.task.id}/review`, { revision: detail.task.revision, versionId: version.id, action: decision, note, confirmations });
    await changed(); setNote(""); setConfirmations([]);
  }
  async function download() {
    const data = new Blob([`${pack.title}\n\n${scriptText(pack)}\n\n拍摄清单\n${pack.filmingChecklist.join("\n")}`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(data), a = document.createElement("a"); a.href = url; a.download = `电商文案-v${version.version}.txt`; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <><Notices error={action.error} message={action.message} />{!validation.ok && <p className="ec-notice ec-error">本稿待修正：{validation.issues?.join("；")}</p>}
    <div className="ec-actions"><button type="button" disabled={!enabled || action.busy} onClick={() => setEditing(!editing)}>{editing ? "预览稿件" : "编辑稿件"}</button><button type="button" disabled={modified} onClick={() => void action.act(download)}>导出口播与拍摄清单</button><small className="ec-muted">商品：{snapshot.product.name} · {snapshot.product.sku}</small></div>
    <form onSubmit={event => { event.preventDefault(); void action.act(async () => { await ecommerceApi(scope, `tasks/${detail.task.id}/versions`, { revision: detail.task.revision, baseVersion: version.version, pack: { ...pack, filmingChecklist: splitLines(checklist), pendingConfirmations: splitLines(pending) }, changeSummary: summary }); dirty(false); await changed(); }); }}>
      <fieldset disabled={!enabled || action.busy} className="ec-form">
        {editing ? <TextField label="稿件标题" value={pack.title} required maxLength={300} onChange={title => { touch(); setPack({ ...pack, title }); }} /> : <h3 className="ec-script-title">{pack.title}</h3>}
        <div className="ec-script">{pack.segments.map((segment, index) => <section className="ec-segment" key={segment.id}><header><strong>{index + 1} · {roles[segment.role]}</strong><span>{segment.durationSec} 秒</span>{["hook", "evidence", "cta"].includes(segment.role) && <button type="button" disabled={!enabled || modified || action.busy} onClick={() => void replace(segment.role as "hook" | "evidence" | "cta")}>只替换{segment.role === "hook" ? "开头" : segment.role === "evidence" ? "证据段" : "CTA"}</button>}</header>
          {editing ? <><TextField label={`第 ${index + 1} 段口播`} multiline required value={segment.script} onChange={script => { touch(); setPack(editSegment(pack, segment.id, { script })); }} /><TextField label={`第 ${index + 1} 段画面`} multiline required value={segment.visual} onChange={visual => { touch(); setPack(editSegment(pack, segment.id, { visual })); }} /><Field label={`第 ${index + 1} 段时长（秒）`}><input type="number" min={1} max={180} value={segment.durationSec} onChange={e => { touch(); setPack(editSegment(pack, segment.id, { durationSec: Number(e.target.value) })); }} /></Field></> : <><p className="ec-spoken">{segment.script}</p><p className="ec-visual">画面：{segment.visual}</p></>}
          <details><summary>本段事实与方法依据</summary>{([ ["claim", segment.claimIds], ["evidence", segment.evidenceIds], ["component", segment.componentIds], ["knowledge", segment.knowledgeIds], ["case", segment.caseIds] ] as const).flatMap(([type, ids]) => ids.map(id => <p key={`${type}:${id}`}>{sourceTypes[type]}：{sourceName(type, id)}</p>))}</details>
        </section>)}</div>
        {editing ? <><TextField label="拍摄清单（每行一项）" multiline value={checklist} onChange={value => { touch(); setChecklist(value); }} /><TextField label="尚待人工确认（每行一项）" multiline value={pending} hint="逐项解决后再移除；审核时会重新检查。" onChange={value => { touch(); setPending(value); }} /></> : <><details open><summary>拍摄清单</summary><ul>{splitLines(checklist).map((v, i) => <li key={i}>{v}</li>)}</ul></details>{pending.trim() && <p className="ec-notice ec-error ec-pre">待人工确认：{pending}</p>}</>}
        <details className="ec-sources"><summary>来源应用报告 · {pack.applications.filter(a => a.used).length} 条采用 / {pack.applications.length} 条提供</summary><p className="ec-muted">以下为本版本保存时的来源快照，审核与新生成会重新核对当前状态。方法解释不等于已验证的成交效果。</p>{pack.applications.map((a, i) => <details key={`${a.sourceType}:${a.sourceId}`}><summary>{sourceName(a.sourceType, a.sourceId)} · {a.used ? "实际采用" : "未采用"}</summary><p className="ec-muted">{sourceTypes[a.sourceType]} · 版本 {snapshot.sources.find(s => s.id === a.sourceId && s.type === a.sourceType)?.version}</p>{a.used && <><blockquote>{a.sourceQuote}</blockquote><p>用于：{a.segmentIds.map(id => pack.segments.findIndex(s => s.id === id) + 1).join("、")} 段</p><p className="ec-pre">实际片段：{a.draftQuote}</p></>}
          {editing ? <><TextField label={`来源 ${i + 1} 的${a.used ? "采用" : "未采用"}理由`} multiline required value={a.reason} onChange={reason => { touch(); setPack({ ...pack, applications: pack.applications.map((v, j) => i === j ? { ...v, reason } : v) }); }} />{a.used && <TextField label={`来源 ${i + 1} 的原文引用`} multiline value={a.sourceQuote} maxLength={4000} onChange={sourceQuote => { touch(); setPack({ ...pack, applications: pack.applications.map((v, j) => i === j ? { ...v, sourceQuote } : v) }); }} />}{a.sourceType === "case" && <TextField label={`案例 ${i + 1} 未迁移的内容`} multiline value={a.notTransferred} onChange={notTransferred => { touch(); setPack({ ...pack, applications: pack.applications.map((v, j) => i === j ? { ...v, notTransferred } : v) }); }} />}</> : <><p>{a.reason}</p>{a.notTransferred && <p>没有迁移：{a.notTransferred}</p>}</>}
          <details><summary>查看提供的原文</summary><p className="ec-pre">{snapshot.sources.find(s => s.id === a.sourceId && s.type === a.sourceType)?.text}</p></details>
        </details>)}</details>
        {modified && <><TextField label="本次修改说明 *" required maxLength={1000} value={summary} onChange={setSummary} /><button type="submit" className="ec-primary" aria-busy={action.busy}>保存稿件新版本</button><p className="ec-muted">保存后重新审核；口播修改会同步定位引用片段，仍需核对来源是否支持新表达。</p></>}
      </fieldset>
    </form>
    <section className="ec-section"><h3>审核此版本</h3><p className="ec-muted">审核绑定 v{version.version}，不自动沿用到下一稿。</p><fieldset className="ec-form" disabled={!enabled || modified || action.busy}><TextField label="审核或复盘意见" multiline value={note} maxLength={3000} onChange={setNote} />{detail.task.status === "internal_review" && <Checks label="逐项核对后确认" value={confirmations} values={{ facts: "商品事实与证据一致", filming: "镜头可按实际条件拍摄", destination: "CTA 与承接位置正确" }} onChange={setConfirmations} />}<div className="ec-actions">{detail.task.status === "draft" && <button type="button" disabled={Boolean(pending.trim()) || !validation.ok} onClick={() => void action.act(() => review("submit"))}>提交审核</button>}{detail.task.status === "internal_review" && <button type="button" className="ec-primary" disabled={confirmations.length !== 3} onClick={() => void action.act(() => review("approve"))}>审核通过</button>}{["internal_review", "publish_ready"].includes(detail.task.status) && <button type="button" disabled={!note.trim()} onClick={() => void action.act(() => review("changes_requested"))}>退回修改</button>}{detail.task.status === "published" && <button type="button" onClick={() => void action.act(() => review("reviewed"))}>标记已复盘</button>}{detail.task.status !== "archived" && <button type="button" className="ec-quiet" onClick={() => { if (window.confirm("归档后不能继续编辑或生成，确认归档此任务吗？")) void action.act(() => review("archive")); }}>归档任务</button>}</div></fieldset>
      {!!detail.reviews.length && <details><summary>历史审核记录</summary>{detail.reviews.map(r => <p key={r.id}>v{detail.versions.find(v => v.id === r.version_id)?.version ?? "历史"} · {r.decision === "approved" ? "通过" : r.decision === "submitted" ? "提交" : "退回"} · {displayTime(r.created_at)} · {r.note || "无附加意见"}</p>)}</details>}
    </section>
  </>;
}
