"use client";
import "./operations-cleanup.css";
import { PeriodicReportLayout } from "./PeriodicReportLayout";
import { AnalyzedAccountsOverview } from "./AnalyzedAccountsOverview";
import "./performance-import.css";
import "./insights-overview.css";
import Link from "next/link";
import { runScopedAction } from "../lib/client-scope";
import { useWorkspaceInitialization } from "./useWorkspaceInitialization";
import { loadClientProjects } from "../lib/client-scope";
import { readApiError as readError } from "../lib/client-format";


import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, BookmarkCheck, BookmarkPlus, Building2, ChevronDown, CheckCircle2, Clock3, FileSpreadsheet, UserRound, Video, FileText, UploadCloud } from "lucide-react";
import Papa from "papaparse";
import { readCsvTable } from "../lib/csv-table";
import { importDate, importDateInput } from "../lib/import-date";
import { douyinMetricRowSchema, performanceRowSchema } from "../lib/performance-analytics";
import type { EChartsCoreOption } from "echarts/core";
import { EChart } from "./EChart";
import { OwnedWorkMatchingView } from "./OwnedWorkMatchingView";
import { useImportPreview } from "./useImportPreview";
import { readFirstWorksheet } from "../lib/xlsx-table";
import { isMissingMetricCell, metricNumberCell, percentMetricCell, signedMetricNumberCell, watchMetricMilliseconds } from "../lib/performance-import";
import { rememberCurrentScope, scopedFetch } from "../lib/client-scope";

import type { InsightsView } from "./InsightsHeader";
type Organization = { id: string; name: string }; type Project = { id: string; name: string };
type ComparisonMetric = "views" | "interactions" | "followersGained" | "leads";
type Diagnostics = { layers: Array<{ key: string; label: string; status: string; confidence: string; evidence: string[]; missing: string[] }>; rules: Array<{ code: string; label: string; layer: string; status: string; confidence: string; minimumSample: number; evidence: string[]; uncertainty: string }>; peerGroups: Array<{ key: string; label: string; sampleSize: number; medianViews: number | null; medianCompletionRate: number | null; medianEngagementRate: number | null; periodStart: string; periodEnd: string }>; attributionNotice: string; evidence?: Array<{ kind: string; contentItemId: string; sourceType: string; sourceId: string; label: string; quote: string | null; locator: string | null }> };type Analytics = { periodStart: string; periodEnd: string; summary: { timestampAliases?: number; timestampConflicts?: number; views: number; interactions: number; followersGained: number; leads: number; contentCount: number; cumulativeViews?: number; cumulativeInteractions?: number; cumulativeFollowersGained?: number; cumulativeLeads?: number; engagementRate: number; leadRate: number; averageCompletionRate: number | null; averageWatchSeconds: number | null; baselineCoverage?: { total: number; complete: number; partial: number; newPublications: number } }; comparison?: { periodStart: string; periodEnd: string; previous: Record<ComparisonMetric, number>; changeRate: Record<ComparisonMetric, number | null> } | null; series: Array<{ date: string; views: number; interactions: number; followersGained: number; leads: number }>; publishedSeries: Array<{ date: string; views: number; interactions: number; contentCount: number }>; platforms: Array<{ platform: string; views: number; interactions: number; contentCount: number; engagementRate: number }>; contentPerformance: Array<{ publicationId: string; title: string; platform: string; externalUrl: string | null; publishedAt: string | null; videoId: string | null; videoTitle: string | null; videoDurationSec: number | null; views: number; interactions: number; engagementRate: number; followersGained: number; leads: number }>; topContent: Array<{ publicationId: string; title: string; platform: string; externalUrl: string | null; views: number; cumulativeViews?: number; interactions: number; engagementRate: number; followersGained: number; leads: number }>; peerGroups?: Diagnostics["peerGroups"]; diagnostics?: Diagnostics };
type ImportBatch = { id: string; source: string; platform?: string; as_of_at?: string; original_filename: string | null; status: string; row_count: number; accepted_count: number; rejected_count: number; errors_json: string | null; created_at: string; completed_at: string | null };
type Publication = { id: string; title: string; platform: string; external_url: string | null; published_at: string | null };
type ImportRow = { publicationId?: string; externalUrl?: string; observedAt: string; views: number; likes: number; comments: number; shares: number; saves: number; followersGained: number; leads: number; averageWatchSeconds?: number; completionRate?: number };
type DouyinImportRow = { title: string; publishedAt: string; genre?: string; reviewStatus?: string; views: number; completionRate?: number; fiveSecondCompletionRate?: number; coverCtr?: number; twoSecondBounceRate?: number; avgWatchMs?: number; likes: number; shares: number; comments: number; saves: number; homepageVisits: number; followerDelta: number };
type ParsedImportRow = ImportRow | DouyinImportRow;
type Report = { id: string; report_type: string; period_start: string; period_end: string; title: string; status: "draft" | "final"; summary: string; metrics_json: string; highlights_json: string; recommendations_json: string; generated_at: string; finalized_at: string | null; updated_at: string };
type EmployeeReport = { id: string; employee_user_id: string; report_type: string; period_start: string; period_end: string; title: string; snapshot_json: string; generated_at: string; updated_at: string };
type EmployeeOption = { id: string; name: string; email: string; role: string };
type EmployeeReportSnapshot = {
  details?: { analyses: { shown: number; total: number }; content: { shown: number; total: number } };
  employee: { id: string; name: string }; period: { start: string; end: string };
  summary: { analysesStarted: number; analysesCompleted: number; analysesFailed: number; contentOwned: number; versionsCreated: number; reviewsCompleted: number; publishingActions: number; attributedPublishedWorks: number; highPerformingWorks: number; viralWorks: number };
  summaryText: string;
  analyses: Array<{ jobId: string; videoId: string | null; title: string; status: string; startedAt: string; completedAt: string | null }>;
  content: Array<{ contentItemId: string; title: string; status: string; createdAt: string; versionsCreated: number; lastVersionAt: string | null }>;
  outcomes: Array<{ workId: string; contentItemId: string; title: string; publishedAt: string; videoId: string | null; views: number; interactions: number; engagementRate: number; followerDelta: number; label: "viral" | "high" | "regular" | "insufficient"; reason: string }>;
  benchmark: { cohortSize: number; minimumHighSample: number; minimumViralSample: number; p80Views: number | null; p90Views: number | null; medianEngagementRate: number | null; p75EngagementRate: number | null; rule: string };
  attribution: { unmatchedPublishedWorks: number; note: string };
};

const platformLabels: Record<string, string> = { douyin: "抖音", xiaohongshu: "小红书", wechat_channels: "视频号", bilibili: "B站", other: "其他" };
const emptyAnalytics: Analytics = { periodStart: "", periodEnd: "", summary: { views: 0, interactions: 0, followersGained: 0, leads: 0, contentCount: 0, cumulativeViews: 0, cumulativeInteractions: 0, cumulativeFollowersGained: 0, cumulativeLeads: 0, engagementRate: 0, leadRate: 0, averageCompletionRate: null, averageWatchSeconds: null, baselineCoverage: { total: 0, complete: 0, partial: 0, newPublications: 0 } }, comparison: null, series: [], publishedSeries: [], platforms: [], contentPerformance: [], topContent: [], peerGroups: [], diagnostics: { layers: [], rules: [], peerGroups: [], evidence: [], attributionNotice: "" } };

