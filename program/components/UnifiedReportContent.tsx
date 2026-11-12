"use client";
import { useState, type ReactNode } from "react";
import { ManuscriptCard } from "./ExtractedManuscript";
import { contentTimeLabel } from "../lib/content-analysis-presentation";
import type { AnalysisReportView, ReportClassificationView, ReportFindingView } from "../lib/analysis-report-view";
import type { UnifiedModuleKey } from "../lib/unified-report";

type Props = {
  view: AnalysisReportView;
  assets: Array<{ id: string; url: string }>;
  canLocate: boolean;
  onLocate: (milliseconds: number) => void;
  onCopyScript: () => void;
  canCopyScript: boolean;
  failedModuleKeys: string[];
  onRetry?: (key: UnifiedModuleKey | "canonical", reviewSegmentIds?: string[]) => void;
  busy?: boolean;
  manuscript?: ReactNode;
};
function EvidenceImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="report-media-unavailable">画面暂时无法读取，<a href={src} target="_blank" rel="noreferrer">重新打开</a></span>;
  // Private images require the authenticated browser session.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}
function ClassificationRows({ rows, label }: { rows: ReportClassificationView[]; label: string }) {
  return <dl className="report-classification-list" aria-label={label}>{rows.map(row => <div key={row.dimensionId} data-dimension={row.dimensionId}>
    <dt>{row.label}</dt><dd>{row.tags.length ? <span className="report-classification-value">{row.tags.map((tag, index) => <span key={tag.id}>{index > 0 && "、"}{tag.label}{tag.primary && row.tags.length > 1 && <small className="report-primary-tag">主</small>}</span>)}</span> : <span className="report-classification-state">{row.value}</span>}{row.reason && <small className="report-classification-reason">{row.reason}</small>}</dd>
  </div>)}</dl>;
}

