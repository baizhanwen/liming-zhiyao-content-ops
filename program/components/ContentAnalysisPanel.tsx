"use client";
import { useMemo, useState } from "react";
import { contentTaxonomy, getDimensionLabel, getTagLabel, readContentAnalysis, readVideoContentAnalysis, type ContentEvidence } from "../lib/video-content-analysis";
import { classificationText, contentMetricRows, contentReasonLabel, contentModuleLabels, contentModuleCoverageText, contentSegmentLabels, contentSourceLabels, contentStateLabels, contentTimeLabel } from "../lib/content-analysis-presentation";

type AssetLink = { id: string; url: string };
function OpeningFrameImage({ src, alt }: { src: string; alt: string }) {
  // Private evidence must use authenticated browser requests.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" />;
}

export function ContentAnalysisPanel({ report, assets = [], onLocate }: { report: unknown; assets?: AssetLink[]; onLocate?: (milliseconds: number) => void }) {
  const [query, setQuery] = useState("");
  const content = useMemo(() => readContentAnalysis(report), [report]);
  const member = report && typeof report === "object" && !Array.isArray(report) ? (report as Record<string, unknown>).content_analysis : null;
  const read = useMemo(() => readVideoContentAnalysis(member), [member]);
  if (!content) return <section className="content-analysis-legacy"><strong>{read.status === "missing" ? "本报告尚未生成标准分类" : "标准分类需要核对"}</strong><p>{read.status === "missing" ? "原有报告仍可查看；主动重新分析后可生成统一分类、可复核指标和内容对比材料。" : "分类材料未完整通过检查，请结合质量提示核对后重新分析。"}</p></section>;
  const evidenceById = new Map(content.evidence_registry.map(row => [row.id, row]));
  const assetById = new Map(assets.map(row => [row.id, row.url]));
  const opening = content.evidence_registry.filter(row => row.source === "frame" && row.start_ms !== null && row.start_ms <= 3_000 && row.asset_ref && assetById.has(row.asset_ref));
  const phrase = query.trim().toLocaleLowerCase("zh-CN");
  const visible = content.classifications.filter(row => !phrase || `${getDimensionLabel(row.dimension_id)} ${classificationText(row)} ${row.reason || ""}`.toLocaleLowerCase("zh-CN").includes(phrase));
  function evidenceView(ids: string[]) {
    const rows = ids.flatMap(id => evidenceById.has(id) ? [evidenceById.get(id)!] : []);
    if (!rows.length) return null;
    return <details className="content-evidence"><summary>核对 {rows.length} 条原文或画面</summary>{rows.map((row: ContentEvidence) => <article key={row.id}>
      <div><span>{contentSourceLabels[row.source]}</span><button type="button" disabled={row.start_ms === null || !onLocate} onClick={() => row.start_ms !== null && onLocate?.(row.start_ms)}>{contentTimeLabel(row.start_ms)}</button>{row.asset_ref && assetById.has(row.asset_ref) && <a href={assetById.get(row.asset_ref)} target="_blank" rel="noreferrer">查看画面</a>}</div><p>{row.text || "该证据保留了原始画面。"}</p>
    </article>)}</details>;
  }
  return <section className="content-analysis-panel">
    <header><div><span className="section-kicker">标准化内容分析</span><h2>从内容判断到可比较的特征</h2><p>分类保留来源和材料状态；推断项需结合证据核对。</p></div><span className={`content-completion ${content.status}`}>{content.status === "complete" ? "分类已完成" : "部分分类待核对"}</span></header>
    <div className="content-metric-grid">{contentMetricRows(content).map(([label, value]) => <article key={label}><small>{label}</small><strong>{value}</strong></article>)}</div>
    <details className="content-method-note"><summary>查看指标口径与局限</summary><p>有效字符仅计字母与数字，使用纠错前的转写；“转写字符／全片秒”包含无口播时段，分段值依赖转写时间戳。</p><p>{content.metrics.shot_detection.limitations.join(" ")}</p><p>{content.metrics.media.aspect_reason}</p><p>分类版本 {content.taxonomy_version} · {content.profile === "max" ? "最高能力" : "标准模式"}</p></details>
    {opening.length > 0 && <section className="content-opening"><h3>首帧与前3秒</h3><p>保留开头的实际取样，黑场与重复画面也可核对。</p><div className="content-opening-frames">{opening.map(row => <a key={row.id} href={assetById.get(row.asset_ref!)} target="_blank" rel="noreferrer"><OpeningFrameImage src={assetById.get(row.asset_ref!)!} alt={`${contentTimeLabel(row.start_ms)} 开头画面`} /><span>{contentTimeLabel(row.start_ms)}</span></a>)}</div></section>}
    <label className="content-classification-search">查找分类<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="例如：Hook、构图、人群、价值" /></label>
    {Object.entries(content.module_status).map(([module, moduleStatus]) => {
      const dimensions = new Set(contentTaxonomy.dimensions.filter(row => row.module === module).map(row => row.id));
      const rows = visible.filter(row => dimensions.has(row.dimension_id));
      if (!rows.length) return null;
      const known = content.classifications.filter(row => dimensions.has(row.dimension_id) && row.state === "known").length;
      return <details className="content-classification-group" key={module} open={!phrase && module === "text_topic_structure_audience" || Boolean(phrase)}><summary><strong>{contentModuleLabels[module] || module}</strong><span>可判断 {known} / {dimensions.size} 项</span></summary><p className="content-module-coverage">{contentModuleCoverageText(moduleStatus)}</p><div className="content-classification-grid">{rows.map(row => {
        const dimension = contentTaxonomy.dimensions.find(item => item.id === row.dimension_id)!;
        return <article key={row.dimension_id}><div className="content-classification-heading"><h4>{dimension.label}</h4><small>{dimension.inferred ? "模型推断" : contentStateLabels[row.state]}</small></div><div className="plain-chips">{row.state === "known" ? row.tags?.length ? row.tags.map(tag => <span key={tag} className={tag === row.primary_tag ? "primary-tag" : ""}>{getTagLabel(row.dimension_id, tag)}{tag === row.primary_tag ? " · 主类型" : ""}</span>) : <span>确认未出现</span> : <span className="content-state-missing">{contentStateLabels[row.state]}</span>}</div>{row.reason && <p>{contentReasonLabel(row.reason)}</p>}{evidenceView(row.evidence_ids)}</article>;
      })}</div></details>;
    })}
    {!visible.length && <p role="status">没有找到匹配的分类。</p>}
    {content.segments.length > 0 && <details className="content-classification-group"><summary><strong>内容段落与行动引导</strong><span>{content.segments.length} 个片段</span></summary><div className="content-segment-list">{content.segments.map(row => <article key={row.id}><div><strong>{contentSegmentLabels[row.kind] || row.kind}</strong><button type="button" disabled={row.start_ms === null || !onLocate} onClick={() => row.start_ms !== null && onLocate?.(row.start_ms)}>{contentTimeLabel(row.start_ms)}–{contentTimeLabel(row.end_ms)}</button></div><p>{row.text}</p>{row.dimension_id && <div className="plain-chips">{row.tags.map(tag => <span key={tag}>{getTagLabel(row.dimension_id!, tag)}</span>)}</div>}{evidenceView(row.evidence_ids)}</article>)}</div></details>}
    {content.information_units.length > 0 && <details className="content-classification-group"><summary><strong>价值与信息单元</strong><span>去重后 {content.information_units.filter(row => row.duplicate_of === null).length} 项</span></summary><p>这些单元由模型识别并由程序去重计数，可展开核对；不等同于客观价值评分。</p><div className="content-segment-list">{content.information_units.map(row => <article key={row.id}><strong>{getTagLabel("value.information_type", row.type_tag)}</strong>{row.duplicate_of && <small>重复内容</small>}<p>{row.text}</p>{evidenceView(row.evidence_ids)}</article>)}</div></details>}
  </section>;
}
