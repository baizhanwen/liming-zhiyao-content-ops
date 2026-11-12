"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { taskReferenceMode, type ProductPublic, type TaskBrief } from "../../lib/ecommerce/contracts";
import { Checks, Choice, displayTime, ecommerceApi, Field, Notices, platforms, splitLines, targets, TextField, useEcommerceAction, type ComponentRow, type Scope } from "./shared";
import { copyTaskBriefForSubmission, initialTaskDraft, productCopyTaskTitle, taskBriefForProduct, taskQuestionOptions } from "../../lib/ecommerce/task-question-options";
import { TaskDurationQuestion, TaskQuestion } from "./TaskQuestion";
import { isScopeCancellation } from "../../lib/client-scope-request";
import { type BenchmarkReference, type TaskCaseOption, type TaskOptions, type TaskRow } from "./task-types";

type TaskFormProps = {
  scope: Scope; row?: TaskRow; options: TaskOptions; methods: ComponentRow[]; cases: TaskCaseOption[]; references?: BenchmarkReference[];
  enabled: boolean; dirty: (value: boolean) => void; saved: (id: string) => Promise<void>; discard?: () => boolean;
  onPrepareMethods?: () => void; guided?: boolean; initialProductVersionId?: string;
};
const referenceKey = (reference: { reference_id: string; analysis_id: string }) => `reference:${reference.reference_id}:${reference.analysis_id}`;