function formatNumber(value: number) { return new Intl.NumberFormat("zh-CN", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character] ?? character;
  });
}
function performanceTooltip(params: unknown) {
  type PointData = { name?: unknown; value?: unknown; platform?: unknown; publishedAt?: unknown; videoId?: unknown; videoTitle?: unknown; videoDurationSec?: unknown; externalUrl?: unknown };
  const point = params && typeof params === "object" ? params as { name?: unknown; value?: unknown; data?: unknown } : {};
  const data = point.data && typeof point.data === "object" ? point.data as PointData : {};
  const values = Array.isArray(point.value) ? point.value : Array.isArray(data.value) ? data.value : [];
  const views = Number(values[0] ?? 0);
  const engagementRate = Number(values[1] ?? 0);
  const followersGained = Number(values[2] ?? 0);
  const titleValue = typeof data.name === "string" ? data.name : point.name;
  const title = typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : "未命名作品";
  const platform = typeof data.platform === "string" ? platformLabels[data.platform] || data.platform : "未知平台";
  const publishedAt = typeof data.publishedAt === "string" ? data.publishedAt.slice(0, 10) : "发布时间未知";
  const videoId = typeof data.videoId === "string" && data.videoId ? data.videoId : null;
  const videoTitle = typeof data.videoTitle === "string" && data.videoTitle.trim() && data.videoTitle.trim() !== title ? data.videoTitle.trim() : null;
  const duration = typeof data.videoDurationSec === "number" && data.videoDurationSec > 0
    ? `${Math.floor(data.videoDurationSec / 60)}:${String(Math.round(data.videoDurationSec % 60)).padStart(2, "0")}`
    : null;
  let externalUrl: string | null = null;
  if (typeof data.externalUrl === "string" && data.externalUrl) {
    try { const parsed = new URL(data.externalUrl); if (parsed.protocol === "http:" || parsed.protocol === "https:") externalUrl = parsed.toString(); } catch { externalUrl = null; }
  }
  const statusColor = videoId ? "#2f7458" : "#7c7f7a";
  const statusBackground = videoId ? "#edf7f1" : "#f1f2ef";
  const links = [
    videoId ? `<a href="/analysis/${encodeURIComponent(videoId)}" style="color:#10766f;font-weight:700;text-decoration:none">查看视频分析 →</a>` : "",
    externalUrl ? `<a href="${escapeHtml(externalUrl)}" target="_blank" rel="noreferrer" style="color:#10766f;font-weight:700;text-decoration:none">打开原视频 ↗</a>` : "",
  ].filter(Boolean).join('<span style="color:#d2d4cf"> · </span>');
  return [
    '<div style="width:340px;max-width:calc(100vw - 48px);word-break:break-word">',
    `<div style="display:flex;align-items:center;gap:7px;margin-bottom:8px"><span style="padding:3px 7px;border-radius:999px;color:${statusColor};background:${statusBackground};font-size:11px;font-weight:700">${videoId ? "已关联视频分析" : "未匹配视频"}</span><span style="color:#60786f;font-size:11px">${escapeHtml(platform)} · ${escapeHtml(publishedAt)}</span></div>`,
    `<strong style="display:block;margin-bottom:5px;line-height:1.5;font-size:14px">${escapeHtml(title)}</strong>`,
    videoTitle ? `<div style="margin-bottom:8px;color:#777a75;font-size:11px">分析视频：${escapeHtml(videoTitle)}${duration ? ` · ${duration}` : ""}</div>` : duration ? `<div style="margin-bottom:8px;color:#777a75;font-size:11px">视频时长：${duration}</div>` : "",
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:10px 0;padding:9px 0;border-top:1px solid #ecece8;border-bottom:1px solid #ecece8">',
    `<div><span style="display:block;color:#999;font-size:10px">播放量</span><b>${escapeHtml(formatNumber(views))}</b></div>`,
    `<div><span style="display:block;color:#999;font-size:10px">互动率</span><b>${Number.isFinite(engagementRate) ? engagementRate.toFixed(2) : "0.00"}%</b></div>`,
    `<div><span style="display:block;color:#999;font-size:10px">增粉</span><b>${Number.isFinite(followersGained) ? followersGained.toLocaleString("zh-CN") : "0"}</b></div>`,
    "</div>",
    links ? `<div style="display:flex;gap:8px;align-items:center">${links}</div>` : '<span style="color:#999;font-size:11px">请先到“作品匹配”关联对应的视频分析</span>',
    "</div>",
  ].join("");
}
function publishedTrendTooltip(params: unknown) {
  type TrendData = { date?: unknown; views?: unknown; interactions?: unknown; contentCount?: unknown; works?: unknown };
  const points = Array.isArray(params) ? params : params && typeof params === "object" ? [params] : [];
  const rawData = points[0] && typeof points[0] === "object" ? (points[0] as { data?: unknown }).data : null;
  const data = rawData && typeof rawData === "object" ? rawData as TrendData : {};
  const works = Array.isArray(data.works) ? data.works as Analytics["contentPerformance"] : [];
  const date = typeof data.date === "string" ? data.date : "发布日期未知";
  const views = Number(data.views ?? 0);
  const interactions = Number(data.interactions ?? 0);
  const contentCount = Number(data.contentCount ?? works.length);
  const workRows = works.slice(0, 8).map((work) => {
    let externalUrl: string | null = null;
    if (work.externalUrl) {
      try { const parsed = new URL(work.externalUrl); if (parsed.protocol === "http:" || parsed.protocol === "https:") externalUrl = parsed.toString(); } catch { externalUrl = null; }
    }
    const href = work.videoId ? `/analysis/${encodeURIComponent(work.videoId)}` : externalUrl;
    const target = work.videoId ? "" : ' target="_blank" rel="noreferrer"';
    const title = escapeHtml(work.videoTitle || work.title || "未命名视频");
    const duration = work.videoDurationSec && work.videoDurationSec > 0
      ? `${Math.floor(work.videoDurationSec / 60)}:${String(Math.round(work.videoDurationSec % 60)).padStart(2, "0")}`
      : "";
    const titleContent = href
      ? `<a href="${escapeHtml(href)}"${target} style="min-width:0;color:#343943;font-weight:650;text-decoration:none;line-height:1.4">${title}</a>`
      : `<span style="min-width:0;color:#343943;font-weight:650;line-height:1.4">${title}</span>`;
    return [
      '<div style="display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:start;padding:7px 0;border-top:1px solid #eeeeea">',
      `<span style="margin-top:2px;padding:2px 6px;border-radius:999px;color:${work.videoId ? "#2f7458" : "#7c7f7a"};background:${work.videoId ? "#edf7f1" : "#f1f2ef"};font-size:9px;font-weight:700">${work.videoId ? "分析" : "未匹配"}</span>`,
      titleContent,
      `<span style="color:#999;font-size:10px;white-space:nowrap">${duration || escapeHtml(formatNumber(work.views)) + " 播放"}</span>`,
      "</div>",
    ].join("");
  }).join("");
  return [
    '<div style="width:400px;max-width:calc(100vw - 48px);word-break:break-word">',
    `<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:9px"><div><span style="display:block;color:#60786f;font-size:10px">发布日期</span><strong style="font-size:15px">${escapeHtml(date)}</strong></div><b style="color:#10766f;font-size:12px">${contentCount} 条作品</b></div>`,
    '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:7px;padding:9px 10px;border-radius:8px;background:#f6f7fb">',
    `<div><span style="display:block;color:#999;font-size:10px">当前播放</span><b>${escapeHtml(formatNumber(views))}</b></div>`,
    `<div><span style="display:block;color:#999;font-size:10px">当前互动</span><b>${escapeHtml(formatNumber(interactions))}</b></div>`,
    "</div>",
    workRows ? `<div style="max-height:240px;overflow:auto">${workRows}</div>` : '<span style="color:#999;font-size:11px">当天作品尚未匹配到视频明细</span>',
    works.length > 8 ? `<div style="padding-top:7px;color:#999;font-size:10px">另有 ${works.length - 8} 条作品，请到下方作品列表查看</div>` : "",
    "</div>",
  ].join("");
}
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value)); }
function comparisonNote(analytics: Analytics, metric: ComparisonMetric) { const rate = analytics.comparison?.changeRate[metric]; if (rate === null || rate === undefined) return "前期无可比增量"; return `较前期${rate >= 0 ? "+" : ""}${(rate * 100).toFixed(1)}%`; }
function formatImportErrors(value: string) { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
const importFieldLabels: Record<string, string> = { title: "作品名称", publishedAt: "发布时间", genre: "体裁", reviewStatus: "审核状态", views: "播放量", likes: "点赞量", shares: "分享量", comments: "评论量", saves: "收藏量", homepageVisits: "主页访问量", followerDelta: "粉丝增量", followersGained: "新增粉丝", leads: "线索", completionRate: "完播率", fiveSecondCompletionRate: "5秒完播率", coverCtr: "封面点击率", twoSecondBounceRate: "2秒跳出率", avgWatchMs: "平均播放时长", averageWatchSeconds: "平均观看秒数", publicationId: "发布记录ID", externalUrl: "作品链接", observedAt: "快照时间" };

export function InsightsWorkspace({ initialView, initialOrganizationId = "", initialProjectId = "" }: { initialView: InsightsView; initialOrganizationId?: string; initialProjectId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState(""); const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [loadedScope, setLoadedScope] = useState<{ organizationId: string; projectId: string } | null>(null);
  const [analytics, setAnalytics] = useState<Analytics>(emptyAnalytics); const [imports, setImports] = useState<ImportBatch[]>([]); const [platformImports, setPlatformImports] = useState<ImportBatch[]>([]); const [publications, setPublications] = useState<Publication[]>([]); const [reports, setReports] = useState<Report[]>([]); const [canImport, setCanImport] = useState(false); const [canGenerate, setCanGenerate] = useState(false);
  const [days, setDays] = useState(30); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [importFormat, setImportFormat] = useState<"standard" | "douyin_16">("douyin_16"); const [asOfAt, setAsOfAt] = useState(new Date().toISOString()); const [selectedReportId, setSelectedReportId] = useState("");

  const [importOffset, setImportOffset] = useState(0);
  const importPreview = useImportPreview<ParsedImportRow[]>(`${organizationId}:${projectId}:${importFormat}:${importOffset}`);
  const rows = importPreview.preview.data ?? [], filename = importPreview.preview.filename, parseMessage = importPreview.preview.message;

  const loadWorkspace = useCallback(async (orgId: string, projId: string, period = 30) => {
    if (!orgId || !projId) return;
    const scope = new URLSearchParams({ organizationId: orgId, projectId: projId });
    if (initialView === "performance") {
      const response = await scopedFetch(`/api/analytics?${scope}&days=${period}`);
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json() as Analytics & { canImport: boolean };
      setAnalytics(data);
      setCanImport(data.canImport);
    } else if (initialView === "imports") {
      const response = await scopedFetch(`/api/performance?${scope}`);
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json() as { imports: ImportBatch[]; platformImports?: ImportBatch[]; publications: Publication[]; canImport: boolean };
      setImports(data.imports);
      setPlatformImports(data.platformImports || []);
      setPublications(data.publications);
      setCanImport(data.canImport);
    } else if (initialView === "reports") {
      const response = await scopedFetch(`/api/reports?${scope}`);
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json() as { reports: Report[]; canGenerate: boolean };
      setReports(data.reports);
      setCanGenerate(data.canGenerate);
      setSelectedReportId(current => data.reports.some(report => report.id === current) ? current : data.reports[0]?.id || "");
    }
    setLoadedScope({ organizationId: orgId, projectId: projId });
  }, [initialView]);
  const loadProjects = useCallback(async (orgId: string, preferred = "") => {
    const body = await loadClientProjects<Project>(orgId, preferred); setProjects(body.projects); const next = body.selected; setProjectId(next); rememberCurrentScope(orgId, next); await loadWorkspace(orgId, next); }, [loadWorkspace]);
  useWorkspaceInitialization({ initialOrganizationId, initialProjectId, setOrganizations, setOrganizationId, loadProjects, setError, setLoading, failureMessage: "数据报告加载失败" });

  function changeScope(orgId: string, projId?: string) {
    setLoading(true);
    setError(""); setLoadedScope(null);
    return runScopedAction(async () => {
      if (projId !== undefined) {
        setProjectId(projId);
        rememberCurrentScope(orgId, projId);
        await loadWorkspace(orgId, projId, days);
      } else {
        setProjectId(""); setOrganizationId(orgId); setDays(30);
        await loadProjects(orgId);
      }
    }, setError).finally(() => setLoading(false));
  }

  function changePeriod(value: number) {
    if (busy || value === days) return;
    setBusy("period");
    setError("");
    void runScopedAction(async () => {
      await loadWorkspace(organizationId, projectId, value);
      setDays(value);
    }, setError).finally(() => setBusy(""));
  }

  const trendOption = useMemo<EChartsCoreOption>(() => {
    const singlePublishDate = analytics.publishedSeries.length === 1;
    const worksByDate = new Map<string, Analytics["contentPerformance"]>();
    for (const work of analytics.contentPerformance) {
      const date = work.publishedAt?.slice(0, 10);
      if (!date) continue;
      const grouped = worksByDate.get(date) || [];
      grouped.push(work);
      worksByDate.set(date, grouped);
    }
    const pointData = (item: Analytics["publishedSeries"][number], value: number) => ({ value, date: item.date, views: item.views, interactions: item.interactions, contentCount: item.contentCount, works: worksByDate.get(item.date) || [] });
    return {
      tooltip: { trigger: "item", confine: true, enterable: true, hideDelay: 180, extraCssText: "max-width:430px;white-space:normal;word-break:break-word;line-height:1.55;padding:12px 14px", formatter: publishedTrendTooltip },
      legend: { bottom: 0, textStyle: { color: "#536d64", fontSize: 10 } },
      grid: { left: 54, right: 54, top: 34, bottom: 44 },
      xAxis: { type: "category", boundaryGap: singlePublishDate, data: analytics.publishedSeries.map((item) => item.date.slice(5)), axisLine: { lineStyle: { color: "#dce7e1" } }, axisLabel: { color: "#60786f" } },
      yAxis: [
        { type: "value", name: "播放", nameTextStyle: { color: "#60786f", fontSize: 9 }, axisLabel: { color: "#60786f" }, splitLine: { lineStyle: { color: "#e9efea" } } },
        { type: "value", name: "互动", nameTextStyle: { color: "#60786f", fontSize: 9 }, axisLabel: { color: "#60786f" }, splitLine: { show: false } },
      ],
      series: [
        { name: "播放量", type: "line", yAxisIndex: 0, smooth: !singlePublishDate, showSymbol: true, symbol: "circle", symbolSize: singlePublishDate ? 12 : 7, data: analytics.publishedSeries.map((item) => pointData(item, item.views)), lineStyle: { color: "#10766f", width: 3 }, itemStyle: { color: "#fff", borderColor: "#10766f", borderWidth: 3 }, areaStyle: { color: "rgba(16,118,111,.10)" }, label: { show: singlePublishDate, position: "top", color: "#10766f", fontWeight: 700 } },
        { name: "互动量", type: "line", yAxisIndex: 1, smooth: !singlePublishDate, showSymbol: true, symbol: "diamond", symbolSize: singlePublishDate ? 12 : 7, data: analytics.publishedSeries.map((item) => pointData(item, item.interactions)), lineStyle: { color: "#97711d", width: 2 }, itemStyle: { color: "#fff", borderColor: "#97711d", borderWidth: 2 }, label: { show: singlePublishDate, position: "bottom", color: "#97711d", fontWeight: 700 } },
      ],
    };
  }, [analytics.contentPerformance, analytics.publishedSeries]);

  const performanceMapOption = useMemo<EChartsCoreOption>(() => {
    const works = analytics.contentPerformance.filter((item) => item.views > 0 || item.engagementRate > 0);
    const averageViews = works.length ? works.reduce((sum, item) => sum + item.views, 0) / works.length : 0;
    const averageEngagement = works.length ? works.reduce((sum, item) => sum + item.engagementRate * 100, 0) / works.length : 0;
    return {
      tooltip: { trigger: "item", confine: true, enterable: true, hideDelay: 300, extraCssText: "max-width:380px;white-space:normal;word-break:break-word;line-height:1.55;padding:12px 14px", formatter: performanceTooltip },
      grid: { left: 72, right: 36, top: 36, bottom: 58, containLabel: true },
      xAxis: { type: "value", name: "播放量", nameLocation: "middle", nameGap: 30, nameTextStyle: { color: "#60786f", fontSize: 9 }, axisLabel: { color: "#60786f" }, splitLine: { lineStyle: { color: "#e9efea" } } },
      yAxis: { type: "value", name: "互动率 %", nameTextStyle: { color: "#60786f", fontSize: 9 }, axisLabel: { color: "#60786f", formatter: "{value}%" }, splitLine: { lineStyle: { color: "#e9efea" } } },
      series: [{
        name: "作品", type: "scatter", symbolSize: 13,
        data: works.map((item) => ({ name: item.title, value: [item.views, Number((item.engagementRate * 100).toFixed(2)), item.followersGained], platform: item.platform, publishedAt: item.publishedAt, videoId: item.videoId, videoTitle: item.videoTitle, videoDurationSec: item.videoDurationSec, externalUrl: item.externalUrl, itemStyle: { color: item.engagementRate >= averageEngagement / 100 ? "#10766f" : "#bf9442", borderColor: "#fff", borderWidth: 2 } })),
        emphasis: { scale: 1.25, focus: "self", label: { show: false } },
        markLine: { silent: true, symbol: ["none", "none"], label: { color: "#60786f", fontSize: 8 }, lineStyle: { color: "#b6c9bf", type: "dashed" }, data: [{ xAxis: averageViews, name: "平均播放" }, { yAxis: averageEngagement, name: "平均互动率" }] },
      }],
    };
  }, [analytics.contentPerformance]);
  const selectedReport = reports.find((report) => report.id === selectedReportId) || null;

  function downloadTemplate() { const template: Array<Record<string, string | number>> = importFormat === "douyin_16" ? [{ "作品名称": "示例作品", "发布时间": new Date().toISOString(), "体裁": "知识分享", "审核状态": "已通过", "播放量": 0, "完播率": "0%", "5s完播率": "0%", "封面点击率": "0%", "2s跳出率": "0%", "平均播放时长": "00:00", "点赞量": 0, "分享量": 0, "评论量": 0, "收藏量": 0, "主页访问量": 0, "粉丝增量": 0 }] : [{ publication_id: publications[0]?.id || "发布记录ID", external_url: publications[0]?.external_url || "https://example.com/video", observed_at: new Date().toISOString(), views: 0, likes: 0, comments: 0, shares: 0, saves: 0, followers_gained: 0, leads: 0, average_watch_seconds: 0, completion_rate: 0 }]; const csv = Papa.unparse(template); const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = importFormat === "douyin_16" ? "利明智耀-抖音16字段导入模板.csv" : "利明智耀-标准运营数据导入模板.csv"; link.click(); URL.revokeObjectURL(link.href); }
  function parseRows(data: Array<Record<string, unknown>>) {
    if (data.length > 500) throw new Error("单次最多导入 500 行，请拆分文件后重试");
    const required = importFormat === "douyin_16" ? ["作品名称", "发布时间", "播放量"] : ["observed_at", "views"];
    if (data.length && required.some(header => !Object.hasOwn(data[0], header))) throw new Error("文件缺少必需表头，请使用对应模板（播放量不能缺列）。");
    const parsed: ParsedImportRow[] = data.map((row, index) => { try { if (importFormat === "douyin_16") {
      const avgWatchMs = watchMetricMilliseconds(row["平均播放时长"]);
      return { title: String(row["作品名称"] ?? "").trim(), publishedAt: importDate(row["发布时间"], importOffset), genre: String(row["体裁"] ?? "").trim() || undefined, reviewStatus: String(row["审核状态"] ?? "").trim() || undefined, views: metricNumberCell(row["播放量"]), completionRate: percentMetricCell(row["完播率"]), fiveSecondCompletionRate: percentMetricCell(row["5s完播率"]), coverCtr: percentMetricCell(row["封面点击率"]), twoSecondBounceRate: percentMetricCell(row["2s跳出率"]), avgWatchMs, likes: metricNumberCell(row["点赞量"]), shares: metricNumberCell(row["分享量"]), comments: metricNumberCell(row["评论量"]), saves: metricNumberCell(row["收藏量"]), homepageVisits: metricNumberCell(row["主页访问量"]), followerDelta: signedMetricNumberCell(row["粉丝增量"]) };
    } else {
      const observed = importDate(row.observed_at, importOffset);
      const completion = String(row.completion_rate || "").trim(); const watch = String(row.average_watch_seconds || "").trim();
      return { publicationId: String(row.publication_id || "").trim() || undefined, externalUrl: String(row.external_url || "").trim() || undefined, observedAt: observed, views: metricNumberCell(row.views), likes: metricNumberCell(row.likes), comments: metricNumberCell(row.comments), shares: metricNumberCell(row.shares), saves: metricNumberCell(row.saves), followersGained: metricNumberCell(row.followers_gained), leads: metricNumberCell(row.leads), averageWatchSeconds: watch ? metricNumberCell(watch) : undefined, completionRate: completion ? percentMetricCell(completion) : undefined };
    } } catch (error) { throw new Error(`第 ${index + 1} 条数据：${error instanceof Error ? error.message : "内容无效"}`); } });
    parsed.forEach((row, index) => {
      const result = (importFormat === "douyin_16" ? douyinMetricRowSchema : performanceRowSchema).safeParse(row);
      if (!result.success) { const issue = result.error.issues[0], label = importFieldLabels[String(issue.path[0])] || "记录"; throw new Error(`第 ${index + 1} 条数据「${label}」未通过校验，请核对必填项、长度或数值范围。`); }
    });
    if (!parsed.length) throw new Error("文件没有可导入的数据行");
    const missingMetricCount = importFormat === "douyin_16" ? data.reduce((count, row) => count + ["完播率", "5s完播率", "封面点击率", "2s跳出率", "平均播放时长", "播放量", "点赞量", "分享量", "评论量", "收藏量", "主页访问量", "粉丝增量"].filter((key) => isMissingMetricCell(row[key])).length, 0) : 0;
    return { data: parsed, message: "已解析 " + parsed.length + " 行" + (missingMetricCount ? "；识别 " + missingMetricCount + " 处平台暂无数据，比例和时长留空、计数项按 0 处理。" : "；提交时由服务器再次校验。"), phase: "ready" as const };
  }
  async function parseImportFile(file: File) {
    if (busy === "import") return;
    const operation = importPreview.begin(file.name);
    setError("");
    try {
      if (file.name.toLowerCase().endsWith(".xlsx")) {
        if (importFormat !== "douyin_16") throw new Error("XLSX 当前用于抖音 16 字段导入，请切换导入格式。");
        const data = await readFirstWorksheet(file, { signal: operation.signal, dateHeaders: ["发布时间"], offsetMinutes: importOffset });
        if (operation.isCurrent()) operation.update(parseRows(data));
        return;
      }
      if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("请选择 CSV 或 XLSX 文件。");
      const data = await readCsvTable(file, { signal: operation.signal,
        requiredHeaders: importFormat === "douyin_16" ? ["作品名称", "发布时间", "播放量"] : ["observed_at", "views"],
        oneOfHeaders: importFormat === "standard" ? ["publication_id", "external_url"] : undefined });
      if (operation.isCurrent()) operation.update(parseRows(data));
    } catch (reason) { operation.update({ phase: "error", message: reason instanceof Error ? reason.message : "文件解析失败" }); }
  }
  async function submitImport() {
    const operation = importPreview.current();
    if (!operation || !operation.isCurrent() || !canImport || !rows.length || importPreview.preview.phase !== "ready") return;
    if (importFormat === "douyin_16" && !asOfAt) return;
    operation.update({ phase: "importing" }); setBusy("import"); setError("");
    let acknowledged = false;
    try {
      const source = filename.toLowerCase().endsWith(".xlsx") ? "xlsx" : "csv";
      const payload = importFormat === "douyin_16" ? { organizationId, projectId, source, format: "douyin_16", asOfAt, filename, rows } : { organizationId, projectId, source: "csv", filename, rows };
      const response = await scopedFetch("/api/performance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!operation.isCurrent()) return;
      if (!response.ok) { const message = await readError(response); if (operation.isCurrent()) { setError(message); operation.update({ phase: "ready" }); } return; }
      const receipt = await response.json().catch(() => null) as { import?: { id?: unknown } } | null;
      if (!operation.isCurrent()) return;
      if (typeof receipt?.import?.id !== "string" || !receipt.import.id) throw new Error("Import acknowledgement unreadable");
      acknowledged = true;
      operation.update({ data: null, filename: "", phase: "done", message: importFormat === "douyin_16" ? "抖音快照导入完成；歧义作品已保留待人工映射。" : "标准快照导入完成，复盘指标已经更新。" });
      await loadWorkspace(organizationId, projectId, days);
    } catch {
      if (operation.isCurrent()) {
        setError(acknowledged ? "数据已导入，但历史刷新失败，请刷新页面核对。" : "暂时无法确认导入结果，请刷新导入历史核对后再决定重试，勿立即重复提交。");
        if (!acknowledged) operation.update({ phase: "ready" });
      }
    } finally { setBusy(""); }
  }
  async function generateReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget); setBusy("report"); setError(""); let saved = false;
    try {
      const response = await scopedFetch("/api/reports", { method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({organizationId,projectId,reportType:form.get("reportType"),periodStart:form.get("periodStart"),periodEnd:form.get("periodEnd"),title:form.get("title")||undefined}) });
      if (!response.ok) { setError(await readError(response)); return; }
      const body = await response.json() as { report:Report };
      if (!body.report?.id || !body.report.updated_at) throw new Error("报告保存回执不完整，请刷新列表核对，勿立即重复生成。");
      saved = true; await loadWorkspace(organizationId,projectId,days); setSelectedReportId(body.report.id);
    } catch(error) {
      setError(saved ? "报告已保存，但列表刷新失败。请恢复连接并刷新页面查看，勿重复生成。"
        : error instanceof TypeError ? "报告请求连接中断，暂时无法确认是否已保存。请刷新列表核对，勿立即重复生成。" : error instanceof Error ? error.message : "报告操作失败，请刷新列表核对。");
    } finally { setBusy(""); }
  }
  async function finalizeReport() {
    if (!selectedReport || busy) return;
    setBusy("finalize"); setError(""); let saved = false;
    try {
      const response = await scopedFetch(`/api/reports/${selectedReport.id}/finalize`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({organizationId,projectId,expectedUpdatedAt:selectedReport.updated_at})});
      if (!response.ok) { setError(await readError(response)); return; }
      const body = await response.json() as { report:Report };
      if (body.report?.id !== selectedReport.id || body.report.status !== "final") throw new Error("报告定稿回执不完整，请刷新列表核对，勿重复定稿。");
      saved = true; await loadWorkspace(organizationId,projectId,days);
    } catch(error) {
      setError(saved ? "报告已定稿，但列表刷新失败。请恢复连接并刷新页面核对。"
        : error instanceof TypeError ? "定稿请求连接中断，暂时无法确认结果。请刷新报告核对，勿连续点击定稿。" : error instanceof Error ? error.message : "定稿失败，请刷新报告核对。");
    } finally { setBusy(""); }
  }

  if (loading) return <div className="management-state" role="status">正在载入数据报告…</div>;
  const scopeQuery = new URLSearchParams({ organizationId, projectId });
  const importHref = `/insights?view=imports&${scopeQuery}`;
  const matchHref = `/insights?view=matches&${scopeQuery}`;
  const performanceHref = `/insights?view=performance&${scopeQuery}`;
  return <div className="insights-workspace">
    {organizations.length > 0 && <div className="management-toolbar insights-toolbar">
      <label>公司<select aria-label="公司" value={organizationId} disabled={Boolean(busy)} onChange={(event) => void changeScope(event.target.value)}>
        {organizations.map((organization) => <option value={organization.id} key={organization.id}>{organization.name}</option>)}
      </select></label>
      <label>企业空间<select aria-label="企业空间" value={projectId} disabled={Boolean(busy) || !projects.length} onChange={(event) => void changeScope(organizationId, event.target.value)}>
        {!projects.length && <option value="">暂无企业空间</option>}
        {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
      </select></label>
      {initialView === "reports" && organizationId && projectId && <nav aria-label="报告数据"><Link href={importHref}>导入创作者后台数据</Link></nav>}
      {["imports", "matches", "performance"].includes(initialView) && organizationId && projectId && <nav aria-label="报告数据">
        <Link href={importHref} aria-current={initialView === "imports" ? "page" : undefined}>后台数据导入</Link>
        <Link href={matchHref} aria-current={initialView === "matches" ? "page" : undefined}>作品匹配</Link>
        <Link href={performanceHref} aria-current={initialView === "performance" ? "page" : undefined}>已导入作品表现</Link>
      </nav>}
    </div>}
    {error && <div className="inline-alert" role="alert">{error}</div>}
    {!organizationId || !projectId
      ? <div className="empty-panel"><h2>请选择企业空间</h2><p>运营数据和报告按企业空间管理。</p><a className="primary-button link-button" href="/projects">管理企业空间</a></div>
      : loadedScope?.organizationId === organizationId && loadedScope.projectId === projectId && <>
    {initialView === "overview" && <AnalyzedAccountsOverview key={projectId} organizationId={organizationId} projectId={projectId} />}
    {initialView === "performance" && <Overview analytics={analytics} trendOption={trendOption} performanceMapOption={performanceMapOption} days={days} onDays={changePeriod} updating={busy === "period"} importHref={canImport ? importHref : undefined} />}
    {initialView === "imports" && <ImportView canImport={canImport} imports={[...platformImports, ...imports]} rows={rows} filename={filename} format={importFormat} offsetMinutes={importOffset} onOffset={(value) => { setImportOffset(value); importPreview.clear(); }} asOfAt={asOfAt} message={parseMessage} phase={importPreview.preview.phase} busy={busy} onFormat={(value) => { setImportFormat(value); importPreview.clear(); }} onAsOfAt={(value) => { try { setAsOfAt(value ? importDate(value, importOffset) : ""); } catch { setAsOfAt(""); setError("数据截至时间无效，请重新填写。"); } }} onTemplate={downloadTemplate} onFile={parseImportFile} onSubmit={submitImport} matchHref={matchHref} />}
    {initialView === "matches" && <OwnedWorkMatchingView organizationId={organizationId} projectId={projectId} />}
    {initialView === "reports" && <ReportsView reports={reports} selected={selectedReport} organizationId={organizationId} projectId={projectId} canGenerate={canGenerate} busy={busy} onSelect={setSelectedReportId} onGenerate={generateReport} onFinalize={finalizeReport} />}
      </>}
  </div>;
}

type OverviewDisplay = "ranking" | "published" | "distribution";
const overviewDisplays = { ranking: "作品排行", published: "发布时间", distribution: "表现分布" } as const;

function Overview({ analytics, trendOption, performanceMapOption, days, onDays, updating, importHref }: {
  analytics: Analytics;
  trendOption: EChartsCoreOption;
  performanceMapOption: EChartsCoreOption;
  days: number;
  onDays: (days: number) => void;
  updating: boolean;
  importHref?: string;
}) {
  const [display, setDisplay] = useState<OverviewDisplay>("ranking");
  const { summary } = analytics;
  const coverage = summary.baselineCoverage;
  const range = <div className="insights-period overview-period">
    <span>{analytics.periodStart} 至 {analytics.periodEnd}</span>
    <div role="group" aria-label="统计周期">
      {[30, 90, 365].map(value => <button type="button" key={value} aria-pressed={days === value}
        disabled={updating} onClick={() => onDays(value)}>{value === 365 ? "一年" : `${value} 天`}</button>)}
    </div>
  </div>;
  return <section className="insights-overview" aria-busy={updating}>
    {range}
    {coverage && coverage.partial > 0 && <p className="overview-data-note" role="status"><strong>增量口径为部分覆盖</strong> {coverage.partial} 条历史作品缺少期初快照，从本期首条快照开始计算。</p>}
    {!!summary.timestampAliases && <p className="overview-data-note" role="status"><strong>历史时间重复需核对</strong> {summary.timestampAliases} 条快照属于同一作品和时刻，其中 {summary.timestampConflicts || 0} 条指标不一致，统计采用首个已保存值，原记录未改。</p>}
    {!summary.contentCount ? <div className="panel overview-empty">
      <FileSpreadsheet size={24} aria-hidden="true" />
      <h2>这个周期还没有作品数据</h2>
      <p>{importHref ? "可导入作品数据，或切换上方统计周期。" : "可切换统计周期，或联系空间成员导入作品数据。"}</p>
      {importHref && <Link href={importHref} className="primary-button">导入作品数据</Link>}
    </div> : <>
    <div className="kpi-grid">
      <Kpi label="新增播放" value={formatNumber(summary.views)} note={`期末累计 ${formatNumber(summary.cumulativeViews ?? summary.views)} · ${comparisonNote(analytics, "views")}`} />
      <Kpi label="周期互动率" value={`${(summary.engagementRate * 100).toFixed(2)}%`} note={`${formatNumber(summary.interactions)} 次新增互动 · ${comparisonNote(analytics, "interactions")}`} />
      <Kpi label="新增关注" value={formatNumber(summary.followersGained)} note={comparisonNote(analytics, "followersGained")} />
      <Kpi label="新增线索" value={formatNumber(summary.leads)} note={`转化率 ${(summary.leadRate * 100).toFixed(2)}% · ${comparisonNote(analytics, "leads")}`} />
    </div>
    <section className="panel overview-works">
      <header>
        <h2>作品表现 <span>{summary.contentCount} 条</span></h2>
        <div className="overview-display" role="group" aria-label="作品表现视图">
          {(Object.keys(overviewDisplays) as OverviewDisplay[]).map(value =>
            <button type="button" key={value} aria-pressed={display === value} onClick={() => setDisplay(value)}>{overviewDisplays[value]}</button>)}
        </div>
      </header>
      {display === "ranking" && <div className="overview-ranking"><table>
        <caption>按周期新增播放排序</caption>
        <thead><tr><th scope="col">作品</th><th scope="col">新增播放</th><th scope="col">互动率</th><th scope="col">新增关注</th><th scope="col">新增线索</th></tr></thead>
        <tbody>{analytics.topContent.map((item, index) => <tr key={item.publicationId}>
          <th scope="row"><div className="overview-work-name"><span aria-hidden="true">{index + 1}</span><div>
            {item.externalUrl ? <a href={item.externalUrl} title={item.title} target="_blank" rel="noreferrer">{item.title}</a> : <strong title={item.title}>{item.title}</strong>}
            <small>{platformLabels[item.platform] || item.platform}{item.cumulativeViews !== undefined && ` · 累计播放 ${formatNumber(item.cumulativeViews)}`}</small>
          </div></div></th>
          <td><small aria-hidden="true">新增播放</small>{formatNumber(item.views)}</td>
          <td><small aria-hidden="true">互动率</small>{(item.engagementRate * 100).toFixed(2)}%</td>
          <td><small aria-hidden="true">新增关注</small>{formatNumber(item.followersGained)}</td>
          <td><small aria-hidden="true">新增线索</small>{formatNumber(item.leads)}</td>
        </tr>)}</tbody>
      </table></div>}
      {display === "published" && (analytics.publishedSeries.length ?
        <div className="overview-chart"><p>按发布时间的作品表现 · 汇总同日作品，悬停查看视频明细</p>
          <EChart option={trendOption} label="按作品发布时间汇总的播放与互动表现图" /></div> : <p className="overview-chart-note">本期作品缺少可用于绘图的发布时间。</p>)}
      {display === "distribution" && (analytics.contentPerformance.some(item => item.views > 0 || item.engagementRate > 0) ?
        <div className="overview-chart"><p>全部作品表现分布 · 每个点代表一条作品</p>
          <EChart option={performanceMapOption} height={380} label="全部作品播放量与互动率分布图" /></div> : <p className="overview-chart-note">本期作品还没有可绘制的播放或互动增量。</p>)}
    </section>
    </>}
  </section>;
}
function Kpi({ label, value, note }: { label: string; value: string; note: string }) { return <article><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
function ImportView({ canImport, imports, rows, filename, format, offsetMinutes, onOffset, asOfAt, message, phase, busy, onFormat, onAsOfAt, onTemplate, onFile, onSubmit, matchHref }: { canImport: boolean; imports: ImportBatch[]; rows: ParsedImportRow[]; filename: string; format: "standard" | "douyin_16"; offsetMinutes: number; onOffset: (value: number) => void; asOfAt: string; message: string; phase: string; busy: string; onFormat: (value: "standard" | "douyin_16") => void; onAsOfAt: (value: string) => void; onTemplate: () => void; onFile: (file: File) => void; onSubmit: () => void; matchHref: string }) {
  const douyin = format === "douyin_16";
  const importing = busy === "import";
  const messageState = phase === "error" ? "error" : phase === "ready" || phase === "done" ? "success" : "neutral";
  const timeZone = offsetMinutes === 480 ? "UTC+08:00" : "UTC+00:00";
  const cutoff = asOfAt ? importDateInput(asOfAt, offsetMinutes).replace("T", " ") : "";
  const history = [...imports].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const hasIssues = (batch: ImportBatch) => batch.status !== "completed" || batch.rejected_count > 0 || Boolean(batch.errors_json && batch.errors_json.trim() !== "[]");
  const issueCount = history.filter(hasIssues).length;
  const hasImportedRows = history.some(item => item.status === "completed" && item.accepted_count > 0);

  return <div className="performance-import">
    <section className="panel performance-import-card" aria-labelledby="performance-import-title">
      <header className="performance-import-heading">
        <h2 id="performance-import-title">导入作品数据</h2>
        <button className="performance-template" type="button" onClick={onTemplate}><FileSpreadsheet size={16} aria-hidden="true" />下载 CSV 模板</button>
      </header>
      <div className="performance-import-body">
        <div className="import-format-switch" role="group" aria-label="文件格式">
          <button type="button" aria-pressed={douyin} disabled={importing} onClick={() => { if (!douyin) onFormat("douyin_16"); }}>抖音作品列表</button>
          <button type="button" aria-pressed={!douyin} disabled={importing} onClick={() => { if (douyin) onFormat("standard"); }}>标准发布快照</button>
        </div>
        {canImport ? <>
          <label className={`import-file-drop${filename ? " has-file" : ""}`}>
            <input type="file" aria-label="选择作品数据文件" disabled={importing}
              accept={douyin ? ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : ".csv,text/csv"}
              onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onFile(file); }} />
            {phase === "reading" ? <Clock3 aria-hidden="true" /> : phase === "error" ? <AlertTriangle aria-hidden="true" /> : filename ? <CheckCircle2 aria-hidden="true" /> : <UploadCloud aria-hidden="true" />}
            <strong>{filename || "选择或拖入作品列表"}</strong>
            <span>{phase === "error" ? "读取未完成，可重新选择文件" : filename ? "点击更换文件" : douyin ? "抖音创作者中心导出的 XLSX 或 CSV，最多 500 条、20 MiB" : "含发布记录 ID 或作品链接的 CSV，最多 500 条、20 MiB"}</span>
          </label>
          {message && <p role={phase === "error" ? "alert" : "status"} className={`import-message ${messageState}`}>{message}</p>}
          {rows.length > 0 && <section className="performance-import-preview" aria-labelledby="import-preview-title">
            <div><h3 id="import-preview-title">数据预览</h3><span>{rows.length > 3 ? `前 3 条 / 共 ${rows.length} 条` : `共 ${rows.length} 条`} · 累计播放 {rows.reduce((sum, row) => sum + row.views, 0).toLocaleString("zh-CN")}</span></div>
            <table>
              <thead><tr><th scope="col">{douyin ? "作品名称" : "作品链接 / 发布记录"}</th><th scope="col">{douyin ? "发布时间" : "快照时间"}<small>{timeZone}</small></th><th scope="col">播放量</th></tr></thead>
              <tbody>{rows.slice(0, 3).map((row, index) => <tr key={index}>
                <td>{"title" in row ? row.title : row.externalUrl || row.publicationId}</td>
                <td>{importDateInput("publishedAt" in row ? row.publishedAt : row.observedAt, offsetMinutes).replace("T", " ")}</td>
                <td>{row.views.toLocaleString("zh-CN")}</td>
              </tr>)}</tbody>
            </table>
          </section>}
          <div className="performance-import-controls">
            <details className="performance-import-settings">
              <summary><strong>时间设置</strong><span>{douyin ? cutoff ? `截至 ${cutoff} · ${timeZone}` : "请填写数据截至时间" : timeZone}</span></summary>
              <div className="performance-time-fields">
                <label className="import-asof" htmlFor="performance-import-timezone">文件日期时区
                  <select id="performance-import-timezone" disabled={importing} value={offsetMinutes} onChange={event => onOffset(Number(event.target.value))}>
                    <option value={0}>UTC +00:00</option><option value={480}>北京时间 +08:00</option>
                  </select>
                </label>
                {douyin && <label className="import-asof" htmlFor="performance-import-cutoff">数据截至时间
                  <input id="performance-import-cutoff" type="datetime-local" required disabled={importing} value={asOfAt ? importDateInput(asOfAt, offsetMinutes) : ""} onChange={event => onAsOfAt(event.target.value)} />
                </label>}
                <p>无时区的日期按所选时区读取，统计按 UTC 日期分组。更改时区后需重新选择文件。</p>
              </div>
            </details>
            <button type="button" className="primary-button" disabled={phase !== "ready" || !rows.length || importing || (douyin && !asOfAt)} onClick={onSubmit}>
              {importing ? "正在导入…" : rows.length ? `确认导入 ${rows.length} 条` : "确认导入"}
            </button>
          </div>
        </> : <p className="import-permission-note">当前账号只能查看。请联系企业空间管理员或可编辑成员导入文件。</p>}
      </div>
    </section>

    <section className="panel import-history performance-import-history" aria-label="导入历史">
      <details open={issueCount > 0}>
        <summary><strong>导入历史</strong><span>{history.length} 个批次{issueCount > 0 ? ` · ${issueCount} 个需核对` : ""}</span></summary>
        {history.length ? <div className="performance-batches">{history.map(item => {
          const complete = item.status === "completed", interrupted = item.status === "failed", warning = hasIssues(item);
          return <article key={item.id}>
            {warning ? <AlertTriangle size={16} className="batch-warning" aria-label="需核对" /> : <CheckCircle2 size={16} aria-hidden="true" />}
            <div><strong>{item.original_filename || "手动导入"}</strong><span>{complete ? `已完成 · ${item.accepted_count} 条成功${item.rejected_count ? " · " + item.rejected_count + " 条未导入" : ""}` : interrupted ? "未完成，请核对已保存数据后重试" : "未完成，需管理员停服核对"}</span></div>
            <small>{formatDate(item.created_at)}{item.as_of_at ? ` · 截至 ${formatDate(item.as_of_at)}` : " · 标准格式"}</small>
            {warning && <details><summary>查看问题与批次</summary>
              <p>批次编号 {item.id}</p>{item.errors_json && <pre>{formatImportErrors(item.errors_json)}</pre>}
              {!complete && <p>{interrupted ? "保留原文件及数据截至时间，先核对已保存的数据，再决定是否重试。" : "请管理员按备份恢复说明核对旧导入批次，处理前请保留当前记录。"}</p>}
            </details>}
          </article>;
        })}</div> : <p>还没有导入记录。</p>}
      </details>
      {hasImportedRows && <a className="performance-match-link" href={matchHref}>匹配已导入作品<ArrowRight size={15} aria-hidden="true" /></a>}
    </section>
  </div>;
}

