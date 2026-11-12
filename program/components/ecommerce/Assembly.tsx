"use client";

import { useEffect, useRef, useState } from "react";
import type { EcommercePack } from "../../lib/ecommerce/contracts";
import { Checks, displayTime, ecommerceApi, Field, Notices, platforms, splitLines, targets, TextField, useEcommerceAction, type Scope } from "./shared";
import { editSegment, roles, scriptText, sourceTypes, type SourceSnapshot, type TaskDetail, type Version } from "./task-types";

type WritingView = "read" | "segments" | "sources" | "review";
const writingViews = { read: "完整文案", segments: "逐段调整", sources: "方法与依据", review: "审核记录" } as const;
const qualityCriteria: Record<string, string> = { hook: "开头吸引力", decision_value: "购买判断价值", concrete_detail: "具体信息", spoken_voice: "口播表达", method_execution: "方法执行", action_reason: "行动理由" };

export function Assembly({ scope, detail, enabled, canReplace = true, dirty, changed, replace }: { scope: Scope; detail: TaskDetail; enabled: boolean; canReplace?: boolean; dirty: (value: boolean) => void; changed: () => Promise<void>; replace: (role: "hook" | "evidence" | "cta") => Promise<void> }) {
  const [selectedId, setSelectedId] = useState(detail.versions[0]?.id ?? ""), [edited, setEdited] = useState(false);
  const version = detail.versions.find(v => v.id === selectedId);
  const updateDirty = (value: boolean) => { setEdited(value); dirty(value); };
  if (!version) return <section className="ec-manuscript ec-empty-manuscript"><h2>下一篇好文案，从具体信息开始</h2><p>确认本次要求后生成。这里将展示可以直接阅读、复制和修改的完整口播稿。</p><div className="ec-empty-flow"><span>明确切入角度</span><span>写清商品价值</span><span>给出行动理由</span></div></section>;
  return <section className="ec-manuscript"><header className="ec-manuscript-bar"><div><span className="ec-eyebrow">文案工作区</span><p className="ec-muted">{displayTime(version.created_at)}</p></div><Field label="查看文案版本"><select value={selectedId} onChange={e => { if (!edited || window.confirm("放弃尚未保存的稿件修改并切换版本吗？")) { updateDirty(false); setSelectedId(e.target.value); } }}>{detail.versions.map(v => <option key={v.id} value={v.id}>v{v.version} · {v.mode === "manual" ? "人工修改" : v.mode === "patch" ? "局部替换" : "AI 生成"}</option>)}</select></Field></header>
    <PackEditor key={version.id} scope={scope} detail={detail} version={version} enabled={enabled && version.version === detail.task.current_version} canReplace={canReplace} dirty={updateDirty} changed={changed} replace={replace} />
  </section>;
}

