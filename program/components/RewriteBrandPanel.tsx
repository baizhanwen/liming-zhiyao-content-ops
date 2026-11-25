"use client";

import Link from "next/link";
import { useId } from "react";
import type { RewriteBrandContext, RewriteBrandSource } from "../lib/script-rewrite-brand";
import type { RewriteBrandMode } from "../lib/script-rewrite-adaptation";
import type { RewriteAdaptationOptions, RewriteAdaptationSnapshot } from "../lib/script-rewrite-options";
import "./rewrite-brand.css";

export type RewriteBrandSettings = Omit<RewriteAdaptationOptions, "brandStamp">;

const mappingRoles = { identity: "自我介绍", product: "产品或服务", promotion: "推广主体", cta: "行动引导", attribution: "事实归属" };

export const brandModeLabels = {
  preserve: "保留原品牌",
  current_brand: "适配当前品牌",
  neutral: "弱化品牌露出",
} satisfies Record<RewriteBrandMode, string>;

const modeDescriptions: Record<RewriteBrandMode, string> = {
  preserve: "沿用原稿中的品牌、产品名称和身份。",
  current_brand: "按当前空间已确认的资料调整自我介绍、产品和行动引导。",
  neutral: "淡化推广措辞，保留第三方案例和引用的归属。",
};

const briefFields = [
  { key: "goal", label: "改写目标", placeholder: "希望观众看完有什么收获？", suggestions: ["讲清一个方法", "帮助观众做选择", "介绍产品或服务"] },
  { key: "audience", label: "目标受众", placeholder: "这段话说给谁听？", suggestions: ["初次了解的观众", "正在比较方案的人", "已有使用经验的人"] },
  { key: "scenario", label: "口播场景", placeholder: "在哪里、用什么方式讲？", suggestions: ["短视频对镜口播", "校园 Vlog 旁白", "录屏演示旁白", "直播讲解"] },
] as const;

function BrandSources({ sources }: { sources: RewriteBrandSource[] }) {
  if (!sources.length) return <p>没有可展示的资料版本。</p>;
  return <ul className="rewrite-brand-sources">{sources.map(source => <li key={source.itemId}>
    <div><strong>{source.title}</strong><small>v{source.version}</small></div>
    <p>{source.excerpt}</p>
  </li>)}</ul>;
}

export function RewriteBrandPanel({ settings, onChange, knowledge, organizationId, projectId, disabled, refreshing, onRefresh }: {
  settings: RewriteBrandSettings;
  onChange: (settings: RewriteBrandSettings) => void;
  knowledge: RewriteBrandContext | null;
  organizationId: string;
  projectId: string;
  disabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const group = useId();
  const knowledgeUrl = "/space?" + new URLSearchParams({ tab: "knowledge", organizationId, projectId }).toString();
  return <div className="rewrite-brand-settings">
    <fieldset disabled={disabled} className="rewrite-brand-choice"><legend>品牌处理</legend>
      <div>{(["preserve", "current_brand", "neutral"] as const).map(mode => <label key={mode} className={settings.mode === mode ? "is-active" : ""}>
        <input type="radio" name={group} value={mode} checked={settings.mode === mode} onChange={() => onChange({ ...settings, mode })} aria-label={brandModeLabels[mode]} />
        <span><strong>{brandModeLabels[mode]}</strong><small>{modeDescriptions[mode]}</small></span>
      </label>)}</div>
    </fieldset>
    {settings.mode === "current_brand" && <section className="rewrite-brand-evidence" aria-label="当前空间的品牌依据">
      {knowledge?.targetName ? <>
        <p>目标品牌 <strong>{knowledge.targetName}</strong></p>
        <details><summary>查看已确认资料（{knowledge.sources.length} 条）</summary><BrandSources sources={knowledge.sources} /></details>
      </> : <p>这个空间还没有可用的已确认品牌名称。请补充品牌名称，或选择其他品牌处理方式。</p>}
      {knowledge && knowledge.missing.length > 0 && <ul className="rewrite-brand-missing">{knowledge.missing.map(text => <li key={text}>{text}</li>)}</ul>}
      <div className="rewrite-brand-source-actions"><Link href={knowledgeUrl} target="_blank" rel="noopener noreferrer">打开本空间的品牌知识</Link>
        <button type="button" disabled={disabled || refreshing} onClick={onRefresh}>{refreshing ? "正在刷新…" : "刷新资料"}</button></div>
    </section>}
    <fieldset className="rewrite-brief" disabled={disabled}><legend>本次表达要求 <small>选填</small></legend>
      <div>{briefFields.map(({ key, label, placeholder, suggestions }) => <label key={key}>
        <span>{label}</span><input value={settings[key]} list={group + "-" + key}
          placeholder={placeholder} maxLength={key === "goal" ? 500 : 300} onChange={e => onChange({ ...settings, [key]: e.target.value })} />
        <datalist id={group + "-" + key}>{suggestions.map(value => <option value={value} key={value} />)}</datalist>
      </label>)}</div>
    </fieldset>
  </div>;
}

export function RewriteBrandRecord({ snapshot, manual }: { snapshot: RewriteAdaptationSnapshot; manual: boolean }) {
  const sources = snapshot.sources;
  return <details className="rewrite-brand-record">
    <summary>本版品牌适配记录 <span>{brandModeLabels[snapshot.mode]}{snapshot.targetName && snapshot.mode === "current_brand" ? " · " + snapshot.targetName : ""}</span></summary>
    <div className="rewrite-brand-record-body">
      {manual && <p>以下是来源版本的生成设置和品牌依据，人工修改可在正文中查看。</p>}
      <dl>{briefFields.filter(({ key }) => snapshot[key]).map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{snapshot[key]}</dd></div>)}</dl>
      {!!snapshot.mappings.length && <section><h3>名称与归属调整</h3>
        <ul className="rewrite-brand-mappings">{snapshot.mappings.map((mapping, i) => {
          const source = sources.find(item => item.itemId === mapping.sourceId);
          return <li key={i}><div><b>{mapping.before}</b> → <b>{mapping.after || "删除此处推广用语"}</b></div>
            <p>{mappingRoles[mapping.role]} · {/^p-\d+$/i.test(mapping.paragraphId) ? "原稿第 " + Number(mapping.paragraphId.slice(2)) + " 段" : mapping.paragraphId}{source && " · " + source.title + " v" + source.version}</p>
            {mapping.evidenceQuote && <p>依据摘录「{mapping.evidenceQuote}」</p>}</li>;
        })}</ul>
      </section>}
      {!!snapshot.unresolved.length && <section><h3>待补充或核实</h3><ul>{snapshot.unresolved.map((item, i) => <li key={i}>{item}</li>)}</ul></section>}
      {!!snapshot.qualityNotes?.length && <section><h3>口播复核意见</h3><ul>{snapshot.qualityNotes.map((note, i) => <li key={i}>{note}</li>)}</ul></section>}
      {!!sources.length && <details><summary>生成时使用的资料（{sources.length} 条）</summary><BrandSources sources={sources} /></details>}
      {!snapshot.mappings.length && !snapshot.unresolved.length && <p>本版本没有记录名称替换或待补事项。</p>}
    </div>
  </details>;
}