type ReportsViewProps = { reports: Report[]; selected: Report | null; organizationId: string; projectId: string; canGenerate: boolean; busy: string; onSelect: (id: string) => void; onGenerate: (event: FormEvent<HTMLFormElement>) => void; onFinalize: () => void };

function ReportsView(props: ReportsViewProps) {
  const [mode, setMode] = useState<"enterprise" | "employee">("enterprise");
  const [employeeVisited, setEmployeeVisited] = useState(false);
  return <div className="report-center-shell">
    <section className="report-mode-header report-mode-compact">
      <nav aria-label="报告类型"><button type="button" aria-pressed={mode === "enterprise"} className={mode === "enterprise" ? "active" : ""} onClick={() => setMode("enterprise")}><Building2 aria-hidden="true" />企业运营报告</button><button type="button" aria-pressed={mode === "employee"} className={mode === "employee" ? "active" : ""} onClick={() => { setEmployeeVisited(true); setMode("employee"); }}><UserRound aria-hidden="true" />员工工作报告</button></nav>
    </section>
    <div hidden={mode !== "enterprise"}><EnterpriseReportsView key={`${props.organizationId}:${props.projectId}:${props.selected?.id ?? ""}`} {...props} /></div>
    {employeeVisited && <div hidden={mode !== "employee"}><EmployeeReportsView key={`${props.organizationId}:${props.projectId}`} organizationId={props.organizationId} projectId={props.projectId} /></div>}
  </div>;
}

