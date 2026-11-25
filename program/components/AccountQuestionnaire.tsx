"use client";

import { useState, type FormEvent } from "react";
import {
  accountSubjects, evidenceTypes, materialNatures, materialTypes, materialUses, publicationChoices, strategyOptions,
  type KnowledgeAnswers, type KnowledgeForm, type MaterialKind, type StrategyAnswers,
} from "../lib/account-questionnaire";
import "./account-questionnaire.css";

type Submit = (event: FormEvent<HTMLFormElement>) => void;
type Defaults = Record<string, string>;
const kinds = Object.keys(materialTypes) as MaterialKind[];

function ShortAnswer({ label, name, initial, required = false, multiline = false, maxLength = 1500, placeholder }: {
  label: string; name: string; initial: Defaults; required?: boolean; multiline?: boolean; maxLength?: number; placeholder?: string;
}) {
  return <label>{label}{multiline
    ? <textarea rows={2} name={name} defaultValue={initial[name]} required={required} maxLength={maxLength} placeholder={placeholder} />
    : <input name={name} defaultValue={initial[name]} required={required} maxLength={maxLength} placeholder={placeholder} />}</label>;
}

function Choices({ label, name, options, initial, multiple = false, allowCustom = true, required = false }: {
  label: string; name: string; options: readonly string[]; initial: Defaults; multiple?: boolean; allowCustom?: boolean; required?: boolean;
}) {
  const values = multiple ? (initial[name] || "").split("、").filter(Boolean) : [initial[name]].filter(Boolean);
  const custom = values.filter(value => !options.includes(value)).join("、");
  const [showCustom, setShowCustom] = useState(Boolean(custom));
  if (!multiple) return <div className="guided-choice"><label>{label}<select name={name} aria-label={label} required={required} defaultValue={custom ? "__custom" : initial[name] || ""} onChange={event => setShowCustom(event.target.value === "__custom")}>
    <option value="">请选择</option>{options.map(option => <option key={option}>{option}</option>)}{allowCustom && <option value="__custom">自定义</option>}
  </select></label>{showCustom && <label>自定义{label}<input name={name + "Custom"} defaultValue={custom} required maxLength={150} /></label>}</div>;
  return <fieldset className="guided-options"><legend>{label}</legend><div>{options.map(option => <label key={option}><input type="checkbox" name={name} value={option} defaultChecked={values.includes(option)} />{option}</label>)}
    {allowCustom && <label><input type="checkbox" checked={showCustom} onChange={event => setShowCustom(event.target.checked)} />自定义</label>}</div>
    {showCustom && <label>自定义{label}<input name={name + "Custom"} defaultValue={custom} required maxLength={150} /></label>}
  </fieldset>;
}

export function answersFromForm(data: FormData) {
  const answers: Record<string, string> = {};
  for (const key of new Set(data.keys())) {
    if (key.endsWith("Custom")) continue;
    const selected = data.getAll(key).map(String).filter(value => value && value !== "__custom");
    const custom = String(data.get(key + "Custom") || "").trim();
    answers[key] = [...selected, ...(custom ? [custom] : [])].join("、");
  }
  // A custom-only multiselect has no checked standard control.
  for (const key of data.keys()) if (key.endsWith("Custom") && !answers[key.slice(0, -6)]) answers[key.slice(0, -6)] = String(data.get(key) || "");
  return answers;
}