function PackEditor({ scope, detail, version, enabled, canReplace, dirty, changed, replace }: { scope: Scope; detail: TaskDetail; version: Version; enabled: boolean; canReplace: boolean; dirty: (value: boolean) => void; changed: () => Promise<void>; replace: (role: "hook" | "evidence" | "cta") => Promise<void> }) {
  const [pack, setPack] = useState<EcommercePack>(() => JSON.parse(version.pack_json)), [editing, setEditing] = useState(false), [modified, setModified] = useState(false), [summary, setSummary] = useState("");
  const [view, setView] = useState<WritingView>("read"), [pending, setPending] = useState(pack.pendingConfirmations.join("\n"));
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [note, setNote] = useState(""), [confirmations, setConfirmations] = useState<string[]>([]), action = useEcommerceAction();
  const snapshot = JSON.parse(version.input_snapshot_json) as SourceSnapshot;
  const copyDirection = snapshot.plan?.copyDirection;
  const brief = snapshot.task?.brief;
  const validation = JSON.parse(version.validation_json) as { ok: boolean; issues?: string[]; review?: { editorialReview?: { verdict: "usable" | "needs_rewrite" | "needs_facts"; summary: string; checks: { criterion: string; passed: boolean; segmentIds: string[]; quote: string; reason: string }[]; missingFacts: string[] } } };
  const editorial = validation.review?.editorialReview;
  const selectedMethods = snapshot.copyMethodology?.selectedMethods;
  const characterCount = Array.from(scriptText(pack).replace(/\s+/g, "")).length;
  const touch = () => { setModified(true); dirty(true); };
  const sourceName = (type: string, id: string) => snapshot.sources.find(s => s.type === type && s.id === id)?.title ?? "历史资料";
  async function review(decision: string) {
    await ecommerceApi(scope, `tasks/${detail.task.id}/review`, { revision: detail.task.revision, versionId: version.id, action: decision, note, confirmations });
    if (!mounted.current) return;
    await changed(); if (mounted.current) { setNote(""); setConfirmations([]); }
  }
  async function download() {
    const data = new Blob([`${pack.title}\n\n${scriptText(pack)}`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(data), a = document.createElement("a"); a.href = url; a.download = `电商文案-v${version.version}.txt`; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copy() {
    if (!navigator.clipboard) throw new Error("当前浏览器不能直接复制，请使用导出文案。");
    await navigator.clipboard.writeText(`${pack.title}\n\n${scriptText(pack)}`);
    setCopied(true);
  }
  return <><div className="ec-manuscript-controls"><nav className="ec-writing-tabs" aria-label="文案查看方式">{Object.entries(writingViews).map(([key, label]) => <button key={key} type="button" aria-current={view === key ? "page" : undefined} onClick={() => setView(key as WritingView)}>{label}</button>)}</nav><div className="ec-actions ec-copy-tools"><button type="button" className="ec-primary" disabled={modified || action.busy} onClick={() => void action.act(copy)}>{copied ? "已复制" : "复制全文"}</button><button type="button" disabled={!enabled || action.busy} onClick={() => { setEditing(!editing); setView(editing ? "read" : "segments"); }}>{editing ? "预览文案" : "编辑文案"}</button><button type="button" disabled={modified || action.busy} onClick={() => void action.act(download)}>导出文案</button></div></div>
    <div className="ec-manuscript-notices"><Notices error={action.error} message={action.message} />{!validation.ok && <p className="ec-notice ec-error">本稿待修正：{validation.issues?.join("；")}</p>}{!editing && pending.trim() && <details className="ec-pending"><summary>有 {splitLines(pending).length} 项内容待确认</summary><p className="ec-pre">{pending}</p></details>}</div>
    <form onSubmit={event => { event.preventDefault(); void action.act(async () => { await ecommerceApi(scope, `tasks/${detail.task.id}/versions`, { revision: detail.task.revision, baseVersion: version.version, pack: { ...pack, pendingConfirmations: splitLines(pending) }, changeSummary: summary }); if (!mounted.current) return; dirty(false); await changed(); }); }}>
      <fieldset disabled={!enabled || action.busy} className="ec-form">
        {view === "read" && <article className="ec-reading-page" aria-label="完整口播文案"><div className="ec-reading-meta"><span>{brief ? platforms[brief.platform] : "口播文案"}</span><span>{brief?.durationSec ?? pack.segments.reduce((sum, s) => sum + s.durationSec, 0)} 秒</span><span>{characterCount} 字</span><span>{snapshot.product.name}</span></div><h2 className="ec-reading-title">{pack.title}</h2><div className="ec-reading-body">{pack.segments.map(segment => <p key={segment.id}>{segment.script}</p>)}</div><footer className="ec-reading-foot"><span>v{version.version} · {version.mode === "manual" ? "人工修改" : "AI 生成"}</span><span>{editorial ? editorial.verdict === "usable" ? "已完成内容校对 · 发布前仍需确认" : "内容待完善" : "历史草稿 · 尚未进行新版内容校对"}</span><span>{brief ? targets[brief.target] : ""}</span></footer></article>}
        {view === "segments" && <div className="ec-support-pane"><div className="ec-pane-heading"><h3>{editing ? "编辑与保存" : "逐段打磨"}</h3><p>围绕已有主线调整，局部替换会保留其他段落。</p></div>{editing && <TextField label="文案标题" value={pack.title} required maxLength={300} onChange={title => { touch(); setPack({ ...pack, title }); }} />}
          <div className="ec-script">{pack.segments.map((segment, index) => <section className="ec-segment" key={segment.id}><header><strong><span className="ec-segment-number">{String(index + 1).padStart(2, "0")}</span>{roles[segment.role]}</strong>{["hook", "evidence", "cta"].includes(segment.role) && <button type="button" disabled={!enabled || !canReplace || modified || action.busy} onClick={() => void replace(segment.role as "hook" | "evidence" | "cta")}>只替换{segment.role === "hook" ? "开头" : segment.role === "evidence" ? "依据段" : "行动引导"}</button>}</header>
            {editing ? <TextField label={`第 ${index + 1} 段文案`} multiline required value={segment.script} onChange={script => { touch(); setPack(editSegment(pack, segment.id, { script })); }} /> : <p className="ec-spoken">{segment.script}</p>}
          </section>)}</div>
          {editing && <TextField label="尚待人工确认（每行一项）" multiline value={pending} hint="逐项解决后再移除；审核时会重新检查。" onChange={value => { touch(); setPending(value); }} />}
        </div>}
        {view === "sources" && <div className="ec-support-pane"><div className="ec-pane-heading"><h3>为什么这样写</h3><p>查看采用的方法与商品依据，核对重要表达。</p></div>
          {selectedMethods && <section className="ec-used-methods"><div className="ec-method-pair">{[selectedMethods.hook, selectedMethods.framework, selectedMethods.supplement].filter(method => method != null).map(method => <div key={method.id}><span className="ec-eyebrow">{method.id === selectedMethods.hook.id ? "开头方法" : method.id === selectedMethods.framework.id ? "主体框架" : "补充框架"}</span><h3>{method.name}</h3><details><summary>查看方法原文</summary><p className="ec-muted">{method.source.document.split("/").at(-1)?.replace(/\.md$/, "")} · 原文出处</p><blockquote>{method.source.excerpt}</blockquote></details></div>)}</div><p className="ec-method-reason">{selectedMethods.reason}</p></section>}
          {selectedMethods && snapshot.plan?.outline?.length && <details className="ec-method-beats"><summary>结构如何落到正文</summary><ol>{snapshot.plan.outline.map(step => { const segment = pack.segments.find(item => item.id === step.id); return <li key={step.id}><strong>{step.methodBeats.filter(beat => beat !== "action").join(" / ") || roles[step.role as keyof typeof roles] || "内容推进"}</strong><p>{step.purpose}</p>{segment && <blockquote>{segment.script}</blockquote>}</li>; })}</ol></details>}
          {editorial && <details className="ec-editorial-check"><summary>内容校对 · {editorial.verdict === "usable" ? "已完成" : "待完善"}</summary><p>{editorial.summary}</p><ul>{editorial.checks.map(check => <li key={check.criterion}><strong>{check.passed ? "✓" : "待改"} {qualityCriteria[check.criterion] ?? "内容检查"}</strong><p>{check.reason}</p>{check.quote && <blockquote>{check.quote}</blockquote>}</li>)}</ul></details>}
          {copyDirection && <section className="ec-direction"><h3>本稿创作思路</h3><dl>{([ ["hook", "切入角度"], ["bridge", "卖点推进"], ["proof", "具体依据"], ["cta", "行动理由"], ["referenceAdaptation", "参考改写"] ] as const).filter(([key]) => copyDirection[key]?.trim()).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{copyDirection[key]}</dd></div>)}</dl><p className="ec-muted">思路记录于生成时；人工修改后，请重新核对与正文是否一致。</p></section>}
          <details className="ec-sources"><summary>来源应用报告 · {pack.applications.filter(a => a.used).length} 条采用 / {pack.applications.length} 条提供</summary><p className="ec-muted">仅展示本稿保存时的资料。方法说明不能证明商品效果。</p>{pack.applications.map((a, i) => <details key={`${a.sourceType}:${a.sourceId}`}><summary>{sourceName(a.sourceType, a.sourceId)} · {a.used ? "实际采用" : "未采用"}</summary><p className="ec-muted">{sourceTypes[a.sourceType]}</p>{a.used && <><blockquote>{a.sourceQuote}</blockquote><p>用于第 {a.segmentIds.map(id => pack.segments.findIndex(s => s.id === id) + 1).join("、")} 段</p><p className="ec-pre">文案片段：{a.draftQuote}</p></>}
            {editing ? <><TextField label={`来源 ${i + 1} 的${a.used ? "采用" : "未采用"}理由`} multiline required value={a.reason} onChange={reason => { touch(); setPack({ ...pack, applications: pack.applications.map((v, j) => i === j ? { ...v, reason } : v) }); }} />{a.used && <TextField label={`来源 ${i + 1} 的原文引用`} multiline value={a.sourceQuote} maxLength={4000} onChange={sourceQuote => { touch(); setPack({ ...pack, applications: pack.applications.map((v, j) => i === j ? { ...v, sourceQuote } : v) }); }} />}{a.sourceType === "case" && <TextField label={`案例 ${i + 1} 未迁移的内容`} multiline value={a.notTransferred} onChange={notTransferred => { touch(); setPack({ ...pack, applications: pack.applications.map((v, j) => i === j ? { ...v, notTransferred } : v) }); }} />}</> : <><p>{a.reason}</p>{a.notTransferred && <p>未借用的事实：{a.notTransferred}</p>}</>}
            <details><summary>查看提供的原文</summary><p className="ec-pre">{snapshot.sources.find(s => s.id === a.sourceId && s.type === a.sourceType)?.text}</p></details>
          </details>)}</details>
        </div>}
        {modified && <div className="ec-save-draft"><TextField label="本次修改说明 *" required maxLength={1000} value={summary} onChange={setSummary} /><button type="submit" className="ec-primary" aria-busy={action.busy}>保存文案新版本</button><p className="ec-muted">保存后重新审核，原稿保留。</p></div>}
      </fieldset>
    </form>
    {view === "review" && <section className="ec-support-pane"><div className="ec-pane-heading"><h3>审核此版本</h3><p>审核绑定 v{version.version}，新稿需要重新确认。</p></div><fieldset className="ec-form" disabled={!enabled || modified || action.busy}><TextField label="审核意见" multiline value={note} maxLength={3000} onChange={setNote} />{detail.task.status === "internal_review" && <Checks label="逐项核对后确认" value={confirmations} values={{ facts: "商品事实与证据一致", destination: "行动引导与承接位置正确" }} onChange={setConfirmations} />}<div className="ec-actions">{detail.task.status === "draft" && <button type="button" className="ec-primary" disabled={Boolean(pending.trim()) || !validation.ok} onClick={() => void action.act(() => review("submit"))}>提交审核</button>}{detail.task.status === "internal_review" && <button type="button" className="ec-primary" disabled={confirmations.length !== 2} onClick={() => void action.act(() => review("approve"))}>审核通过</button>}{["internal_review", "publish_ready"].includes(detail.task.status) && <button type="button" disabled={!note.trim()} onClick={() => void action.act(() => review("changes_requested"))}>退回修改</button>}{detail.task.status !== "archived" && <button type="button" className="ec-quiet" onClick={() => { if (window.confirm("归档后不能继续编辑或生成，确认归档此任务吗？")) void action.act(() => review("archive")); }}>归档任务</button>}</div></fieldset>
      {!!detail.reviews.length && <details className="ec-review-history"><summary>历史审核记录</summary>{detail.reviews.map(r => <p key={r.id}>v{detail.versions.find(v => v.id === r.version_id)?.version ?? "历史"} · {r.decision === "approved" ? "通过" : r.decision === "submitted" ? "提交" : "退回"} · {displayTime(r.created_at)} · {r.note || "无附加意见"}</p>)}</details>}
    </section>}
  </>;
}