function EnterpriseReportsView({ reports, selected, organizationId, projectId, canGenerate, busy, onSelect, onGenerate, onFinalize }: ReportsViewProps) {
  const [savedMemoLocators, setSavedMemoLocators] = useState<Set<string>>(new Set());
  const [memoBusy, setMemoBusy] = useState("");
  const [memoNotice, setMemoNotice] = useState("");
  const selectedId = selected?.id;
  useEffect(() => {
    let active = true;
    if (!selectedId || !organizationId) return;
    void scopedFetch(`/api/personal-memos?organizationId=${encodeURIComponent(organizationId)}&sourceType=performance_report&sourceId=${encodeURIComponent(selectedId)}`).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { memos: Array<{ source_locator: string | null }> };
      if (active) setSavedMemoLocators(new Set(body.memos.map((memo) => memo.source_locator).filter((value): value is string => Boolean(value))));
    }).catch(() => { if (active) setMemoNotice("已保存备忘暂时无法读取，请稍后重试。"); });
    return () => { active = false; };
  }, [organizationId, selectedId]);
  async function saveRecommendation(item: string, index: number) {
    if (!selected) return; const locator = `recommendation:${index}`; setMemoBusy(locator); setMemoNotice("");
    try {
      const response = await scopedFetch("/api/personal-memos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, content: item, sourceType: "performance_report", sourceId: selected.id, sourceLocator: locator }) });
      if (!response.ok) setMemoNotice(await readError(response));
      else { setSavedMemoLocators((current) => new Set([...current, locator])); setMemoNotice("已保存到你的工作台备忘。"); }
    } catch { setMemoNotice("备忘保存失败，请检查网络后重试。"); }
    finally { setMemoBusy(""); }
  }
  const highlights = selected ? JSON.parse(selected.highlights_json) as string[] : [];
  const recommendations = selected ? JSON.parse(selected.recommendations_json) as string[] : [];
  const metrics = selected ? JSON.parse(selected.metrics_json) as Analytics : null;
  const recommendationRow = (item: string, index: number) => { const locator = `recommendation:${index}`; const saved = savedMemoLocators.has(locator); return <article key={`${item}-${index}`}><i aria-hidden="true">{String(index + 1).padStart(2, "0")}</i><p>{item}</p><button type="button" disabled={saved || Boolean(memoBusy)} onClick={() => void saveRecommendation(item, index)}>{saved ? <BookmarkCheck aria-hidden="true" /> : <BookmarkPlus aria-hidden="true" />}{saved ? "已记到备忘" : memoBusy === locator ? "保存中" : "记到我的备忘"}</button></article>; };
  return <PeriodicReportLayout key={selected?.updated_at} enterprise reports={reports} selectedId={selected?.id}
    canGenerate={canGenerate} busy={Boolean(busy)} onGenerate={onGenerate} onSelect={onSelect}>
    <main className="panel report-document">{selected && metrics ? <>
      <header><div><span>{selected.status === "final" ? "正式报告" : "报告草稿"}</span><h1>{selected.title}</h1><p>{selected.period_start} 至 {selected.period_end} · 生成于 {formatDate(selected.generated_at)}</p></div><div><button onClick={() => window.print()}>打印</button>{selected.status === "draft" && canGenerate && <button className="primary" disabled={Boolean(busy)} onClick={onFinalize}>{busy === "finalize" ? "正在定稿…" : "确认定稿"}</button>}</div></header>
      <section className="report-brief"><div><span>本期判断</span><h2>{selected.summary}</h2></div>{metrics.summary.contentCount > 0 ? <aside><span>数据覆盖</span><strong>{metrics.summary.baselineCoverage ? `${metrics.summary.baselineCoverage.complete}/${metrics.summary.baselineCoverage.total}` : metrics.summary.contentCount}</strong><small>{metrics.summary.baselineCoverage?.partial ? `${metrics.summary.baselineCoverage.partial} 条仅部分覆盖` : "可用于本期判断"}</small></aside> : <Link className="report-import-link" href={`/insights?view=imports&${new URLSearchParams({ organizationId, projectId })}`}>查看数据导入 →</Link>}</section>
      {metrics.summary.contentCount > 0 && <section className="report-result-block"><header><div><h2>本期核心指标</h2></div></header><div className="report-kpis"><Kpi label="纳入内容" value={String(metrics.summary.contentCount)} note="本期可比作品" /><Kpi label="新增播放" value={formatNumber(metrics.summary.views)} note={metrics.comparison ? comparisonNote(metrics, "views") : "暂无可比前期"} /><Kpi label="周期互动率" value={metrics.summary.views > 0 && Number.isFinite(metrics.summary.engagementRate) ? `${(metrics.summary.engagementRate * 100).toFixed(2)}%` : "—"} note={`${formatNumber(metrics.summary.interactions)} 次新增互动`} /><Kpi label="新增线索" value={formatNumber(metrics.summary.leads)} note={metrics.comparison ? comparisonNote(metrics, "leads") : "暂无可比前期"} /></div>
        {metrics.topContent.length > 0 && <div className="report-result-ranking"><div className="heading"><span>表现前列内容</span><span>新增播放</span><span>互动率</span></div>{metrics.topContent.slice(0, 3).map((item, index) => <a key={item.publicationId} href={item.externalUrl || undefined} target={item.externalUrl ? "_blank" : undefined} rel="noreferrer"><span><i>{index + 1}</i><strong>{item.title}</strong></span><b>{formatNumber(item.views)}</b><em>{(item.engagementRate * 100).toFixed(2)}%</em></a>)}</div>}
      </section>}
      {(highlights.length > 0 || recommendations.length > 0) && <section className="report-decision-block"><div className="report-narrative-grid">
        {highlights.length > 0 && <section className="report-findings"><header><div><h2>关键发现</h2></div><small>{highlights.length} 条</small></header><div>{highlights.slice(0, 3).map((item) => <article key={item}><i aria-hidden="true" /><p>{item}</p></article>)}</div>{highlights.length > 3 && <details className="report-more-items"><summary>查看其余 {highlights.length - 3} 条发现</summary><div>{highlights.slice(3).map((item) => <article key={item}><i aria-hidden="true" /><p>{item}</p></article>)}</div></details>}</section>}
        {recommendations.length > 0 && <section className="report-actions"><header><div><h2>下期建议</h2></div><small>{recommendations.length} 条</small></header>{memoNotice && <p className="report-memo-notice" role="status">{memoNotice}</p>}<div>{recommendations.slice(0, 3).map(recommendationRow)}</div>{recommendations.length > 3 && <details className="report-more-items"><summary>查看其余 {recommendations.length - 3} 条建议</summary><div>{recommendations.slice(3).map((item, offset) => recommendationRow(item, offset + 3))}</div></details>}</section>}
      </div></section>}
      {metrics.diagnostics && <DiagnosticView diagnostics={metrics.diagnostics} />}
    </> : <div className="report-empty"><h2>暂无企业运营报告</h2><p>已生成的报告会显示在这里。</p></div>}</main>
  </PeriodicReportLayout>;
}

