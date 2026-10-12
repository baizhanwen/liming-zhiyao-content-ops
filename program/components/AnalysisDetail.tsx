"use client";
import { readApiError, formatClientDate as dateLabel } from "../lib/client-format";


import { scopedFetch, rememberCurrentScope } from "../lib/client-scope";
import { type AnalysisProfile } from "../lib/analysis-profile";
import { useAnalysisProfile } from "./useAnalysisProfile";

import Link from "next/link";
import { hasPassedQualityAudit } from "../lib/material-analysis-state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Video = { id: string; source_type: "url" | "upload"; source_url: string | null; media_url: string | null; title: string | null; author_name: string | null; duration_sec: number | null; status: string; content_type: string | null; filename: string | null; is_shared_reference?: boolean };
type Job = { idempotency_key?: string; id: string; status: string; analysis_profile: string; progress: number; current_stage: string | null; error_code: string | null; error_message: string | null; completed_at: string | null; segment_progress?: { total: number; completed: number; failed: number; inProgress: number; remaining: number; segments: Array<{ windowKey: string; index: number; startMs: number; endMs: number; status: "pending" | "in_progress" | "completed" | "failed"; attempts: number; error: string | null }> } | null };
type Transcript = { id: string; version: number; language: string; source: string; full_text: string; confidence: number | null; segments: unknown };
type Analysis = { id: string; analysis_job_id: string | null; schema_version: string; report: unknown; confidence: number | null; model_provider: string | null; model_name: string | null; prompt_version: string | null; created_at: string };
type Metric = { source: string; plays: number | null; likes: number | null; comments: number | null; favorites: number | null; shares: number | null; followers_gained: number | null; collected_at: string };
type OwnedPerformance = { work_id: string; work_title: string; as_of_at: string; views: number; completion_rate_bps: number | null; five_second_completion_rate_bps: number | null; cover_ctr_bps: number | null; two_second_bounce_rate_bps: number | null; avg_watch_ms: number | null; likes: number; shares: number; comments: number; saves: number; homepage_visits: number; follower_delta: number; original_filename: string | null };
type EventRow = { event_type: string; from_status: string | null; to_status: string | null; progress: number | null; created_at: string };
type Asset = { id: string; analysis_job_id: string | null; kind: "keyframe" | "subtitle" | "report"; filename: string; content_type: string; size_bytes: number; url: string };
type DetailResponse = { video: Video; job: Job | null; transcript: Transcript | null; analysis: Analysis | null; analyses?: Analysis[]; metrics: Metric[]; ownedPerformance?: OwnedPerformance | null; assets: Asset[]; events: EventRow[]; canWrite: boolean };
type Segment = { startMs: number; endMs: number; text: string };
type SpokenScriptVersion = { status: "completed" | "failed"; text: string; paragraphs: string[]; sourceSegmentIds: string[]; error: string | null; provenance: Record<string, unknown> | null; validation: Record<string, unknown> | null; historical: boolean };
type CtaStrength = "weak" | "medium" | "strong" | "unknown";
type CtaAnalysisItem = {
  ctaType: string;
  startMs: number | null;
  endMs: number | null;
  placement: string;
  quote: string;
  targetAction: string;
  conversionPath: string;
  strength: CtaStrength;
  effectiveness: string;
  issues: string[];
  recommendation: string;
};
type CtaAnalysisView = {
  detected: boolean | null;
  summary: string;
  items: CtaAnalysisItem[];
  overallAssessment: string;
  recommendations: string[];
  legacy: boolean;
};

const sectionNames: Record<string, string> = {
  summary: "核心结论", hook: "开场钩子", hook_analysis: "钩子拆解", viral_points: "传播爆点",
  structure: "内容结构", audience: "目标受众", rhythm_analysis: "节奏设计", emotion_curve: "情绪曲线",
  conversion_design: "转化设计", cta_analysis: "CTA 分析", visual: "画面表达", visuals: "画面表达", language: "语言与节奏",
  highlights: "有效亮点", risks: "风险与缺口", recommendations: "复用建议", spoken_script: "原版口播文案", spoken_script_set: "原版口播文案", evidence: "证据",
};
const reportSectionOrder = ["summary", "hook", "hook_analysis", "viral_points", "audience", "structure", "rhythm_analysis", "emotion_curve", "conversion_design", "cta_analysis", "highlights", "recommendations", "visual", "visuals", "language", "risks"];
const ctaTypeNames: Record<string, string> = {
  comment: "评论互动", follow: "关注账号", private_message: "私信咨询", consultation: "预约咨询",
  purchase: "购买转化", join: "加入社群", download: "下载领取", save: "收藏", share: "转发分享",
  save_share: "收藏或分享", click: "点击跳转", none: "无明确 CTA",
};
const ctaStrengthNames: Record<CtaStrength, string> = { weak: "弱", medium: "中", strong: "强", unknown: "未标注" };
const analysisProfileNames: Record<string, string> = { standard: "标准模式", max: "最高能力", economy: "历史经济模式", deep: "历史深度模式", shared: "共享分析" };
const eventNames: Record<string, string> = { claimed: "任务已领取", heartbeat: "任务心跳", stage_changed: "阶段推进", completed: "分析完成", partial: "分析部分完成", failed: "分析失败", lease_expired: "租约过期" };
const scriptSourceNames: Record<string, string> = { model_transcript_correction: "AI 转写纠错", transcript_deterministic: "历史全量转写整理", model_segment_rewrite: "历史模型逐段改写", model_content_restructure: "历史模型提纲重构" };