export function TaskForm({ scope, row, options, cases, references = [], enabled, dirty, saved, discard, guided = false, initialProductVersionId = "" }: TaskFormProps) {
  // Apply saved values and product defaults once; background refreshes cannot replace a draft.
  const [draft] = useState(() => initialTaskDraft({ row, products: options.products, initialProductVersionId, guided }));
  const [title, setTitle] = useState(draft.title), [versionId, setVersionId] = useState(draft.versionId), [brief, setBrief] = useState<TaskBrief>({ ...draft.brief, referenceMode: taskReferenceMode(draft.brief) });
  const usesReference = taskReferenceMode(brief) === "benchmark";
  const [excluded, setExcluded] = useState(brief.excludedConditions.join("\n")), action = useEcommerceAction();
  const [autoTranscript, setAutoTranscript] = useState(false);
  const [audienceExpanded, setAudienceExpanded] = useState(!brief.audience.user || !brief.audience.buyer || !brief.scene || !brief.barrier);
  const autoTitle = useRef(row ? "" : draft.title), benchmarkSelection = useRef(brief.benchmark), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const product = options.products.find(item => item.version_id === versionId);
  const selectedReference = brief.benchmark ? references.find(reference => reference.reference_id === brief.benchmark!.referenceId && reference.analysis_id === brief.benchmark!.analysisId) : null;
  const selectedCase = !brief.benchmark ? cases.find(item => item.id === brief.caseIds[0]) : null;
  const selectedBenchmarkKey = brief.benchmark ? `reference:${brief.benchmark.referenceId}:${brief.benchmark.analysisId}` : selectedCase ? `case:${selectedCase.id}` : "";
  const sourceReference = brief.benchmark ?? (selectedCase?.referenceId && selectedCase.analysisId ? { referenceId: selectedCase.referenceId, analysisId: selectedCase.analysisId, transcriptId: selectedCase.transcriptId ?? null } : null);
  const strategyUrl = `/knowledge?${new URLSearchParams({ ...scope, tab: "strategy", from: "ecommerce" })}`;
  const benchmarkUrl = `/analysis?${new URLSearchParams({ ...scope, view: "benchmark" })}`;
  const change = (values: Partial<TaskBrief>) => { if ("benchmark" in values) benchmarkSelection.current = values.benchmark ?? null; setBrief(b => ({ ...b, ...values })); dirty(true); };
  const leaveForm = (event: MouseEvent<HTMLAnchorElement>) => { if (discard && !discard()) event.preventDefault(); else dirty(false); };

  function selectProduct(id: string) {
    setVersionId(id); dirty(true);
    const option = options.products.find(p => p.version_id === id), publicData = option ? JSON.parse(option.public_json) as ProductPublic : null;
    const next = taskBriefForProduct(brief, publicData);
    setBrief(next); setAudienceExpanded(!next.audience.user || !next.audience.buyer || !next.scene || !next.barrier);
    if (!row && option && (!title.trim() || title === autoTitle.current)) {
      const nextTitle = productCopyTaskTitle(option.name); autoTitle.current = nextTitle; setTitle(nextTitle);
    }
  }
  function chooseBenchmark(value: string) {
    const reference = references.find(item => referenceKey(item) === value), profile = cases.find(item => `case:${item.id}` === value);
    setAutoTranscript(Boolean(reference));
    if (reference) change({ referenceMode: "benchmark", benchmark: { referenceId: reference.reference_id, analysisId: reference.analysis_id, transcriptId: null }, caseIds: [] });
    else if (profile) change({ referenceMode: "benchmark", benchmark: null, caseIds: [profile.id] });
    else change({ referenceMode: "benchmark", benchmark: null, caseIds: [] });
  }
  function toggleReference(enabled: boolean) {
    setAutoTranscript(false);
    change({ referenceMode: enabled ? "benchmark" : "method", ...(!enabled ? { benchmark: null, caseIds: [] } : {}) });
  }
  function selectTranscript(referenceId: string, analysisId: string, transcriptId: string | null) {
    if (!mounted.current || benchmarkSelection.current?.referenceId !== referenceId || benchmarkSelection.current.analysisId !== analysisId) return;
    benchmarkSelection.current = { ...benchmarkSelection.current, transcriptId };
    setAutoTranscript(false);
    setBrief(current => current.benchmark?.referenceId === referenceId && current.benchmark.analysisId === analysisId
      ? { ...current, benchmark: { ...current.benchmark, transcriptId } } : current);
    dirty(true);
  }
  const productFields = <div className="ec-grid"><TextField label="任务名称 *" required value={title} maxLength={300} onChange={value => { setTitle(value); dirty(true); }} />
    <Field label="选择商品 *"><select required value={versionId} onChange={event => selectProduct(event.target.value)}><option value="">选择一个商品版本</option>{options.products.map(item => <option key={item.version_id} value={item.version_id}>{item.name} · v{item.version}{item.version === item.current_version ? "（当前）" : "（历史）"}{item.confirmed_at ? "" : " · 未确认"}</option>)}</select></Field></div>;

  return <form className="ec-panel ec-task-form" onSubmit={event => {
    event.preventDefault();
    if (!product) { action.setError("请先选择已补全资料的商品。"); return; }
    if (usesReference && !brief.benchmark && !selectedCase) { action.setError("请选择一个已分析的对标带货视频，或关闭参考视频后按方法论生成。"); return; }
    const selectedBrief = copyTaskBriefForSubmission({ ...brief, excludedConditions: splitLines(excluded) });
    void action.act(async () => {
      const result = await ecommerceApi<{ task: TaskRow }>(scope, "tasks", { title, productId: product.id, productVersionId: versionId, brief: selectedBrief, ...(row ? { id: row.id, revision: row.revision } : {}) });
      if (!mounted.current) return; dirty(false); await saved(result.task.id);
    });
  }}>
    <header className="ec-panel-head"><div><span className="ec-eyebrow">创作准备</span><h2>{row ? "修改文案要求" : "新建文案任务"}</h2><p className="ec-muted">选一个商品，明确这篇要打动谁、回应什么问题。其余交给内容方法论。</p></div></header><Notices error={action.error} />
    <fieldset disabled={!enabled || action.busy} className="ec-form">
      {productFields}
      {!options.products.length && <p className="ec-muted">请先在“商品资料”补全并确认商品信息。</p>}
      <fieldset className="ec-question ec-reference-switch"><legend>是否参考视频</legend><label className="ec-question-option"><input type="checkbox" checked={usesReference} onChange={event => toggleReference(event.target.checked)} />参考视频</label><p className="ec-muted">{usesReference ? "借鉴一个已分析视频的结构，用自己的商品事实重新写。" : "按方法论独立创作，无需准备对标视频。"}</p></fieldset>
      {usesReference && <section className="ec-inset">
        <Field label="选择一个对标带货视频 *"><select value={selectedBenchmarkKey} onChange={event => chooseBenchmark(event.target.value)}><option value="">请选择已分析的视频</option>
          {brief.benchmark && !selectedReference && <option value={selectedBenchmarkKey}>已选对标视频 · 来源待核对</option>}
          {!!references.length && <optgroup label="已分析的对标视频">{references.map(reference => <option key={referenceKey(reference)} value={referenceKey(reference)}>{reference.title || "未命名视频"} · {displayTime(reference.analyzed_at)}</option>)}</optgroup>}
          {!!cases.length && <optgroup label="已整理的参考案例">{cases.map(item => <option key={item.id} value={`case:${item.id}`}>{item.title}</option>)}</optgroup>}
        </select></Field>
        <p className="ec-muted">借鉴结构与表达，商品事实使用我们自己的已确认资料。</p>
        {!references.length && !cases.length && <p className="ec-muted">当前空间还没有已分析的对标视频。<a className="ec-link" href={benchmarkUrl} onClick={leaveForm}>去对标内容库添加并分析视频 →</a></p>}
        {sourceReference && <BenchmarkPreview key={`${sourceReference.referenceId}:${sourceReference.analysisId}`} scope={scope} reference={sourceReference} allowTranscriptChange={Boolean(brief.benchmark)} autoSelectTranscript={autoTranscript} onTranscriptChange={transcriptId => selectTranscript(sourceReference.referenceId, sourceReference.analysisId, transcriptId)} />}
      </section>}
      <details open={audienceExpanded} onToggle={event => setAudienceExpanded(event.currentTarget.open)}><summary>调整人群与使用场景{brief.audience.user && brief.scene ? " · 已沿用商品资料" : " · 待补充"}</summary>
        <div className="ec-grid"><TaskQuestion key={`${versionId}:user`} label="本次使用者" value={brief.audience.user} options={taskQuestionOptions.user} maxLength={300} onChange={user => change({ audience: { ...brief.audience, user } })} /><TaskQuestion key={`${versionId}:buyer`} label="本次购买决定者" value={brief.audience.buyer} options={taskQuestionOptions.buyer} maxLength={300} onChange={buyer => change({ audience: { ...brief.audience, buyer } })} /></div>
        <TaskQuestion key={`${versionId}:scene`} label="购买或使用场景" value={brief.scene} options={taskQuestionOptions.scene} multiline maxLength={2000} onChange={scene => change({ scene })} />
        <TaskQuestion key={`${versionId}:barrier`} label="主要购买障碍" value={brief.barrier} options={taskQuestionOptions.barrier} multiline maxLength={1000} hint="选择本篇文案要解决的一个主要顾虑；特殊情况可自行填写。" onChange={barrier => change({ barrier })} />
        <details><summary>更多人群信息与判断依据</summary><div className="ec-grid">{([ ["situation", "用户当前处境"], ["trigger", "为什么此时需要"], ["alternative", "以前怎么解决"], ["concerns", "具体顾虑"], ["viewingContext", "观看情境"], ["source", "人群判断来源"] ] as const).map(([key, label]) => <TextField key={key} label={label} value={brief.audience[key]} maxLength={key === "viewingContext" ? 500 : 1000} onChange={value => change({ audience: { ...brief.audience, [key]: value } })} />)}<Choice label="人群判断状态" value={brief.audience.status} values={{ hypothesis: "待验证假设", confirmed: "已人工确认" }} onChange={status => change({ audience: { ...brief.audience, status } })} /></div></details>
      </details>
      <div className="ec-grid"><Choice label="发布平台" value={brief.platform} values={platforms} onChange={platform => change({ platform })} /><Choice label="流量类型" value={brief.traffic} values={{ organic: "自然流", paid: "付费素材" }} onChange={traffic => change({ traffic })} /><Choice label="希望观众做什么" value={brief.target} values={targets} onChange={target => change({ target })} /></div>
      <TaskDurationQuestion value={brief.durationSec} onChange={durationSec => change({ durationSec })} />
      <TaskQuestion key={`${versionId}:destination`} label="承接位置与动作" value={brief.destination} options={taskQuestionOptions.destination} multiline maxLength={2000} hint="选择观众接下来可实际执行的动作，特殊位置可自行填写。" onChange={destination => change({ destination })} />
      <TextField label="本次补充要求" multiline value={brief.instructions} onChange={instructions => change({ instructions })} />
      <details><summary>补充品牌资料与限制 · 可选</summary><p className="ec-muted">只有勾选的品牌知识会用于生成；项目记忆不会自动加入。</p><Checks label="品牌知识（最多 5 条）" value={brief.knowledgeIds} values={Object.fromEntries(options.knowledge.map(item => [item.id, item.title]))} onChange={knowledgeIds => { if (knowledgeIds.length <= 5) change({ knowledgeIds }); }} />
        {options.knowledge.filter(item => brief.knowledgeIds.includes(item.id)).map(item => <details key={item.id}><summary>{item.title} · v{item.current_version}</summary><p className="ec-pre">{item.body}</p></details>)}
        <TextField label="本次禁用条件（每行一条）" multiline value={excluded} onChange={value => { setExcluded(value); dirty(true); }} />
      </details>
      <details><summary>{options.strategy ? "内容策略 · 已读取" : "内容策略（可选）"}</summary>{options.strategy ? <><p>{options.strategy.positioning}</p><p className="ec-muted">受众：{options.strategy.targetAudience}</p><p className="ec-muted">风格：{options.strategy.styleNotes}</p></> : <p className="ec-muted">未设置时，按商品资料、本次要求和内容方法论创作文案。<a className="ec-link" href={strategyUrl} onClick={leaveForm}>设置内容策略（可选） →</a></p>}<TextField label="本次策略例外说明（可留空）" multiline value={brief.strategyException} onChange={strategyException => change({ strategyException })} /></details>
      <div className="ec-actions"><button className="ec-primary" type="submit" aria-busy={action.busy || autoTranscript} disabled={autoTranscript}>{autoTranscript ? "正在读取参考内容…" : row ? "保存文案要求" : "保存并进入生成"}</button>{row && <small className="ec-muted">修改条件后需生成或保存新稿，原审核不沿用。</small>}</div>
    </fieldset>
  </form>;
}