function EmployeeReportsView({ organizationId, projectId }: { organizationId: string; projectId: string }) {
  const [employees, setEmployees] = useState<EmployeeOption[]>([]); const [employeeUserId, setEmployeeUserId] = useState(""); const [reports, setReports] = useState<EmployeeReport[]>([]); const [selectedReportId, setSelectedReportId] = useState("");
  const [canGenerate, setCanGenerate] = useState(false); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const fetchReports = useCallback(async (targetUserId = "", signal?: AbortSignal) => {
    const query = new URLSearchParams({ organizationId, projectId }); if (targetUserId) query.set("employeeUserId", targetUserId);
    const response = await scopedFetch(`/api/employee-reports?${query.toString()}`, { signal }); if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as { reports: EmployeeReport[]; employees: EmployeeOption[]; selectedEmployeeId: string; canGenerate: boolean };
    return body;
  }, [organizationId, projectId]);
  const applyReports = useCallback((body: { reports: EmployeeReport[]; employees: EmployeeOption[]; selectedEmployeeId: string; canGenerate: boolean }) => {
    setEmployees(body.employees); setEmployeeUserId(body.selectedEmployeeId); setReports(body.reports); setCanGenerate(body.canGenerate); setSelectedReportId((current) => body.reports.some((report) => report.id === current) ? current : body.reports[0]?.id || "");
  }, []);
  const loadReports = useCallback(async (targetUserId = "") => {
    applyReports(await fetchReports(targetUserId));
  }, [fetchReports, applyReports]);
  useEffect(() => {
    const controller = new AbortController();
    void fetchReports("", controller.signal).then((body) => { if (!controller.signal.aborted) applyReports(body); }).catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "员工报告加载失败"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [fetchReports, applyReports]);
  async function selectEmployee(value: string) { setLoading(true); setError(""); try { await loadReports(value); } catch (reason) { setError(reason instanceof Error ? reason.message : "员工报告加载失败"); } finally { setLoading(false); } }
  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget); setBusy(true); setError(""); let saved = false;
    try {
      const response = await scopedFetch("/api/employee-reports", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({organizationId,projectId,employeeUserId,reportType:form.get("reportType"),periodStart:form.get("periodStart"),periodEnd:form.get("periodEnd"),title:form.get("title")||undefined})});
      if (!response.ok) { setError(await readError(response)); return; }
      const body = await response.json() as { report:EmployeeReport };
      if (!body.report?.id || !body.report.updated_at) throw new Error("员工报告保存回执不完整，请刷新列表核对，勿立即重复生成。");
      saved = true; await loadReports(employeeUserId); setSelectedReportId(body.report.id);
    } catch(error) {
      setError(saved ? "员工报告已保存，但列表刷新失败。请恢复连接并刷新页面查看，勿重复生成。"
        : error instanceof TypeError ? "员工报告请求连接中断，暂时无法确认是否已保存。请刷新列表核对，勿立即重复生成。" : error instanceof Error ? error.message : "员工报告操作失败，请刷新列表核对。");
    } finally { setBusy(false); }
  }
  const selected = reports.find((report) => report.id === selectedReportId) || null;
  let snapshot: EmployeeReportSnapshot | null = null; if (selected) { try { snapshot = JSON.parse(selected.snapshot_json) as EmployeeReportSnapshot; } catch { snapshot = null; } }
  const contentStatus: Record<string, string> = { draft: "草稿", internal_revision: "内部修改", internal_review: "内部审核", client_review: "客户审核", publish_ready: "待发布", published: "已发布", reviewed: "已复盘", archived: "已归档" };
  const analysisStatus: Record<string, string> = { completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消", pending: "等待中", queued: "排队中", processing: "处理中", analyzing: "分析中", transcribing: "转写中", extracting: "提取中", downloading: "下载中" };
  const outcomeLabel: Record<string, string> = { viral: "爆款", high: "高表现", regular: "常规", insufficient: "样本不足" };
  if (loading) return <div className="panel employee-report-loading">正在读取员工工作记录…</div>;
  return <>
    {error && <p className="employee-report-error" role="alert">{error}</p>}
    <PeriodicReportLayout key={`${employeeUserId}:${selected?.updated_at ?? ""}`} reports={reports} selectedId={selected?.id}
      canGenerate={canGenerate && Boolean(employeeUserId)} busy={busy} onGenerate={generate} onSelect={setSelectedReportId}
      tools={<label className="periodic-report-person">报告员工
        <select value={employeeUserId} disabled={busy || !employees.length} onChange={(event) => void selectEmployee(event.target.value)}>
          {employees.map(item => <option key={item.id} value={item.id}>{item.name}{item.email ? ` · ${item.email}` : ""}</option>)}
        </select>
      </label>}>
    <main className="panel report-document employee-report-document">{selected && snapshot ? <>
      <header><div><span>员工工作报告</span><h1>{selected.title}</h1><p>{snapshot.employee.name} · {selected.period_start} 至 {selected.period_end} · 生成于 {formatDate(selected.generated_at)}</p></div><div><button onClick={() => window.print()}>打印</button></div></header>
      <section className="report-summary employee-report-summary"><h2>本期工作摘要</h2><p>{snapshot.summaryText}</p></section>
      <div className="report-kpis employee-report-kpis"><Kpi label="完成视频分析" value={String(snapshot.summary.analysesCompleted)} note={snapshot.summary.analysesFailed ? `${snapshot.summary.analysesFailed} 个失败或取消` : `${snapshot.summary.analysesStarted} 个任务已发起`} /><Kpi label="主创内容" value={String(snapshot.summary.contentOwned)} note="按负责人归属" /><Kpi label="参与产出" value={String(snapshot.summary.versionsCreated)} note={`${snapshot.summary.reviewsCompleted} 次审核 · ${snapshot.summary.publishingActions} 次发布`} /><Kpi label="高表现 / 爆款" value={`${snapshot.summary.highPerformingWorks} / ${snapshot.summary.viralWorks}`} note={`${snapshot.summary.attributedPublishedWorks} 条作品已归因`} /></div>
      <section className="employee-outcomes"><header><div><span>结果归因</span><h2>已发布作品表现</h2></div><small>{snapshot.benchmark.cohortSize} 条同期可比作品</small></header>{snapshot.outcomes.length ? <div className="employee-outcome-table"><div className="heading"><span>作品</span><span>播放</span><span>互动率</span><span>结果</span></div>{snapshot.outcomes.map((item) => <a key={item.workId} href={item.videoId ? `/analysis/${item.videoId}` : undefined}><span><strong>{item.title}</strong><small>{item.publishedAt.slice(0, 10)} · {item.reason}</small></span><b>{formatNumber(item.views)}</b><b>{(item.engagementRate * 100).toFixed(2)}%</b><em className={item.label}>{outcomeLabel[item.label]}</em></a>)}</div> : <div className="employee-report-section-empty"><strong>还没有可归因的发布结果</strong><span>作品完成匹配后，系统才能把播放、互动和增粉回溯到对应主创。</span></div>}</section>
      <details className="employee-work-details"><summary>查看视频分析和内容生产明细</summary><div className="employee-work-grid">
        <section><header><div><Video aria-hidden="true" /><span><strong>视频分析</strong><small>{snapshot.details ? `展示最近 ${snapshot.details.analyses.shown} / 全部 ${snapshot.details.analyses.total} 个任务` : `${snapshot.analyses.length} 个任务`}</small></span></div></header>{snapshot.analyses.length ? <div>{snapshot.analyses.map((item) => item.videoId ? <a key={item.jobId} href={`/analysis/${item.videoId}`}><span><strong>{item.title}</strong><small>{formatDate(item.startedAt)}</small></span><em className={item.status}>{analysisStatus[item.status] || item.status}</em></a> : <article key={item.jobId}><span><strong>{item.title}</strong><small>{formatDate(item.startedAt)}</small></span><em className={item.status}>{analysisStatus[item.status] || item.status}</em></article>)}</div> : <p>本期没有发起视频分析。</p>}</section>
        <section><header><div><FileText aria-hidden="true" /><span><strong>内容生产</strong><small>{snapshot.details ? `展示最近 ${snapshot.details.content.shown} / 全部 ${snapshot.details.content.total} 个主创任务` : `${snapshot.content.length} 个主创任务`}</small></span></div></header>{snapshot.content.length ? <div>{snapshot.content.map((item) => <article key={item.contentItemId}><span><strong>{item.title}</strong><small>{item.versionsCreated ? `${item.versionsCreated} 个本期版本` : `创建于 ${formatDate(item.createdAt)}`}</small></span><em>{contentStatus[item.status] || item.status}</em></article>)}</div> : <p>本期没有归属到该员工的主创内容。</p>}</section>
      </div></details>
      <details className="employee-report-method"><summary>查看统计与爆款判定口径</summary><div><p>{snapshot.attribution.note}</p><p>{snapshot.benchmark.rule}</p>{snapshot.attribution.unmatchedPublishedWorks > 0 && <p>另有 {snapshot.attribution.unmatchedPublishedWorks} 条同期作品尚未匹配内容任务，因此没有归因给任何员工。</p>}</div></details>
    </> : <div className="report-empty"><UserRound aria-hidden="true" /><h2>暂无员工工作报告</h2><p>该员工已生成的报告会显示在这里。</p></div>}</main>
    </PeriodicReportLayout>
  </>;
}