export function UnifiedReportContent({ view, assets, canLocate, onLocate, onCopyScript, canCopyScript, failedModuleKeys, onRetry, busy = false, manuscript }: Props) {
  const evidenceById = new Map(view.evidence.map(row => [row.id, row]));
  const assetById = new Map(assets.map(row => [row.id, row.url]));
  const summaryFinding = view.sections.find(section => section.key === "synthesis")?.findings.find(finding => finding.text.trim() === view.summary.trim());
  function evidenceView(finding: ReportFindingView) {
    const rows = finding.evidenceIds.flatMap(id => evidenceById.has(id) ? [evidenceById.get(id)!] : []);
    if (!rows.length) return null;
    return <details className="report-evidence"><summary>查看依据 <span>{rows.length}</span></summary><div>{rows.map(row => {
      const frame = row.asset_ref ? row : view.evidence.find(item => item.source === "frame" && item.start_ms === row.start_ms && item.asset_ref);
      const asset = frame?.asset_ref ? assetById.get(frame.asset_ref) : null;
      return <article key={row.id}><header>{row.start_ms !== null && canLocate ? <button type="button" onClick={() => onLocate(row.start_ms!)}>{contentTimeLabel(row.start_ms)} · 跳转播放</button> : <span>{contentTimeLabel(row.start_ms)}</span>}<small>{row.source === "transcript" ? view.legacy ? "原文转写" : "校正文案" : row.source === "ocr" ? "画面文字" : "画面依据"}</small></header><p>{row.text}</p>{asset && <a href={asset} target="_blank" rel="noreferrer"><EvidenceImage src={asset} alt={`${contentTimeLabel(row.start_ms)} 的原片画面`} /></a>}</article>;
    })}</div></details>;
  }
  const scriptSection = manuscript ?? <ManuscriptCard onCopy={onCopyScript} canCopy={canCopyScript && !busy}>
      {view.reviews.length > 0 && <div className="report-review-note"><p>{view.reviews.length} 处口播待核对，已保留原始转写并标出时间。其余可靠文字和画面已继续分析。补充口播后会更新受影响的分析，画面和未受影响结果复用。</p>{onRetry && failedModuleKeys.includes("canonical") && <button type="button" disabled={busy} onClick={() => onRetry("canonical", view.reviews.map(row => row.sourceId))}>只补待核对句</button>}</div>}
      {view.scriptStatus === "not_applicable" ? <p>这份素材没有口播。</p> : view.scriptStatus === "failed" && !view.reviews.length ? <div className="report-section-message"><p>{view.legacy ? "该历史报告没有保存完整口播稿，可展开原始转写核对。" : view.unified?.version === "unified-report.v1" ? "校正稿尚未通过核对，下方内容保留为候选稿。" : "口播核对尚未完成，可展开原始转写核对。"}</p>{onRetry && failedModuleKeys.includes("canonical") && <button type="button" disabled={busy} onClick={() => onRetry("canonical")}>重新校正口播</button>}</div> : null}
      <div className="report-manuscript">{view.script.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      {view.reviews.length > 0 && <details className="report-pending-review"><summary>核对疑义句（{view.reviews.length}）</summary>{view.reviews.map(row => <article key={row.sourceId}><header>{canLocate ? <button type="button" onClick={() => onLocate(row.startMs)}>{contentTimeLabel(row.startMs)} · 听原句</button> : <time>{contentTimeLabel(row.startMs)}</time>}{onRetry && failedModuleKeys.includes("canonical") && <button type="button" disabled={busy} onClick={() => onRetry("canonical", [row.sourceId])}>只补这一句</button>}</header><p className="report-review-reason">{row.reason}</p><p><strong>原始转写：</strong>{row.original}</p>{row.candidate && <p className="report-review-candidate"><strong>未采用的候选：</strong>{row.candidate}</p>}</article>)}</details>}
      {view.changes.length > 0 && <details className="report-correction-diff"><summary>核对 {view.changes.length} 处校正</summary>{view.changes.map(change => <article key={change.sourceId}>{change.basis && <small className="report-correction-basis">{change.basis}</small>}<del>{change.before}</del><ins>{change.after}</ins>{evidenceView({ id: change.sourceId, title: "校正依据", text: change.after, evidenceIds: change.evidenceIds })}</article>)}</details>}
    </ManuscriptCard>;
  return <>
    {view.summary && <section className="report-overview"><span className="section-kicker">核心结论</span><p>{view.summary}</p>{summaryFinding && evidenceView(summaryFinding)}</section>}
    {view.unified?.version === "unified-report.v1" && view.unified.canonical.status === "failed" ? <section className="report-overview"><h2>口播内容需要先核对</h2><p>该版本的口播校正未完成，其余分析尚未生成。</p></section> : view.sections.map(section => <section className="unified-report-section" id={`report-${section.key}`} key={section.key}><header><h2>{section.name}</h2>{["failed", "not_acquired"].includes(section.status) && <span className="report-section-failed">未完成</span>}</header>
      {section.reason && <div className="report-section-message"><p>{section.reason}</p>{onRetry && failedModuleKeys.includes(section.key) && <button type="button" disabled={busy} onClick={() => onRetry(section.key)}>只补这一部分</button>}</div>}
      {section.classifications.some(row => row.featured) && <div className="report-core-classifications"><h3>主要分类</h3><ClassificationRows rows={section.classifications.filter(row => row.featured)} label={`${section.name}的主要分类`} /></div>}
      {section.findings.filter(finding => section.key !== "synthesis" || finding.text.trim() !== view.summary.trim()).map(finding => <article className="report-finding" key={finding.id}><h3>{finding.title}</h3><p>{finding.text}</p>{evidenceView(finding)}</article>)}
      {section.classifications.some(row => !row.featured) && <details className="report-more-classifications"><summary>更多分类</summary><ClassificationRows rows={section.classifications.filter(row => !row.featured)} label={`${section.name}的更多分类`} /></details>}
      {!section.findings.length && !section.reason && <p className="report-empty">这一部分没有可展示的结论。</p>}
    </section>)}
    {scriptSection}
  </>;
}