const readError = (response: Response) => readApiError(response, "分析结果暂时无法读取。");
function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function timeLabel(ms: number) { const total = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; }
function vttTime(ms: number) { const total = Math.max(0, ms); const hours = Math.floor(total / 3_600_000); const minutes = Math.floor(total % 3_600_000 / 60_000); const seconds = Math.floor(total % 60_000 / 1000); return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(total % 1000).padStart(3, "0")}`; }

function numberLabel(value: number | null) { return value === null ? "—" : new Intl.NumberFormat("zh-CN", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function percentLabel(value: number) { return `${(value / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`; }
function durationLabel(value: number) { const seconds = Math.round(value / 100) / 10; return seconds >= 60 ? `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒` : `${seconds.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}秒`; }

function normalizeSegments(value: unknown): Segment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRecord(item); if (!row || typeof row.text !== "string") return [];
    const startMs = typeof row.start_ms === "number" ? row.start_ms : typeof row.startMs === "number" ? row.startMs : typeof row.start === "number" ? row.start * 1000 : 0;
    const endMs = typeof row.end_ms === "number" ? row.end_ms : typeof row.endMs === "number" ? row.endMs : typeof row.end === "number" ? row.end * 1000 : startMs;
    return [{ startMs, endMs, text: row.text }];
  });
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function firstText(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function textList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return normalizeStringList(value);
}

function firstTextList(record: Record<string, unknown> | null, keys: string[]): string[] {
  if (!record) return [];
  for (const key of keys) {
    const values = textList(record[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function timecodeMilliseconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value !== "string" || !value.trim()) return null;
  const clean = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(clean)) return Math.max(0, Math.round(Number(clean)));
  const parts = clean.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) return null;
  const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  return Math.max(0, Math.round(seconds * 1000));
}

function itemMilliseconds(record: Record<string, unknown>, millisecondKeys: string[], secondKeys: string[], timecodeKeys: string[]): number | null {
  for (const key of millisecondKeys) {
    const value = timecodeMilliseconds(record[key]);
    if (value !== null) return value;
  }
  for (const key of secondKeys) {
    const value = record[key];
    const seconds = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  }
  for (const key of timecodeKeys) {
    const value = timecodeMilliseconds(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizeCtaStrength(value: string): CtaStrength {
  const normalized = value.trim().toLocaleLowerCase("zh-CN");
  if (["weak", "low", "弱", "较弱"].includes(normalized)) return "weak";
  if (["medium", "moderate", "mid", "中", "适中", "中等"].includes(normalized)) return "medium";
  if (["strong", "high", "强", "较强"].includes(normalized)) return "strong";
  return "unknown";
}

function normalizeCtaItem(value: unknown): CtaAnalysisItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const startMs = itemMilliseconds(record, ["start_ms", "startMs"], ["start_sec", "start_seconds", "startSec"], ["time", "timecode"]);
  const endMs = itemMilliseconds(record, ["end_ms", "endMs"], ["end_sec", "end_seconds", "endSec"], ["end_time", "endTime"]);
  const issues = firstTextList(record, ["issues", "issue", "risks", "problems"]);
  const recommendation = firstText(record, ["recommendation", "suggestion", "optimization", "improvement"])
    || firstTextList(record, ["recommendations", "suggestions"]).join("；");
  return {
    ctaType: firstText(record, ["cta_type", "ctaType", "type", "kind"]),
    startMs,
    endMs: endMs !== null && startMs !== null && endMs < startMs ? startMs : endMs,
    placement: firstText(record, ["placement", "stage", "position", "location"]),
    quote: firstText(record, ["quote", "evidence_text", "evidenceText", "wording", "script", "text"]),
    targetAction: firstText(record, ["target_action", "targetAction", "action", "goal"]),
    conversionPath: firstText(record, ["conversion_path", "conversionPath", "handoff_path", "handoffPath", "path", "next_step"]),
    strength: normalizeCtaStrength(firstText(record, ["strength", "intensity", "cta_strength"])),
    effectiveness: firstText(record, ["effectiveness", "evaluation", "assessment", "effect", "quality"]),
    issues,
    recommendation,
  };
}

function normalizeCtaAnalysis(report: Record<string, unknown> | null): CtaAnalysisView | null {
  if (!report) return null;
  const structured = asRecord(report.cta_analysis) ?? asRecord(report.ctaAnalysis) ?? asRecord(report.cta);
  if (structured) {
    const items = (Array.isArray(structured.items) ? structured.items : Array.isArray(structured.ctas) ? structured.ctas : [])
      .map(normalizeCtaItem)
      .filter((item): item is CtaAnalysisItem => item !== null);
    const detectedValue = [structured.detected, structured.present, structured.has_cta, structured.hasCta].find((value) => typeof value === "boolean");
    const detected = typeof detectedValue === "boolean" ? detectedValue : items.length > 0;
    return {
      detected,
      summary: firstText(structured, ["summary", "description", "conclusion"]),
      items: detected === false ? [] : items,
      overallAssessment: firstText(structured, ["overall_assessment", "overallAssessment", "assessment", "effectiveness"]),
      recommendations: firstTextList(structured, ["recommendations", "overall_recommendation", "overallRecommendation", "suggestions", "recommendation"]),
      legacy: false,
    };
  }
  const legacyStatements = textList(report.conversion_design);
  if (legacyStatements.length === 0) return null;
  const legacyText = legacyStatements.join("\n");
  const explicitlyAbsent = /(?:(?:未识别|没有|无明确|未出现|未设置|缺少|不含).{0,8}(?:CTA|行动引导|转化引导)|(?:CTA|行动引导|转化引导).{0,8}(?:缺失|缺少|不明确|不存在))/i.test(legacyText);
  return {
    detected: explicitlyAbsent ? false : null,
    summary: "历史报告只保存了转化判断，没有单独记录 CTA 类型、时间和原话。",
    items: [],
    overallAssessment: legacyStatements.join("\n"),
    recommendations: ["重新分析后可补齐 CTA 原话、位置、目标动作和承接路径。"],
    legacy: true,
  };
}

function ctaTypeLabel(value: string): string {
  const normalized = value.trim();
  return ctaTypeNames[normalized.toLocaleLowerCase("zh-CN")] || normalized || "类型未标注";
}

function ctaTimeLabel(item: CtaAnalysisItem): string {
  if (item.startMs === null) return "时间未标注";
  if (item.endMs !== null && item.endMs > item.startMs) return `${timeLabel(item.startMs)}–${timeLabel(item.endMs)}`;
  return timeLabel(item.startMs);
}

function ctaExportText(analysis: CtaAnalysisView): string {
  const lines = [analysis.detected === false ? "未识别到明确 CTA" : analysis.detected === true ? `识别到 ${analysis.items.length} 处 CTA` : "历史报告未记录 CTA 检测状态"];
  if (analysis.summary) lines.push(`摘要：${analysis.summary}`);
  analysis.items.forEach((item, index) => {
    lines.push(`CTA ${index + 1}：${ctaTypeLabel(item.ctaType)} · ${ctaTimeLabel(item)} · 强度${ctaStrengthNames[item.strength]}`);
    if (item.quote) lines.push(`原话：${item.quote}`);
    if (item.targetAction) lines.push(`目标动作：${item.targetAction}`);
    if (item.conversionPath) lines.push(`承接路径：${item.conversionPath}`);
    if (item.effectiveness) lines.push(`评价：${item.effectiveness}`);
    if (item.issues.length) lines.push(`问题：${item.issues.join("；")}`);
    if (item.recommendation) lines.push(`建议：${item.recommendation}`);
  });
  if (analysis.overallAssessment) lines.push(`整体评价：${analysis.overallAssessment}`);
  if (analysis.recommendations.length) lines.push(`整体建议：${analysis.recommendations.join("；")}`);
  return lines.join("\n");
}

function ctaCompactText(analysis: CtaAnalysisView): string {
  if (analysis.legacy) return ["旧报告未单独分析 CTA。", analysis.overallAssessment].filter(Boolean).join("\n");
  if (analysis.detected === false) {
    return ["未识别到明确 CTA。", analysis.overallAssessment, analysis.recommendations[0] ? `建议：${analysis.recommendations[0]}` : ""].filter(Boolean).join("\n");
  }
  const lines = [analysis.items.length > 0 ? `识别到 ${analysis.items.length} 处 CTA。` : "已识别到 CTA，具体话术与时间点待补齐。"];
  analysis.items.slice(0, 3).forEach((item) => {
    const label = [ctaTimeLabel(item), ctaTypeLabel(item.ctaType), item.placement].filter(Boolean).join(" · ");
    const detail = [
      item.quote ? `“${item.quote}”` : "",
      item.targetAction ? `目标动作：${item.targetAction}` : "",
      item.conversionPath ? `承接：${item.conversionPath}` : "",
      item.strength !== "unknown" ? `强度：${ctaStrengthNames[item.strength]}` : "",
    ].filter(Boolean).join("；");
    lines.push(`• ${label}${detail ? `：${detail}` : ""}`);
  });
  if (analysis.items.length > 3) lines.push(`• 另有 ${analysis.items.length - 3} 处 CTA，导出报告可查看完整明细。`);
  if (analysis.overallAssessment) lines.push(`整体判断：${analysis.overallAssessment}`);
  if (analysis.recommendations[0]) lines.push(`建议：${analysis.recommendations[0]}`);
  return lines.join("\n");
}

function normalizeSpokenScript(report: Record<string, unknown> | null, schemaVersion: string | null): SpokenScriptVersion {
  const fallback = normalizeStringList(report?.spoken_script);
  const rawSet = asRecord(report?.spoken_script_set);
  const corrected = asRecord(rawSet?.corrected_original);
  const legacy = asRecord(rawSet?.faithful_full);
  const raw = corrected ?? legacy;
  const historical = corrected === null;
  const normalizedParagraphs = normalizeStringList(raw?.paragraphs);
  const rawTextParagraphs = typeof raw?.text === "string"
    ? raw.text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean)
    : [];
  const paragraphs = normalizedParagraphs.length
    ? normalizedParagraphs
    : rawTextParagraphs.length
      ? rawTextParagraphs
      : historical
        ? fallback
        : [];
  const explicitStatus = raw?.status === "completed" || raw?.status === "failed" ? raw.status : null;
  const status = explicitStatus ?? (paragraphs.length > 0 ? "completed" : "failed");
  const error = typeof raw?.error === "string" && raw.error.trim()
    ? raw.error.trim()
    : status === "failed"
      ? historical
        ? `${schemaVersion || "旧版报告"} 没有可展示的完整原稿。`
        : "AI 校正原版未生成，系统没有用 ASR 原稿静默冒充成功。"
      : null;
  return {
    status,
    text: typeof raw?.text === "string" && raw.text.trim() ? raw.text : paragraphs.join("\n\n"),
    paragraphs,
    sourceSegmentIds: normalizeStringList(raw?.source_segment_ids ?? raw?.sourceSegmentIds),
    error,
    provenance: asRecord(raw?.provenance),
    validation: asRecord(raw?.validation),
    historical,
  };
}
function analysisVersionLabel(analysis: Analysis) {
  const report = asRecord(analysis.report); const meta = asRecord(report?.analysis_meta);
  const profile = analysisProfileNames[String(meta?.analysis_profile)] || "默认模式";
  const model = [analysis.model_provider, analysis.model_name].filter(Boolean).join(" / ") || "规则分析";
  return `${dateLabel(analysis.created_at)} · ${model} · ${profile}`;
}

function renderValue(value: unknown, key = "") {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item, index) => `${key === "structure" ? `${index + 1}.` : "•"} ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n");
  const record = asRecord(value); if (!record) return "暂无内容";
  return Object.entries(record).map(([key, item]) => `${sectionNames[key] ?? key}：${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n");
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const helper = document.createElement("textarea"); helper.value = value; helper.style.position = "fixed"; helper.style.opacity = "0";
  document.body.appendChild(helper); helper.select(); const copied = document.execCommand("copy"); helper.remove();
  if (!copied) throw new Error("copy failed");
}

function safeFilename(value: string) { return (value.replace(/[<>:"/\\|?*]/g, "-").trim().slice(0, 60) || "视频分析"); }
function downloadText(filename: string, value: string, contentType: string) {
  const url = URL.createObjectURL(new Blob([value], { type: `${contentType};charset=utf-8` }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
function highlightedText(value: string, query: string) {
  const clean = query.trim(); if (!clean) return value;
  const index = value.toLocaleLowerCase("zh-CN").indexOf(clean.toLocaleLowerCase("zh-CN")); if (index < 0) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + clean.length)}</mark>{value.slice(index + clean.length)}</>;
}

function RetryableMediaImage({ src, alt, className }: { src: string; alt: string; className: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retrySrc = src + (src.includes("?") ? "&" : "?") + "mediaRetry=" + attempt;

  if (failed) {
    return <span className={className + " media-image-failure"} role="alert">
      <strong>图片读取失败</strong>
      <button type="button" onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setFailed(false);
        setAttempt((current) => current + 1);
      }}>重试</button>
    </span>;
  }

  // Authenticated private media must be fetched directly with the browser session.
  // eslint-disable-next-line @next/next/no-img-element
  return <img
    key={attempt}
    className={className}
    src={retrySrc}
    alt={alt}
    loading="lazy"
    onLoad={() => setFailed(false)}
    onError={() => setFailed(true)}
  />;
}

export function AnalysisDetail({ videoId, organizationId, projectId, libraryEntryId }: { videoId: string; organizationId: string; projectId: string; libraryEntryId?: string }) {
  const [detail, setDetail] = useState<DetailResponse | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const [editingTranscript, setEditingTranscript] = useState(false); const [savingTranscript, setSavingTranscript] = useState(false); const [draftSegments, setDraftSegments] = useState<Segment[]>([]); const [editMessage, setEditMessage] = useState("");
  const [copyMessage, setCopyMessage] = useState(""); const [transcriptQuery, setTranscriptQuery] = useState("");
  const [reanalyzing, setReanalyzing] = useState(false);
  const [rerunProfile, updateRerunProfile] = useAnalysisProfile(detail?.job?.analysis_profile === "max" ? "max" : "standard");
  const [selectedAnalysisId, setSelectedAnalysisId] = useState(""); const [compareAnalysisId, setCompareAnalysisId] = useState("");
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const requestUrl = useMemo(() => `/api/videos/${encodeURIComponent(videoId)}?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}${libraryEntryId ? `&libraryEntryId=${encodeURIComponent(libraryEntryId)}` : ""}`, [organizationId, projectId, videoId, libraryEntryId]);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await scopedFetch(requestUrl);
      if (!response.ok) { setError(await readError(response)); return; }
      setDetail(await response.json());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "分析结果暂时无法读取。");
    } finally { setLoading(false); }
  }, [requestUrl]);
  useEffect(() => {
    rememberCurrentScope(organizationId, projectId);
    let active = true;
    scopedFetch(requestUrl).then(async (response) => {
      if (!response.ok) throw new Error(await readError(response));
      return response.json() as Promise<DetailResponse>;
    }).then((body) => { if (active) { setDetail(body); setLoading(false); } }).catch((reason) => { if (active) { setError(reason instanceof Error ? reason.message : "分析结果暂时无法读取。"); setLoading(false); } });
    return () => { active = false; };
  }, [requestUrl, organizationId, projectId]);
  const analysisVersions = detail?.analyses?.length ? detail.analyses : detail?.analysis ? [detail.analysis] : [];
  const analysis = analysisVersions.find((item) => item.id === selectedAnalysisId) ?? analysisVersions[0] ?? null;
  const effectiveCompareAnalysisId = compareAnalysisId !== analysis?.id && analysisVersions.some((item) => item.id === compareAnalysisId) ? compareAnalysisId : "";
  const compareAnalysis = analysisVersions.find((item) => item.id === effectiveCompareAnalysisId) ?? null;
  const segments = useMemo(() => normalizeSegments(detail?.transcript?.segments), [detail?.transcript?.segments]);
  const transcriptVtt = useMemo(() => `WEBVTT\n\n${segments.map((segment, index) => `${index + 1}\n${vttTime(segment.startMs)} --> ${vttTime(Math.max(segment.endMs, segment.startMs + 500))}\n${segment.text.replaceAll("\n", " ")}\n`).join("\n")}`, [segments]);
  const captionTrack = useMemo(() => `data:text/vtt;charset=utf-8,${encodeURIComponent(transcriptVtt)}`, [transcriptVtt]);
  const visibleSegments = useMemo(() => { const query = transcriptQuery.trim().toLocaleLowerCase("zh-CN"); return query ? segments.filter((segment) => segment.text.toLocaleLowerCase("zh-CN").includes(query)) : segments; }, [segments, transcriptQuery]);
  const report = asRecord(analysis?.report);
  const analysisMeta = asRecord(report?.analysis_meta);
  const visualExtraction = asRecord(analysisMeta?.visual_extraction);
  const visualUnderstanding = asRecord(visualExtraction?.visual_understanding);
  const qualityAudit = asRecord(analysisMeta?.quality_audit);
  const rawQualityChecks = Array.isArray(qualityAudit?.checks) ? qualityAudit.checks.map(asRecord).filter((item): item is Record<string, unknown> => item !== null) : [];
  const removedDepthCheck = rawQualityChecks.find((item) => item.key === "depth");
  const qualityChecks = rawQualityChecks.filter((item) => item.key !== "depth");
  const qualityIssues = normalizeStringList(qualityAudit?.issues).filter((issue) => !issue.startsWith("报告展开不足："));
  const qualityScore = typeof qualityAudit?.score === "number"
    ? Math.min(100, qualityAudit.score + (removedDepthCheck?.passed === false ? 12 : 0))
    : null;
  const criticalQualityKeys = ["core", "specialists", "required_sections", "spoken_scripts", "evidence", "cta", "links", "required_links", "coverage", "visual_understanding"];
  const qualityStatus = removedDepthCheck?.passed === false
    && qualityScore !== null
    && qualityScore >= 85
    && criticalQualityKeys.every((key) => qualityChecks.find((check) => check.key === key)?.passed !== false)
    ? "passed"
    : qualityAudit?.status;
  const qualityLabel = qualityStatus === "passed" ? "验收通过" : typeof qualityAudit?.label === "string" ? qualityAudit.label : "建议复核";
  const activeScriptVersion = normalizeSpokenScript(report, analysis?.schema_version ?? null);
  const spokenScript = activeScriptVersion.paragraphs;
  const spokenScriptHeading = activeScriptVersion.status === "completed" ? sectionNames.spoken_script : "未通过验收的口播候选稿";
  const scriptValidationChecks = Array.isArray(activeScriptVersion.validation?.checks)
    ? activeScriptVersion.validation.checks.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : [];
  const hasSpokenScriptPanel = Boolean(report && ("spoken_script_set" in report || normalizeStringList(report.spoken_script).length > 0));
  const scriptProvenanceSource = typeof activeScriptVersion.provenance?.source === "string" ? scriptSourceNames[activeScriptVersion.provenance.source] || activeScriptVersion.provenance.source : "旧版报告未记录";
  const scriptModelLabel = [activeScriptVersion.provenance?.model_provider, activeScriptVersion.provenance?.model_name].filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(" / ") || "确定性规则";
  const scriptPromptVersion = typeof activeScriptVersion.provenance?.prompt_version === "string" ? activeScriptVersion.provenance.prompt_version : "—";
  const ctaAnalysis = normalizeCtaAnalysis(report);
  const independentReportKeys = new Set(["evidence", "analysis_meta", "spoken_script", "spoken_script_set", "insight_evidence", "cta_analysis", "ctaAnalysis", "cta"]);
  const reportSections: Array<[string, unknown]> = [
    ...(report ? Object.entries(report).filter(([key]) => !independentReportKeys.has(key)) : []),
    ...(ctaAnalysis ? [["cta_analysis", ctaAnalysis] as [string, unknown]] : []),
  ].sort(([left], [right]) => { const leftIndex = reportSectionOrder.indexOf(left); const rightIndex = reportSectionOrder.indexOf(right); return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex); });
  const compareReport = asRecord(compareAnalysis?.report);
  const comparisonKeys = ["summary", "hook", "viral_points", "recommendations"];
  const keyframes = detail?.assets.filter((asset) => (
    asset.kind === "keyframe"
    && (analysis?.analysis_job_id
      ? asset.analysis_job_id === analysis.analysis_job_id
      : asset.analysis_job_id === null)
  )) ?? [];
  const coverFrame = keyframes[0] ?? null;
  const publicMetric = detail?.metrics.find((metric) => metric.source === "public") ?? null;
  const visiblePublicMetrics = publicMetric ? [
    { label: "播放", value: publicMetric.plays },
    { label: "点赞", value: publicMetric.likes },
    { label: "评论", value: publicMetric.comments },
    { label: "收藏", value: publicMetric.favorites },
    { label: "分享", value: publicMetric.shares },
    { label: "涨粉", value: publicMetric.followers_gained },
  ].filter((metric): metric is { label: string; value: number } => metric.value !== null && metric.value !== 0) : [];
  const ownedPerformance = detail?.ownedPerformance ?? null;
  const visibleOwnedMetrics = ownedPerformance ? [
    { label: "播放量", value: ownedPerformance.views, format: numberLabel },
    { label: "完播率", value: ownedPerformance.completion_rate_bps, format: percentLabel },
    { label: "5秒完播率", value: ownedPerformance.five_second_completion_rate_bps, format: percentLabel },
    { label: "封面点击率", value: ownedPerformance.cover_ctr_bps, format: percentLabel },
    { label: "2秒跳出率", value: ownedPerformance.two_second_bounce_rate_bps, format: percentLabel },
    { label: "平均观看时长", value: ownedPerformance.avg_watch_ms, format: durationLabel },
    { label: "点赞", value: ownedPerformance.likes, format: numberLabel },
    { label: "评论", value: ownedPerformance.comments, format: numberLabel },
    { label: "分享", value: ownedPerformance.shares, format: numberLabel },
    { label: "收藏", value: ownedPerformance.saves, format: numberLabel },
    { label: "主页访问", value: ownedPerformance.homepage_visits, format: numberLabel },
    { label: "净增粉", value: ownedPerformance.follower_delta, format: numberLabel },
  ].filter((metric): metric is { label: string; value: number; format: (value: number) => string } => metric.value !== null && metric.value !== 0) : [];
  function seek(startMs: number) { if (!mediaRef.current) return; mediaRef.current.currentTime = startMs / 1000; void mediaRef.current.play(); }
  function locateTimepoint(startMs: number) {
    if (!detail) return;
    if (detail.video.media_url) { seek(startMs); return; }
    if (detail.video.source_url) window.open(detail.video.source_url, "_blank", "noopener,noreferrer");
  }
  function renderReportSection(value: unknown, key: string) {
    if (key === "cta_analysis" && ctaAnalysis) return <p>{ctaCompactText(ctaAnalysis)}</p>;
    return <p>{renderValue(value, key)}</p>;
  }
  async function copySpokenScript() {
    if (!spokenScript.length) return;
    setCopyMessage("");
    try {
      await copyText(spokenScript.join("\n\n"));
      setCopyMessage("原版口播文案已复制。");
    } catch { setCopyMessage("口播稿复制失败，请重新点击一次。"); }
  }
  async function copyReport() {
    if (!reportSections.length && !spokenScript.length && !ctaAnalysis) return;
    setCopyMessage("");
    try {
      const sections = reportSections.map(([key, value]) => `${sectionNames[key] ?? key}\n${key === "cta_analysis" && ctaAnalysis ? ctaExportText(ctaAnalysis) : renderValue(value, key)}`);
      if (spokenScript.length) sections.splice(1, 0, `${spokenScriptHeading}\n${spokenScript.join("\n\n")}`);
      await copyText(sections.join("\n\n"));
      setCopyMessage("分析报告已复制，可以直接粘贴到文档或群聊。" );
    } catch { setCopyMessage("复制没有成功，请重新点击一次。" ); }
  }
  function exportMarkdown() {
    const title = detail?.video.title || detail?.video.filename || "视频分析";
    const lines = [`# ${title}`, "", `- 生成时间：${dateLabel(analysis?.created_at ?? null)}`, `- 模型：${[analysis?.model_provider, analysis?.model_name].filter(Boolean).join(" / ") || "规则与适配器"}`];
    if (spokenScript.length) lines.push("", `## ${spokenScriptHeading}`, "", spokenScript.join("\n\n"));
    for (const [key, value] of reportSections) lines.push("", `## ${sectionNames[key] ?? key}`, "", key === "cta_analysis" && ctaAnalysis ? ctaExportText(ctaAnalysis) : renderValue(value, key));
    if (segments.length) { lines.push("", "## 时间轴转写", ""); for (const segment of segments) lines.push(`- [${timeLabel(segment.startMs)}] ${segment.text}`); }
    downloadText(`${safeFilename(title)}-分析报告.md`, `${lines.join("\n")}\n`, "text/markdown"); setCopyMessage("Markdown 报告已下载到浏览器下载目录。" );
  }
  function exportTranscript() {
    const title = detail?.video.title || detail?.video.filename || "视频分析";
    downloadText(`${safeFilename(title)}-时间轴字幕.vtt`, transcriptVtt, "text/vtt"); setEditMessage("时间轴字幕已下载到浏览器下载目录。" );
  }
  async function reanalyze() {
    setReanalyzing(true); setCopyMessage("");
    try {
      const response = await scopedFetch(`/api/videos/${encodeURIComponent(videoId)}/reanalyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, analysisProfile: rerunProfile }) });
      if (!response.ok) { setCopyMessage(await readError(response)); return; }
      setCopyMessage(`${analysisProfileNames[rerunProfile]}重新分析任务已创建，可返回视频分析页查看进度。`);
    } catch (reason) { setCopyMessage(reason instanceof Error ? reason.message : "重新分析任务没有创建成功。"); }
    finally { setReanalyzing(false); }
  }
  function startTranscriptEdit() {
    if (!detail?.transcript) return;
    setDraftSegments(segments.length ? segments : [{ startMs: 0, endMs: Math.max(500, (detail.video.duration_sec ?? 1) * 1000), text: detail.transcript.full_text }]);
    setEditMessage(""); setEditingTranscript(true);
  }
  async function saveTranscript(reanalyze: boolean) {
    setSavingTranscript(true); setEditMessage("");
    try {
      const response = await scopedFetch(`/api/videos/${encodeURIComponent(videoId)}/transcript`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, language: detail?.transcript?.language || "zh-CN", segments: draftSegments, reanalyze, analysisProfile: rerunProfile }) });
      if (!response.ok) { setEditMessage(await readError(response)); return; }
      setEditingTranscript(false); setEditMessage(reanalyze ? "校正版已保存，新的结构分析任务已经进入队列。" : "校正版已保存。随时可以再次编辑并重新分析。"); await load();
    } catch (reason) {
      setEditMessage(reason instanceof Error ? reason.message : "校正版没有保存成功，请稍后重试。");
    } finally { setSavingTranscript(false); }
  }

  if (loading) return <div className="management-state" role="status">正在读取分析结果…</div>;
  if (error || !detail) return <div className="management-state error-state"><strong>暂时无法查看分析详情</strong><p>{error}</p><Link href="/analysis">返回视频分析</Link></div>;
  const isAudio = detail.video.content_type?.startsWith("audio/");
  const importedJob = detail.job?.idempotency_key?.startsWith("material-import:");
  const missingReport = !detail.analysis && (!detail.job || importedJob);
  const effectiveJobStatus = importedJob && analysis?.schema_version === "analysis.v7" && !hasPassedQualityAudit(qualityAudit) ? "partial" : detail.job?.status;
  return <div className="analysis-detail-layout">
    <nav className="analysis-detail-nav" aria-label="分析结果快捷导航"><a href="#analysis-media">媒体与转写</a><a href="#analysis-report">结构化报告</a><a href="#analysis-trace">处理记录</a></nav>
    <section className="detail-primary">
      <article className="panel media-review-panel" id="analysis-media">
        <div className="panel-heading"><div><p className="section-kicker">原始媒体与时间轴</p><h2>{detail.video.title || detail.video.filename || "待提取视频标题"}</h2>{detail.job?.segment_progress && !["completed", "partial"].includes(detail.job.status) && <small className="job-checkpoint">长视频分段：已完成 {detail.job.segment_progress.completed} / {detail.job.segment_progress.total} · 剩余 {detail.job.segment_progress.remaining}</small>}</div><span className={`status ${missingReport ? "neutral" : effectiveJobStatus === "completed" ? "success" : effectiveJobStatus === "partial" ? "warning" : effectiveJobStatus === "failed" ? "danger" : "neutral"}`}>{missingReport ? "尚未分析" : importedJob && effectiveJobStatus === "partial" ? "已迁入部分报告" : detail.job?.current_stage || detail.video.status}</span></div>
        {missingReport && <section className="inline-alert" role="status"><strong>素材已保存，但尚无分析报告。</strong><p>{detail.canWrite && !detail.video.is_shared_reference ? "可在下方选择档位并重新分析；新任务会核对分析额度。" : "当前是只读视图，请由来源空间成员核对并主动分析。"}</p></section>}
        <div className="media-review-grid"><div className={`media-player-shell${!detail.video.media_url && detail.video.source_url && coverFrame ? " has-external-cover" : ""}`}>
          {detail.video.media_url && isAudio && <audio ref={(node) => { mediaRef.current = node; }} controls preload="metadata" src={detail.video.media_url}><track kind="captions" src={captionTrack} srcLang={detail.transcript?.language || "zh-CN"} label="转写字幕" default /></audio>}
          {detail.video.media_url && !isAudio && <video ref={(node) => { mediaRef.current = node; }} controls preload="metadata" src={detail.video.media_url}><track kind="captions" src={captionTrack} srcLang={detail.transcript?.language || "zh-CN"} label="转写字幕" default />浏览器不支持视频播放。</video>}
          {!detail.video.media_url && detail.video.source_url && <div className={`external-media${coverFrame ? " has-cover" : ""}`}>
            {coverFrame && <RetryableMediaImage className="external-media-cover" src={coverFrame.url} alt={(detail.video.title || "该视频") + "的本地分析封面"} />}
            <div className="external-media-content"><span aria-hidden="true">↗</span><strong>{coverFrame ? "查看原始视频" : "公开视频来源"}</strong><p>{coverFrame ? "封面取自本地分析关键帧，原视频仍通过平台链接核对。" : "平台内容保持外链，不在页面中绕过平台限制嵌入。"}</p><a href={detail.video.source_url} target="_blank" rel="noreferrer">打开原始抖音链接</a></div>
          </div>}
        </div><div className={`transcript-timeline${editingTranscript ? " editing" : ""}`}>
          <div className="timeline-heading"><div><strong>时间轴文案</strong><span>{detail.transcript ? `${detail.transcript.source === "manual" ? "人工校正版" : "ASR 原稿"} · 版本 ${detail.transcript.version} · 置信度 ${detail.transcript.confidence ?? "—"}` : "等待转写"}</span></div><div className="timeline-actions">{segments.length > 0 && !editingTranscript && <label className="transcript-search"><span className="sr-only">搜索转写内容</span><input type="search" value={transcriptQuery} onChange={(event) => setTranscriptQuery(event.target.value)} placeholder="搜索转写…" /></label>}{segments.length > 0 && !editingTranscript && <button type="button" onClick={exportTranscript}>导出字幕</button>}{detail.transcript && detail.canWrite && !editingTranscript && <button type="button" onClick={startTranscriptEdit}>校正转写</button>}</div></div>
          {!editingTranscript && transcriptQuery.trim() && <p className="transcript-match-count" role="status">找到 {visibleSegments.length} 个匹配片段</p>}
          {editingTranscript ? <div className="transcript-editor"><p>逐段修正错别字和专有名词，原有时间点会继续保留。</p>{draftSegments.map((segment, index) => <label key={`${segment.startMs}-${index}`}><time>{timeLabel(segment.startMs)}</time><textarea value={segment.text} maxLength={2000} onChange={(event) => setDraftSegments((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} aria-label={`${timeLabel(segment.startMs)} 的转写内容`} /></label>)}<div className="transcript-editor-actions"><button type="button" onClick={() => setEditingTranscript(false)} disabled={savingTranscript}>取消</button><button type="button" onClick={() => saveTranscript(false)} disabled={savingTranscript}>仅保存校正版</button><button className="primary" type="button" onClick={() => saveTranscript(true)} disabled={savingTranscript}>{savingTranscript ? "正在保存…" : `保存并以${analysisProfileNames[rerunProfile]}重新分析`}</button></div>{editMessage && <div className="inline-alert" role="alert">{editMessage}</div>}</div> : visibleSegments.length > 0 ? <ol>{visibleSegments.map((segment, index) => { const canLocate = Boolean(detail.video.media_url || detail.video.source_url); const label = `${timeLabel(segment.startMs)} ${detail.video.media_url ? "跳转播放" : detail.video.source_url ? "打开原视频核对" : "时间点"}`; return <li key={`${segment.startMs}-${index}`}><button type="button" onClick={() => locateTimepoint(segment.startMs)} disabled={!canLocate} aria-label={label} title={label}><time>{timeLabel(segment.startMs)}</time><span>{highlightedText(segment.text, transcriptQuery)}</span></button></li>; })}</ol> : segments.length > 0 && transcriptQuery.trim() ? <div className="timeline-empty">没有找到包含“{transcriptQuery.trim()}”的转写片段。</div> : <div className="timeline-empty">{detail.transcript?.full_text || "转写完成后，这里会按时间点展示原文。"}</div>}
          {!editingTranscript && editMessage && <div className="transcript-save-message" role="status">{editMessage}</div>}
        </div></div>
        {keyframes.length > 0 && <div className="keyframe-strip"><div className="timeline-heading"><strong>镜头关键帧</strong><span>{keyframes.length} 个可追溯画面</span></div>{visualExtraction && <div className="keyframe-coverage" aria-label="关键帧提取统计"><span>场景候选 {typeof visualExtraction.scene_count === "number" ? visualExtraction.scene_count : "—"}</span><span>全程锚点 {typeof visualExtraction.anchor_count === "number" ? visualExtraction.anchor_count : "—"}</span>{typeof visualExtraction.anchor_interval_seconds === "number" && <span>约每 {visualExtraction.anchor_interval_seconds} 秒覆盖</span>}<span>初选 {typeof visualExtraction.candidate_count === "number" ? visualExtraction.candidate_count : keyframes.length}</span><span>相似过滤 {typeof visualExtraction.similar_removed === "number" ? visualExtraction.similar_removed : 0}</span><span>低对比过滤 {typeof visualExtraction.low_contrast_removed === "number" ? visualExtraction.low_contrast_removed : 0}</span></div>}<div>{keyframes.map((asset, index) => <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer"><RetryableMediaImage className="keyframe-image" src={asset.url} alt={"关键帧 " + (index + 1)} /><span>{asset.filename}</span></a>)}</div></div>}
      </article>

      <article className="panel report-panel" id="analysis-report"><div className="panel-heading"><div><p className="section-kicker">结构化分析</p><h2>{analysis ? `报告 ${analysis.schema_version}` : "尚未生成结构化报告"}</h2></div>{analysis && <div className="report-heading-actions"><span className="confidence-chip">整体置信度 {analysis.confidence ?? "—"}</span><button type="button" onClick={copyReport}>复制报告</button><button type="button" onClick={exportMarkdown}>导出 Markdown</button></div>}</div>
        {copyMessage && <p className="report-copy-message" role="status">{copyMessage}</p>}
        {analysisVersions.length > 0 && <div className="analysis-version-toolbar"><label><span>当前查看</span><select value={analysis?.id || ""} onChange={(event) => { const id = event.target.value; setSelectedAnalysisId(id); setCompareAnalysisId((current) => current === id ? "" : current); }}>{analysisVersions.map((item) => <option key={item.id} value={item.id}>{analysisVersionLabel(item)}</option>)}</select></label><label><span>对比版本</span><select value={effectiveCompareAnalysisId} onChange={(event) => setCompareAnalysisId(event.target.value)} disabled={analysisVersions.length < 2}><option value="">{analysisVersions.length < 2 ? "重新分析后可对比" : "选择另一份报告"}</option>{analysisVersions.filter((item) => item.id !== analysis?.id).map((item) => <option key={item.id} value={item.id}>{analysisVersionLabel(item)}</option>)}</select></label><p>人工校正时间轴并重新分析后，旧报告会保留在这里，不会被覆盖。</p></div>}
        {analysis && compareAnalysis && compareAnalysis.id !== analysis.id && <section className="analysis-comparison-panel"><div><div><span>版本对比</span><h3>快速核对两个模型或两次分析的差异</h3></div><button type="button" onClick={() => setCompareAnalysisId("")}>关闭对比</button></div><div className="comparison-headings"><strong>{analysisVersionLabel(analysis)}</strong><strong>{analysisVersionLabel(compareAnalysis)}</strong></div>{comparisonKeys.map((key) => <article key={key}><h4>{sectionNames[key] ?? key}</h4><div><p>{report?.[key] === undefined ? "该版本未生成此项" : renderValue(report[key], key)}</p><p>{compareReport?.[key] === undefined ? "该版本未生成此项" : renderValue(compareReport[key], key)}</p></div></article>)}</section>}
        {effectiveJobStatus === "partial" && qualityStatus !== "passed" && <section className="analysis-partial-banner" role="alert"><strong>这份报告是“部分完成”，不是完整成功</strong><p>{detail.job?.error_message || "至少一项关键能力或质量检查未通过。报告可以查看，但建议按验收项修复后重试。"}</p></section>}
        {visualUnderstanding && <section className={"visual-understanding-status " + String(visualUnderstanding.status || "unavailable")}><div><span>独立视觉模型</span><strong>{visualUnderstanding.status === "completed" ? "真实画面理解已完成" : visualUnderstanding.status === "partial" ? "真实画面理解只完成一部分" : "真实画面理解不可用"}</strong></div><p>{typeof visualUnderstanding.reason === "string" && visualUnderstanding.reason.trim() ? visualUnderstanding.reason : "OCR 只用于识别画面文字，不会被当作人物动作、场景或镜头表达分析。"}</p><small>视觉观察 {typeof visualUnderstanding.observation_count === "number" ? visualUnderstanding.observation_count : 0} 条 · 与 OCR 结果分开记录</small></section>}
        {qualityAudit && <section className={`analysis-quality-audit ${qualityStatus === "passed" ? "passed" : qualityStatus === "degraded" ? "degraded" : "review"}`}><header><div><span>自动质量验收</span><h3>{qualityLabel}</h3></div><strong>{qualityScore ?? "—"}<small>/100</small></strong></header><div className="quality-check-grid">{qualityChecks.map((check, index) => <article className={check.passed === true ? "passed" : "failed"} key={`${String(check.key || "check")}-${index}`}><i aria-hidden="true">{check.passed === true ? "✓" : "!"}</i><span>{String(check.label || "质量检查")}</span><strong>{String(check.value ?? "—")}</strong></article>)}</div>{qualityIssues.length > 0 && <details><summary>查看 {qualityIssues.length} 项需要注意的问题</summary><ul>{qualityIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></details>}<p>{qualityStatus === "passed" ? "报告结构、来源覆盖和证据追溯达到当前模式的验收要求。" : "报告仍可查看，但系统没有把它静默当作满质量结果；可根据提示校正转写或重新分析。"}</p></section>}
        {analysisMeta && <div className="analysis-cost-summary"><div><small>{typeof analysisMeta.actual_total_tokens === "number" ? "实际模型消耗" : "模型输入预估"}</small><strong>{numberLabel(typeof analysisMeta.actual_total_tokens === "number" ? analysisMeta.actual_total_tokens : typeof analysisMeta.estimated_model_input_tokens === "number" ? analysisMeta.estimated_model_input_tokens : null)} Token</strong>{typeof analysisMeta.actual_total_tokens === "number" && <span>输入 {numberLabel(typeof analysisMeta.actual_input_tokens === "number" ? analysisMeta.actual_input_tokens : null)} · 输出 {numberLabel(typeof analysisMeta.actual_output_tokens === "number" ? analysisMeta.actual_output_tokens : null)}</span>}</div><div><small>分析覆盖率</small><strong>{typeof analysisMeta.coverage_percent === "number" ? `${analysisMeta.coverage_percent}%` : "—"}</strong>{typeof analysisMeta.analyzed_segments === "number" && typeof analysisMeta.source_segments === "number" && <span>{analysisMeta.analyzed_segments} / {analysisMeta.source_segments} 个片段</span>}</div><div><small>长视频处理</small><strong>{analysisMeta.processing_mode === "segmented" ? "分段分析后汇总" : typeof analysisMeta.duration_minutes === "number" ? `${analysisMeta.duration_minutes} 分钟` : "单次分析"}</strong><span>{analysisMeta.processing_mode === "segmented" && typeof analysisMeta.segment_analysis_count === "number" ? `${analysisMeta.segment_analysis_count} 个时间段 · ${analysisMeta.analysis_passes} 次调用` : typeof analysisMeta.chunk_count === "number" ? `${analysisMeta.chunk_count} 个证据窗口` : ""}</span></div><div><small>预算策略</small><strong>{analysisMeta.mode === "budgeted" ? "预算内抽样" : "完整分析"}</strong><span>{analysisProfileNames[String(analysisMeta.analysis_profile)] || "标准模式"}{typeof analysisMeta.maximum_total_tokens === "number" ? ` · 总上限 ${numberLabel(analysisMeta.maximum_total_tokens)}` : typeof analysisMeta.maximum_source_tokens === "number" ? ` · 输入上限 ${numberLabel(analysisMeta.maximum_source_tokens)}` : ""}</span></div></div>}
        {detail.canWrite && !detail.video.is_shared_reference && <div className="analysis-rerun-bar"><div><strong>选择档位重新分析</strong><span>保留原视频；有人工校正版时优先沿用校正版。标准模式成本更低，最高能力保留更密集画面与专项诊断。</span></div><select value={rerunProfile} onChange={(event) => updateRerunProfile(event.target.value as AnalysisProfile)} aria-label="重新分析档位"><option value="standard">标准模式 · 推荐</option><option value="max">最高能力模式</option></select><button type="button" disabled={reanalyzing} onClick={reanalyze}>{reanalyzing ? "正在创建…" : "重新分析"}</button></div>}
        {hasSpokenScriptPanel && <section className="spoken-script-panel">
          <div>
            <div><span>{analysis?.schema_version || "旧版报告"} · {activeScriptVersion.historical ? "历史原稿兼容展示" : "ASR 忠实整理"}</span><h3>原版口播文案</h3></div>
            <button type="button" disabled={activeScriptVersion.status !== "completed" || spokenScript.length === 0} onClick={copySpokenScript}>复制原版文案</button>
          </div>
          <div className={"spoken-script-state " + activeScriptVersion.status}>
            <strong>{activeScriptVersion.historical ? "这是旧报告的原稿，不代表已由 AI 完成纠错" : activeScriptVersion.status === "completed" ? "已完成错字、语病、标点与断句校正" : spokenScript.length > 0 ? "候选稿未通过验收，内容已保留供核对" : "AI 未返回可用的校正稿"}</strong>
            <span>来源：{scriptProvenanceSource} · 模型：{scriptModelLabel} · 提示词：{scriptPromptVersion}</span>
          </div>
          {scriptValidationChecks.length > 0 && <div className="spoken-script-checks">{scriptValidationChecks.map((check, index) => <span className={check.passed === true ? "passed" : "failed"} key={String(check.key || "check") + "-" + index}><i>{check.passed === true ? "✓" : "!"}</i><b>{String(check.label || "校验项")}</b><small>{String(check.value ?? "—")}</small></span>)}</div>}
          {spokenScript.length > 0
            ? <><article>{spokenScript.map((paragraph, index) => <p key={index + "-" + paragraph.slice(0, 12)}>{paragraph}</p>)}</article>{activeScriptVersion.status === "failed" && <article className="spoken-script-failure" role="alert"><strong>{activeScriptVersion.error || "候选稿未通过自动验收。"}</strong><p>上方保留的是待核对候选稿，不会被标记为校正成功；未通过的来源、篇幅或相似度项目会显示在验收项中。</p></article>}</>
            : <article className="spoken-script-failure" role="alert"><strong>{activeScriptVersion.error || "AI 没有返回可展示的校正稿。"}</strong><p>原始 ASR 仍保留在上方时间轴中，可校正转写后重新分析。</p></article>}
          <small>{activeScriptVersion.historical ? "旧 analysis.v5/v6/v7 报告仅兼容展示当时的完整原稿。" : <>普通分析只做原稿纠错，不再自动消耗 Token 生成微调或重构稿；需要改写时请进入 <Link href="/script-rewrite">文案改写</Link>。</>}</small>
        </section>}
        {reportSections.length > 0 ? <div className="report-sections">{reportSections.map(([key, value]) => <section className={key === "summary" || key === "recommendations" ? "report-section-wide" : undefined} key={key}><h3>{sectionNames[key] ?? key}</h3>{renderReportSection(value, key)}</section>)}</div> : <div className="list-empty">分析服务完成结构化输出后，结论与复用建议会显示在这里。</div>}
        {analysis && <footer className="report-provenance"><span>模型：{[analysis.model_provider, analysis.model_name].filter(Boolean).join(" / ") || "规则与适配器"}</span><span>提示词版本：{analysis.prompt_version || "—"}</span><span>生成：{dateLabel(analysis.created_at)}</span>{detail.video.is_shared_reference ? <span>共享素材 · 原分析只读</span> : <nav className="report-next-actions" aria-label="分析结果下一步"><Link href="/analysis?view=assets">素材中心</Link><Link href="/analysis?view=benchmark">对标内容库</Link><Link href={`/topics?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&sourceVideoId=${encodeURIComponent(videoId)}`}>从此分析创建选题 →</Link></nav>}</footer>}
      </article>
    </section>

    <aside className="detail-sidebar">
      <article className="panel metric-panel performance-metric-panel">
        <div className="panel-heading"><div><p className="section-kicker">数据快照</p><h2>作品数据表现</h2></div></div>
        {visiblePublicMetrics.length > 0 && <section className="metric-source-group"><header><strong>公开互动</strong><span>视频页面 · {dateLabel(publicMetric?.collected_at ?? null)}</span></header><dl>{visiblePublicMetrics.map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd>{numberLabel(metric.value)}</dd></div>)}</dl></section>}
        {visibleOwnedMetrics.length > 0 && <section className="metric-source-group owned-performance-group"><header><strong>企业后台数据</strong><span>XLSX · 截至 {dateLabel(ownedPerformance?.as_of_at ?? null)}</span></header><p className="metric-work-match">已匹配《{ownedPerformance?.work_title}》</p><dl>{visibleOwnedMetrics.map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.format(metric.value)}</dd></div>)}</dl></section>}
        {visiblePublicMetrics.length === 0 && visibleOwnedMetrics.length === 0 && <p className="sidebar-empty">暂无可展示的数据；空值和 0 不会显示。</p>}
      </article>
      <article className="panel trace-panel" id="analysis-trace"><div className="panel-heading"><div><p className="section-kicker">任务追踪</p><h2>处理记录</h2></div><button type="button" onClick={load}>刷新</button></div>{detail.events.length > 0 ? <ol>{detail.events.map((event, index) => <li key={`${event.created_at}-${index}`}><i aria-hidden="true" /><div><strong>{eventNames[event.event_type] ?? event.event_type}</strong><span>{event.to_status || event.from_status || "状态记录"}{event.progress !== null ? ` · ${event.progress}%` : ""}</span><time>{dateLabel(event.created_at)}</time></div></li>)}</ol> : <p className="sidebar-empty">尚无处理事件。</p>}</article>
      {detail.job?.error_message && <article className="inline-alert" role="alert"><strong>{detail.job.error_code === "ANALYSIS_PARTIAL" ? "报告部分完成" : detail.job.error_code || "分析失败"}</strong><p>{detail.job.error_message}</p></article>}
    </aside>
  </div>;
}