export function KnowledgeQuestions({ kind, initial = {}, projectName = "" }: { kind: KnowledgeForm["kind"]; initial?: KnowledgeAnswers; projectName?: string }) {
  const [publication, setPublication] = useState(initial.publication || "待确认");
  const [numeric, setNumeric] = useState(Boolean(initial.metric || initial.basis));
  const [timed, setTimed] = useState(Boolean(initial.review));
  if (kind === "profile") return <>
    <input type="hidden" name="guidedKind" value="profile" />
    <fieldset className="guided-question"><legend>作品用哪个名字发布？账号代表谁？</legend>
      <ShortAnswer label="对外名称" name="accountName" initial={{ accountName: projectName, ...initial }} required maxLength={100} />
      <Choices label="账号主体" name="subject" required options={accountSubjects} initial={initial} />
    </fieldset>
    <ShortAnswer label="有哪些可以长期公开的账号背景？" name="background" initial={initial} multiline placeholder="例如：在校学生，平时拍晚课后的校园。" />
    <details className="guided-extra"><summary>代表作品与公开边界</summary><div>
      <ShortAnswer label="哪条作品最能代表你？" name="sample" initial={initial} placeholder="作品名、链接或已公开片段" />
      <Choices label="希望参考什么" name="sampleUse" options={["措辞", "节奏", "已确认事实", "已授权画面"]} initial={initial} multiple />
      <ShortAnswer label="哪些称呼、人物或场景需要特别处理？" name="boundary" initial={initial} multiline placeholder="只写可以传给写稿模型的要求，例如室友不露脸。" />
    </div></details>
  </>;
  const type = materialTypes[kind];
  return <>
    <input type="hidden" name="guidedKind" value={kind} />
    <h3>{type.label}</h3>
    {type.questions.map((q, index) => <ShortAnswer key={q} label={q} name={"answer" + index} required={index === 0} initial={initial} multiline={index === 0} />)}
    <ShortAnswer label="条目标题（选填）" name="title" initial={initial} maxLength={120} placeholder="默认使用第一句回答" />
    <Choices label="这是什么性质的材料？" name="nature" options={materialNatures} initial={kind === "fiction" ? { nature: "虚构或改编", ...initial } : initial} />
    <Choices label="允许怎样使用？" name="usage" options={materialUses} initial={initial} multiple />
    <Choices label="这条说法可以从哪里核对？" name="evidenceType" options={evidenceTypes} initial={initial} />
    <ShortAnswer label="核对来源" name="source" initial={initial} required={numeric} placeholder="文件名、原片时间、记录位置或核对人" />
    <label>哪些内容可以对外讲？<select name="publication" aria-label="哪些内容可以对外讲？" value={publication} onChange={event => setPublication(event.target.value)}>{publicationChoices.map(value => <option key={value}>{value}</option>)}</select></label>
    {publication === "匿名后可公开" && <ShortAnswer label="允许对外使用的匿名摘要" name="publicSummary" initial={initial} required multiline placeholder="仅填写已去掉姓名、地点等识别信息的版本" />}
    <div className="guided-conditions"><label><input type="checkbox" checked={numeric} onChange={event => setNumeric(event.target.checked)} />有数字或量化比较</label>
      {numeric && <div className="form-row"><ShortAnswer label="指标、数值和单位" name="metric" initial={initial} required /><ShortAnswer label="时间、样本范围或比较基准" name="basis" initial={initial} required /></div>}
      <label><input type="checkbox" checked={timed} onChange={event => setTimed(event.target.checked)} />需要定期复核</label>
      {timed && <label>复核日期<input type="date" name="review" required defaultValue={initial.review} /></label>}
    </div>
  </>;
}

export function KnowledgeIntake({ profile, projectName, busy, onSubmit }: { profile?: string; projectName: string; busy: boolean; onSubmit: Submit }) {
  const [cards, setCards] = useState<Partial<Record<MaterialKind, boolean>>>({});
  const [none, setNone] = useState(false);
  const [resets, setResets] = useState<Record<string, number>>({});
  function reset(kind: string) { setResets(current => ({ ...current, [kind]: (current[kind] || 0) + 1 })); }
  return <div className="account-questionnaire"><h2>账号资料与可用材料</h2>
    {profile ? <p>当前账号资料 · {profile}，可在资料列表中编辑。</p> :
      <form className="stack-form" onSubmit={onSubmit} onReset={() => reset("profile")}><fieldset disabled={busy} className="guided-fields">
        <KnowledgeQuestions key={resets.profile} kind="profile" projectName={projectName} /><button className="primary-button">保存账号资料</button>
      </fieldset></form>}
    <fieldset className="guided-options" disabled={busy}><legend>已经有哪些材料可以反复使用？</legend><div>
      {kinds.map(kind => <label key={kind}><input type="checkbox" checked={cards[kind] === true} onChange={event => {
        const checked = event.target.checked;
        setNone(false);
        setCards(current => ({ ...current, [kind]: checked }));
      }} />{materialTypes[kind].label}</label>)}
      <label><input type="checkbox" checked={none} onChange={event => {
        setNone(event.target.checked);
        setCards(current => Object.fromEntries(Object.keys(current).map(kind => [kind, false])));
      }} />暂时没有</label>
    </div></fieldset>
    {(Object.keys(cards) as MaterialKind[]).map(kind => <form key={kind} className="stack-form guided-material" hidden={!cards[kind]} onSubmit={onSubmit} onReset={() => reset(kind)}>
      <fieldset disabled={busy || !cards[kind]} className="guided-fields"><KnowledgeQuestions key={resets[kind]} kind={kind} />
        <button className="primary-button">保存这条材料</button></fieldset>
    </form>)}
  </div>;
}

