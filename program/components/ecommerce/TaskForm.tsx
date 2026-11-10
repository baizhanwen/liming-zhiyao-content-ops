"use client";

import { useEffect, useRef, useState } from "react";
import type { ProductPublic, TaskBrief } from "../../lib/ecommerce/contracts";
import { Checks, Choice, ecommerceApi, Field, filmingKinds, kinds, Notices, platforms, splitLines, targets, TextField, useEcommerceAction, type ComponentRow, type Scope } from "./shared";
import { firstVideoTaskTitle, initialTaskDraft, taskBriefForProduct, taskQuestionOptions } from "../../lib/ecommerce/task-question-options";
import { TaskDurationQuestion, TaskQuestion } from "./TaskQuestion";
import { isScopeCancellation } from "../../lib/client-scope-request";
import type { EvidenceRow } from "./shared";
import type { TaskOptions, TaskRow } from "./task-types";

export function TaskForm({ scope, row, options, methods, cases, enabled, dirty, saved, guided = false, initialProductVersionId = "" }: { scope: Scope; row?: TaskRow; options: TaskOptions; methods: ComponentRow[]; cases: { id: string; title: string }[]; enabled: boolean; dirty: (value: boolean) => void; saved: (id: string) => Promise<void>; guided?: boolean; initialProductVersionId?: string }) {
  // Apply guide defaults only on first mount. A parent refresh must not replace unsaved answers.
  const [draft] = useState(() => initialTaskDraft({ row, products: options.products, initialProductVersionId, guided }));
  const [title, setTitle] = useState(draft.title), [versionId, setVersionId] = useState(draft.versionId), [brief, setBrief] = useState<TaskBrief>(draft.brief);
  const [excluded, setExcluded] = useState(brief.excludedConditions.join("\n")), action = useEcommerceAction();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const product = options.products.find(p => p.version_id === versionId), facts = product ? JSON.parse(product.public_json) as ProductPublic : null;
  const claim = facts?.claims.find(c => c.id === brief.claimId);
  const change = (values: Partial<TaskBrief>) => { setBrief(b => ({ ...b, ...values })); dirty(true); };
  function selectProduct(id: string) {
    setVersionId(id); dirty(true);
    const option = options.products.find(p => p.version_id === id), p = option ? JSON.parse(option.public_json) as ProductPublic : null;
    setBrief(b => taskBriefForProduct(b, p));
    if (guided && !row && !title.trim() && option) setTitle(firstVideoTaskTitle(option.name));
  }
  const productFields = <><TextField label="任务名称 *" required value={title} maxLength={300} onChange={v => { setTitle(v); dirty(true); }} />
    <Field label="商品版本 *"><select required value={versionId} onChange={e => selectProduct(e.target.value)}><option value="">选择一个商品版本</option>{options.products.map(p => <option key={p.version_id} value={p.version_id}>{p.name} · {p.sku} · v{p.version}{p.version === p.current_version ? "（当前）" : "（历史）"}{p.confirmed_at ? "" : " · 未确认"}</option>)}</select></Field></>;
  return <form className="ec-panel" onSubmit={event => { event.preventDefault(); if (!product) { action.setError("请选择商品版本。"); return; } void action.act(async () => { const result = await ecommerceApi<{ task: TaskRow }>(scope, "tasks", { title, productId: product.id, productVersionId: versionId, brief: { ...brief, excludedConditions: splitLines(excluded) }, ...(row ? { id: row.id, revision: row.revision } : {}) }); if (!mounted.current) return; dirty(false); await saved(result.task.id); }); }}>
    <header className="ec-panel-head"><div><h2>{row ? "修改任务条件" : guided ? "设置第一条视频" : "新建电商任务"}</h2><p className="ec-muted">选好人群、场景和一个卖点，再保存任务。常见答案可直接选，特殊情况自行填写。</p></div></header><Notices error={action.error} />
    <fieldset disabled={!enabled || action.busy} className="ec-form">
      {guided && product ? <><p className="ec-muted">本次商品：{product.name} · {product.sku} · v{product.version}</p><details><summary>任务名称与商品版本</summary>{productFields}</details></> : productFields}
      <div className="ec-grid"><TaskQuestion key={`${versionId}:user`} label="本次使用者" value={brief.audience.user} options={taskQuestionOptions.user} maxLength={300} onChange={user => change({ audience: { ...brief.audience, user } })} /><TaskQuestion key={`${versionId}:buyer`} label="本次购买决定者" value={brief.audience.buyer} options={taskQuestionOptions.buyer} maxLength={300} onChange={buyer => change({ audience: { ...brief.audience, buyer } })} /></div>
      <TaskQuestion key={`${versionId}:scene`} label="购买或使用场景" value={brief.scene} options={taskQuestionOptions.scene} multiline maxLength={2000} onChange={scene => change({ scene })} />
      <TaskQuestion key={`${versionId}:barrier`} label="主要购买障碍" value={brief.barrier} options={taskQuestionOptions.barrier} multiline maxLength={1000} hint="选择本条视频要解决的一个主要顾虑；这些判断仍需结合真实用户核对。" onChange={barrier => change({ barrier })} />
      <details><summary>更多人群信息与判断依据</summary><div className="ec-grid">{([ ["situation", "用户当前处境"], ["trigger", "为什么此时需要"], ["alternative", "以前怎么解决"], ["concerns", "具体顾虑"], ["viewingContext", "观看情境"], ["source", "人群判断来源"] ] as const).map(([key, label]) => <TextField key={key} label={label} value={brief.audience[key]} maxLength={key === "viewingContext" ? 500 : 1000} onChange={value => change({ audience: { ...brief.audience, [key]: value } })} />)}<Choice label="人群判断状态" value={brief.audience.status} values={{ hypothesis: "待验证假设", confirmed: "已人工确认" }} onChange={status => change({ audience: { ...brief.audience, status } })} /></div></details>
      <Field label="本次只讲一个卖点"><select value={brief.claimId} onChange={e => change({ claimId: e.target.value, evidenceIds: [] })}><option value="">选择主卖点</option>{facts?.claims.map(c => <option value={c.id} key={c.id}>{c.statement}{c.status === "confirmed" ? "" : "（未确认）"}</option>)}</select></Field>
      {claim && <div className="ec-inset"><p>{claim.allowedExpression}</p>{claim.conditions && <p className="ec-muted">条件：{claim.conditions}</p>}<EvidenceChoices scope={scope} productId={product!.id} claimIds={claim.evidenceIds} value={brief.evidenceIds} onChange={evidenceIds => change({ evidenceIds })} /></div>}
      <div className="ec-grid"><Choice label="发布平台" value={brief.platform} values={platforms} onChange={platform => change({ platform })} /><Choice label="流量类型" value={brief.traffic} values={{ organic: "自然流", paid: "付费素材" }} onChange={traffic => change({ traffic })} /><Choice label="希望观众做什么" value={brief.target} values={targets} onChange={target => change({ target })} /></div>
      <TaskDurationQuestion value={brief.durationSec} onChange={durationSec => change({ durationSec })} />
      <TaskQuestion key={`${versionId}:destination`} label="承接位置与动作" value={brief.destination} options={taskQuestionOptions.destination} multiline maxLength={2000} hint="按实际可访问的位置选择，也可填写具体商品卡、直播间或其他承接说明。" onChange={destination => change({ destination })} />
      <Checks label="实际拍摄条件（可多选）" value={brief.filming} values={filmingKinds} onChange={filming => change({ filming })} />
      <details><summary>补充拍摄条件{brief.filmingNotes ? " · 已填写" : ""}</summary><TextField label="拍摄条件补充" value={brief.filmingNotes} maxLength={1000} onChange={filmingNotes => change({ filmingNotes })} /></details>
      <details><summary>更多参考与方法{brief.knowledgeIds.length + brief.caseIds.length + brief.componentIds.length > 0 ? ` · 已选择 ${brief.knowledgeIds.length + brief.caseIds.length + brief.componentIds.length} 项` : " · 可选"}</summary><p className="ec-muted">未勾选品牌知识不会进入生成。未指定方法时，系统按本次条件推荐；项目记忆不进入电商生成。</p><Checks label="品牌知识（最多 5 条）" value={brief.knowledgeIds} values={Object.fromEntries(options.knowledge.map(k => [k.id, k.title]))} onChange={knowledgeIds => { if (knowledgeIds.length <= 5) change({ knowledgeIds }); }} />
        {options.knowledge.filter(k => brief.knowledgeIds.includes(k.id)).map(k => <details key={k.id}><summary>{k.title} · v{k.current_version}</summary><p className="ec-pre">{k.body}</p></details>)}
        <Checks label="指定参考案例（最多 3 个）" value={brief.caseIds} values={Object.fromEntries(cases.map(c => [c.id, c.title]))} onChange={caseIds => { if (caseIds.length <= 3) change({ caseIds }); }} />
        <div className="ec-grid">{Object.entries(kinds).map(([kind, label]) => <Field key={kind} label={`指定${label}`}><select value={brief.componentIds.find(id => methods.some(m => m.id === id && m.kind === kind)) ?? ""} onChange={e => change({ componentIds: [...brief.componentIds.filter(id => !methods.some(m => m.id === id && m.kind === kind)), ...e.target.value ? [e.target.value] : []] })}><option value="">由系统推荐</option>{methods.filter(m => m.kind === kind && m.status === "confirmed").map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>)}</div>
        <TextField label="本次禁用条件（每行一条）" multiline value={excluded} onChange={value => { setExcluded(value); dirty(true); }} />
      </details>
      <details open={!options.strategy}><summary>空间内容策略与本次例外{options.strategy ? " · 已读取" : " · 待补齐"}</summary>{options.strategy ? <><p>{options.strategy.positioning}</p><p className="ec-muted">受众：{options.strategy.targetAudience}</p><p className="ec-muted">风格：{options.strategy.styleNotes}</p></> : <p className="ec-muted">请先在企业空间补齐核心内容策略，再生成。</p>}<TextField label="本次策略例外说明（可留空）" multiline value={brief.strategyException} onChange={strategyException => change({ strategyException })} /></details>
      <TextField label="本次补充要求" multiline value={brief.instructions} onChange={instructions => change({ instructions })} /><div className="ec-actions"><button className="ec-primary" type="submit" aria-busy={action.busy}>{row ? "保存任务条件" : guided ? "保存并进入生成" : "保存任务草稿"}</button>{row && <small className="ec-muted">修改条件后需生成或保存适用新稿，原审核不沿用。</small>}</div>
    </fieldset>
  </form>;
}

function EvidenceChoices({ scope, productId, claimIds, value, onChange }: { scope: Scope; productId: string; claimIds: string[]; value: string[]; onChange: (ids: string[]) => void }) {
  const [rows, setRows] = useState<EvidenceRow[]>([]), [error, setError] = useState("");
  useEffect(() => { let active = true; ecommerceApi<{ evidence: EvidenceRow[] }>(scope, `evidence?productId=${encodeURIComponent(productId)}`).then(data => { if (active) setRows(data.evidence); }).catch(e => { if (active && !isScopeCancellation(e)) setError(e.message); }); return () => { active = false; }; }, [scope, productId]);
  return <><Notices error={error} /><Checks label="本次采用的卖点证据（最多 5 条）" value={value} values={Object.fromEntries(rows.filter(r => claimIds.includes(r.id)).map(r => [r.id, `${r.title}${r.status === "confirmed" ? "" : "（未确认或已撤回）"}`]))} onChange={ids => { if (ids.length <= 5) onChange(ids); }} /></>;
}