function DiagnosticView({ diagnostics }: { diagnostics: Diagnostics }) {
  const statusLabel: Record<string, string> = { ready: "可用", watch: "需关注", insufficient: "样本不足", triggered: "已触发", not_triggered: "未触发" };
  const confidenceLabel: Record<string, string> = { high: "高", medium: "中", low: "低" };
  const evidence = diagnostics.evidence || [];
  if (!diagnostics.layers.length && !diagnostics.rules.length && !diagnostics.peerGroups.length && !evidence.length && !diagnostics.attributionNotice) return null;
  return <section className="report-diagnostics report-diagnostics-collapsed">
    <header><div><span>判断依据</span><h2>诊断与归因</h2></div><small>{diagnostics.attributionNotice}</small></header>
    <div className="diagnostic-status-strip">{diagnostics.layers.map((layer) => <span className={layer.status} key={layer.key}><strong>{layer.label}</strong><em>{statusLabel[layer.status] || layer.status}</em></span>)}</div>
    <details className="report-diagnostic-disclosure"><summary><span><strong>查看完整诊断</strong><small>{diagnostics.layers.length} 个诊断层级 · {diagnostics.rules.length} 条规则 · {evidence.length} 条关联证据</small></span><ChevronDown size={16} aria-hidden="true" /></summary><div className="report-diagnostic-content"><div className="diagnostic-layers">
      <div className="diagnostic-layer-head" aria-hidden="true"><span>诊断层级</span><span>可信度</span><span>判断依据</span><span>待补信息</span></div>
      {diagnostics.layers.map((layer) => <article className={`diagnostic-layer ${layer.status}`} key={layer.key}>
        <div className="diagnostic-layer-name"><strong>{layer.label}</strong><span>{statusLabel[layer.status] || layer.status}</span></div>
        <em>{confidenceLabel[layer.confidence] || layer.confidence}信心</em>
        <div className="diagnostic-layer-copy">{layer.evidence.map((item) => <p key={item}>{item}</p>)}</div>
        <small>{layer.missing.length > 0 ? layer.missing.map((item) => `待补：${item}`).join("；") : "暂无待补项"}</small>
      </article>)}
    </div>
    {(diagnostics.rules.length > 0 || evidence.length > 0 || diagnostics.peerGroups.length > 0) && <details className="diagnostic-detail-group"><summary><span><strong>归因规则与数据依据</strong><small>{diagnostics.rules.length} 条规则 · {evidence.length} 条证据 · {diagnostics.peerGroups.length} 个对照组</small></span><b>展开查看</b></summary><div className="diagnostic-detail-body">
      {diagnostics.rules.length > 0 && <div className="diagnostic-rules"><h3>组合规则</h3><div>{diagnostics.rules.map((rule) => <article className={rule.status} key={rule.code}><div><strong>{rule.label}</strong><span>{statusLabel[rule.status] || rule.status} · 最少 {rule.minimumSample} 条</span></div><p>{rule.evidence.join("；")}</p><small>{rule.uncertainty}</small></article>)}</div></div>}
      {evidence.length > 0 && <div className="diagnostic-evidence"><h3>关联证据</h3>{evidence.map((item) => <p key={item.contentItemId + ":" + item.sourceType + ":" + item.sourceId}><strong>{item.label}</strong><span>{item.quote || "已记录来源，未保存逐字摘录。"}{item.locator ? " · 定位 " + item.locator : ""}</span></p>)}</div>}
      {diagnostics.peerGroups.length > 0 && <div className="diagnostic-peers"><h3>同类对照</h3>{diagnostics.peerGroups.map((group) => <p key={group.key}><strong>{group.label}</strong><span>{group.sampleSize} 条样本 · 中位播放 {group.medianViews === null ? "—" : formatNumber(group.medianViews)} · 中位互动率 {group.medianEngagementRate === null ? "—" : (group.medianEngagementRate * 100).toFixed(2) + "%"}</span></p>)}</div>}
    </div></details>}</div></details>
  </section>;
}