export type ExistingStrategy = {
  name: string; positioning: string; target_audience: string; pillars: string[]; objectives: string[]; pain_points: string[]; cadence?: string | null;
  conversion_path?: string | null; persona?: string | null; style_notes?: string | null; form?: StrategyAnswers | null;
};
function strategyDefaults(strategy?: ExistingStrategy): StrategyAnswers {
  if (!strategy) return {};
  if (strategy.form) return strategy.form;
  return { name: strategy.name, positioning: strategy.positioning, audienceDetail: strategy.target_audience, themes: strategy.pillars.join("、"),
    goal: strategy.objectives.join("、"), painPoints: strategy.pain_points.join("、"), cadence: strategy.cadence || "",
    conversionPath: strategy.conversion_path || "", legacyPersona: strategy.persona || "", legacyStyle: strategy.style_notes || "" };
}

export function StrategyQuestionnaire({ base, busy, onSubmit, onCancel }: { base?: ExistingStrategy; busy: boolean; onSubmit: Submit; onCancel: () => void }) {
  const a = strategyDefaults(base);
  const [revision, setRevision] = useState(0);
  return <form className="stack-form account-questionnaire" onSubmit={onSubmit} onReset={() => setRevision(current => current + 1)}>
    <fieldset disabled={busy} className="guided-fields" key={revision}><input type="hidden" name="guidedStrategy" value="1" />
      <fieldset className="guided-question"><legend>这一阶段给谁看？他们在什么情境下看？</legend>
        <Choices label="主要观众" name="audience" options={strategyOptions.audience} initial={a} />
        <ShortAnswer label="具体人群或观看场景" name="audienceDetail" initial={a} placeholder="例如：刚上大学，晚自习后刷视频的同学" />
      </fieldset>
      <fieldset className="guided-question"><legend>想长期拍哪些主题，常做成什么视频？</legend>
        <ShortAnswer label="长期主题" name="themes" initial={a} required placeholder="多个主题用顿号分隔" />
        <Choices label="视频类型" name="formats" options={strategyOptions.formats} initial={a} multiple />
      </fieldset>
      <Choices label="最希望观众从作品中得到什么？" name="goal" required options={strategyOptions.goal} initial={a} />
      <details className="guided-extra"><summary>呈现方式、表达习惯与栏目要求</summary><div>
        <Choices label="平时怎样呈现？" name="presentation" options={strategyOptions.presentation} initial={a} multiple />
        <Choices label="常用什么成品？" name="deliverables" options={strategyOptions.deliverables} initial={a} multiple />
        <Choices label="从谁的视角表达？" name="narrator" options={strategyOptions.narrator} initial={a} />
        <Choices label="常用语气" name="tone" options={strategyOptions.tone} initial={a} multiple />
        <ShortAnswer label="想保留或避开哪些表达？" name="preferences" initial={a} multiline />
        <Choices label="通常怎样收尾？" name="ending" options={strategyOptions.ending} initial={a} />
        <ShortAnswer label="固定栏目、平台、时长或片尾" name="series" initial={a} />
        <ShortAnswer label="更新节奏" name="cadence" initial={a} maxLength={500} />
        <ShortAnswer label="资料领取或咨询的实际去向" name="conversionPath" initial={a} />
      </div></details>
      <details className="guided-extra"><summary>版本名称与补充定位</summary><div>
        <ShortAnswer label="版本名称" name="name" initial={a} maxLength={100} placeholder="默认按长期主题命名" />
        <ShortAnswer label="补充账号定位" name="positioning" initial={a} multiline />
        <ShortAnswer label="观众关心的问题" name="painPoints" initial={a} multiline />
        {a.legacyPersona && <ShortAnswer label="原策略的人设定位" name="legacyPersona" initial={a} />}
        {a.legacyStyle && <ShortAnswer label="原策略的风格" name="legacyStyle" initial={a} multiline maxLength={2000} />}
      </div></details>
      <div className="record-form-actions">
        <button className="primary-button">{busy ? "正在保存…" : "保存策略草稿"}</button>
        {base && <button className="secondary-button" type="button" onClick={onCancel}>取消修改</button>}
      </div>
    </fieldset>
  </form>;
}