type BenchmarkSource = { title: string; sourceText: string; transcripts: { id: string; created_at: string }[] };
function BenchmarkPreview({ scope, reference, allowTranscriptChange, autoSelectTranscript, onTranscriptChange }: { scope: Scope; reference: { referenceId: string; analysisId: string; transcriptId?: string | null }; allowTranscriptChange: boolean; autoSelectTranscript: boolean; onTranscriptChange: (id: string | null) => void }) {
  const query = new URLSearchParams({ referenceId: reference.referenceId, analysisId: reference.analysisId, ...reference.transcriptId ? { transcriptId: reference.transcriptId } : {} });
  const sourceKey = query.toString(), [result, setResult] = useState<{ key: string; source?: BenchmarkSource; error?: string } | null>(null), [retry, setRetry] = useState(0);
  const transcriptChanged = useRef(onTranscriptChange);
  useEffect(() => { transcriptChanged.current = onTranscriptChange; }, [onTranscriptChange]);
  useEffect(() => {
    let active = true;
    ecommerceApi<BenchmarkSource>(scope, `cases/source?${sourceKey}`).then(source => {
      if (!active) return;
      if (allowTranscriptChange && autoSelectTranscript) transcriptChanged.current(source.transcripts[0]?.id ?? null);
      setResult({ key: sourceKey, source });
    }).catch(reason => { if (active && !isScopeCancellation(reason)) setResult({ key: sourceKey, error: reason instanceof Error ? reason.message : "参考视频来源读取失败。" }); });
    return () => { active = false; };
  }, [scope, sourceKey, retry, allowTranscriptChange, autoSelectTranscript]);
  const current = result?.key === sourceKey ? result : null;
  return <div>{current?.error ? <><Notices error={current.error} /><button type="button" onClick={() => setRetry(value => value + 1)}>重新读取参考内容</button></> : !current?.source ? <p className="ec-muted" role="status">正在读取所选视频的分析与文案…</p> : <>
    {allowTranscriptChange && !!current.source.transcripts.length && <Field label="参考文案版本"><select value={reference.transcriptId ?? ""} onChange={event => onTranscriptChange(event.target.value || null)}><option value="">仅参考分析报告</option>{current.source.transcripts.map(item => <option key={item.id} value={item.id}>转写 · {displayTime(item.created_at)}</option>)}</select></Field>}
    <details><summary>预览参考内容</summary><p className="ec-muted">{current.source.title}</p><textarea className="ec-source-text" readOnly value={current.source.sourceText} rows={7} aria-label="所选对标视频的分析与文案原文" /></details>
  </>}</div>;
}
