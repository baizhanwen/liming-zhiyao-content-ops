"use client";

import { useEffect, useState } from "react";
import { taskBriefSchema, type ProductPublic, type TaskBrief } from "../../lib/ecommerce/contracts";
import { Checks, Choice, ecommerceApi, Field, filmingKinds, kinds, Notices, platforms, splitLines, targets, TextField, useEcommerceAction, type ComponentRow, type Scope } from "./shared";
import { isScopeCancellation } from "../../lib/client-scope-request";
import type { EvidenceRow } from "./shared";
import type { TaskOptions, TaskRow } from "./task-types";

export function TaskForm({ scope, row, options, methods, cases, enabled, dirty, saved }: { scope: Scope; row?: TaskRow; options: TaskOptions; methods: ComponentRow[]; cases: { id: string; title: string }[]; enabled: boolean; dirty: (value: boolean) => void; saved: (id: string) => Promise<void> }) {
  const [title, setTitle] = useState(row?.title ?? ""), [versionId, setVersionId] = useState(row?.product_version_id ?? ""), [brief, setBrief] = useState<TaskBrief>(() => row ? JSON.parse(row.brief_json) : taskBriefSchema.parse({ audience: {} }));
  const [excluded, setExcluded] = useState(brief.excludedConditions.join("\n")), action = useEcommerceAction();
  const product = options.products.find(p => p.version_id === versionId), facts = product ? JSON.parse(product.public_json) as ProductPublic : null;
  const claim = facts?.claims.find(c => c.id === brief.claimId);
  const change = (values: Partial<TaskBrief>) => { setBrief(b => ({ ...b, ...values })); dirty(true); };
  function selectProduct(id: string) {
    setVersionId(id); dirty(true);
    const option = options.products.find(p => p.version_id === id), p = option ? JSON.parse(option.public_json) as ProductPublic : null;
    setBrief(b => ({ ...b, audience: p?.audience ?? taskBriefSchema.parse({ audience: {} }).audience, scene: p?.scenarios ?? "", barrier: p?.purchaseConcerns ?? "", destination: p?.landingUrl ?? "", claimId: "", evidenceIds: [] }));
  }
  return <form className="ec-panel" onSubmit={event => { event.preventDefault(); if (!product) { action.setError("请选择商品版本。"); return; } void action.act(async () => { const result = await ecommerceApi<{ task: TaskRow }>(scope, "tasks", { title, productId: product.id, productVersionId: versionId, brief: { ...brief, excludedConditions: splitLines(excluded) }, ...(row ? { id: row.id, revision: row.revision } : {}) }); dirty(false); await saved(result.task.id); }); }}>
    <header className="ec-panel-head"><div><h2>{row ? "修改任务条件" : "新建电商任务"}</h2><p className="ec-muted">一个商品、一个主要购买障碍、一个主卖点。可以先保存不完整草稿。</p></div></header><Notices error={action.error} />
    <fieldset disabled={!enabled || action.busy} className="ec-form"><TextField label="任务名称 *" required value={title} maxLength={300} onChange={v => { setTitle(v); dirty(true); }} />
      <Field label="商品版本 *"><select required value={versionId} onChange={e => selectProduct(e.target.value)}><option value="">选择一个商品版本</option>{options.products.map(p => <option key={p.version_id} value={p.version_id}>{p.name} · {p.sku} · v{p.version}{p.version === p.current_version ? "（当前）" : "（历史）"}{p.confirmed_at ? "" : " · 未确认"}</option>)}</select></Field>
      <div className="ec-grid"><TextField label="本次使用者" value={brief.audience.user} maxLength={300} onChange={user => change({ audience: { ...brief.audience, user } })} /><TextField label="本次购买决定者" value={brief.audience.buyer} maxLength={300} onChange={buyer => change({ audience: { ...brief.audience, buyer } })} /></div>
      <TextField label="购买或使用场景" multiline value={brief.scene} onChange={scene => change({ scene })} /><TextField label="主要购买障碍" multiline maxLength={1000} value={brief.barrier} onChange={barrier => change({ barrier })} />
      <details><summary>人群信息与依据</summary><div className="ec-grid">{([ ["situation", "用户当前处境"], ["trigger", "为什么此时需要"], ["alternative", "以前怎么解决"], ["concerns", "具体顾虑"], ["viewingContext", "观看情境"], ["source", "人群判断来源"] ] as const).map(([key, label]) => <TextField key={key} label={label} value={brief.audience[key]} maxLength={key === "viewingContext" ? 500 : 1000} onChange={value => change({ audience: { ...brief.audience, [key]: value } })} />)}<Choice label="人群判断状态" value={brief.audience.status} values={{ hypothesis: "待验证假设", confirmed: "已人工确认" }} onChange={status => change({ audience: { ...brief.audience, status } })} /></div></details>
      <Field label="本次只讲一个卖点"><select value={brief.claimId} onChange={e => change({ claimId: e.target.value, evidenceIds: [] })}><option value="">选择主卖点</option>{facts?.claims.map(c => <option value={c.id} key={c.id}>{c.statement}{c.status === "confirmed" ? "" : "（未确认）"}</option>)}</select></Field>
      {claim && <div className="ec-inset"><p>{claim.allowedExpression}</p>{claim.conditions && <p className="ec-muted">条件：{claim.conditions}</p>}<EvidenceChoices scope={scope} productId={product!.id} claimIds={claim.evidenceIds} value={brief.evidenceIds} onChange={evidenceIds => change({ evidenceIds })} /></div>}
      <div className="ec-grid"><Choice label="发布平台" value={brief.platform} values={platforms} onChange={platform => change({ platform })} /><Choice label="流量类型" value={brief.traffic} values={{ organic: "自然流", paid: "付费素材" }} onChange={traffic => change({ traffic })} /><Choice label="转化目标" value={brief.target} values={targets} onChange={target => change({ target })} /><Field label="目标时长（秒）"><input type="number" min={10} max={180} value={brief.durationSec} onChange={e => change({ durationSec: Number(e.target.value) })} /></Field></div>
      <TextField label="承接位置与动作" value={brief.destination} hint="例如当前商品卡查看规格；直播进房应注明直播间及进房动作。" onChange={destination => change({ destination })} /><Checks label="实际拍摄条件" value={brief.filming} values={filmingKinds} onChange={filming => change({ filming })} /><TextField label="拍摄条件补充" value={brief.filmingNotes} maxLength={1000} onChange={filmingNotes => change({ filmingNotes })} />
      <details><summary>可选参考与方法</summary><p className="ec-muted">未勾选品牌知识不会进入生成。未指定方法时，系统按本次条件推荐；项目记忆不进入电商生成。</p><Checks label="品牌知识（最多 5 条）" value={brief.knowledgeIds} values={Object.fromEntries(options.knowledge.map(k => [k.id, k.title]))} onChange={knowledgeIds => { if (knowledgeIds.length <= 5) change({ knowledgeIds }); }} />
        {options.knowledge.filter(k => brief.knowledgeIds.includes(k.id)).map(k => <details key={k.id}><summary>{k.title} · v{k.current_version}</summary><p className="ec-pre">{k.body}</p></details>)}
        <Checks label="指定参考案例（最多 3 个）" value={brief.caseIds} values={Object.fromEntries(cases.map(c => [c.id, c.title]))} onChange={caseIds => { if (caseIds.length <= 3) change({ caseIds }); }} />
        <div className="ec-grid">{Object.entries(kinds).map(([kind, label]) => <Field key={kind} label={`指定${label}`}><select value={brief.componentIds.find(id => methods.some(m => m.id === id && m.kind === kind)) ?? ""} onChange={e => change({ componentIds: [...brief.componentIds.filter(id => !methods.some(m => m.id === id && m.kind === kind)), ...e.target.value ? [e.target.value] : []] })}><option value="">由系统推荐</option>{methods.filter(m => m.kind === kind && m.status === "confirmed").map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>)}</div>
        <TextField label="本次禁用条件（每行一条）" multiline value={excluded} onChange={value => { setExcluded(value); dirty(true); }} />
      </details>
      <details open><summary>核心内容策略 · 自动读取</summary>{options.strategy ? <><p>{options.strategy.positioning}</p><p className="ec-muted">受众：{options.strategy.targetAudience}</p><p className="ec-muted">风格：{options.strategy.styleNotes}</p></> : <p className="ec-muted">请先在企业空间补齐核心内容策略，再生成。</p>}<TextField label="本次策略例外说明（可留空）" multiline value={brief.strategyException} onChange={strategyException => change({ strategyException })} /></details>
      <TextField label="本次补充要求" multiline value={brief.instructions} onChange={instructions => change({ instructions })} /><div className="ec-actions"><button className="ec-primary" type="submit" aria-busy={action.busy}>保存任务{row ? "条件" : "草稿"}</button>{row && <small className="ec-muted">修改条件后需生成或保存适用新稿，原审核不沿用。</small>}</div>
    </fieldset>
  </form>;
}

function EvidenceChoices({ scope, productId, claimIds, value, onChange }: { scope: Scope; productId: string; claimIds: string[]; value: string[]; onChange: (ids: string[]) => void }) {
  const [rows, setRows] = useState<EvidenceRow[]>([]), [error, setError] = useState("");
  useEffect(() => { let active = true; ecommerceApi<{ evidence: EvidenceRow[] }>(scope, `evidence?productId=${encodeURIComponent(productId)}`).then(data => { if (active) setRows(data.evidence); }).catch(e => { if (active && !isScopeCancellation(e)) setError(e.message); }); return () => { active = false; }; }, [scope, productId]);
  return <><Notices error={error} /><Checks label="本次采用的卖点证据（最多 5 条）" value={value} values={Object.fromEntries(rows.filter(r => claimIds.includes(r.id)).map(r => [r.id, `${r.title}${r.status === "confirmed" ? "" : "（未确认或已撤回）"}`]))} onChange={ids => { if (ids.length <= 5) onChange(ids); }} /></>;
}
