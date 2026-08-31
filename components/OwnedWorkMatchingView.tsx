"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { scopedFetch } from "../lib/client-scope";

type MatchCandidate = {
  id: string; platformWorkId: string | null; title: string; publishedAt: string | null; durationSec: number | null;
  sourceUrl: string | null; analysisId: string; analysisCreatedAt: string; confidence: number; method: string; reason: string;
};
type OwnedWork = {
  id: string; platformWorkId: string | null; title: string; publishedAt: string; genre: string | null; reviewStatus: string | null;
  matchStatus: string; matchConfidence: number | null; matchMethod: string | null; matchedAt: string | null;
  metrics: { views: number; likes: number; comments: number; shares: number; saves: number; homepageVisits: number; followerDelta: number };
  matchedVideo: MatchCandidate | null; candidates: MatchCandidate[];
};
type StartedAnalysis = { videoId: string; reused: boolean };
type MatchPayload = {
  works: OwnedWork[];
  summary: { total: number; confirmed: number; suggested: number; unmatched: number; analyzedVideos: number };
  canWrite: boolean;
};

async function readError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message || "请求没有完成，请稍后重试。";
}
function numberLabel(value: number) { return new Intl.NumberFormat("zh-CN", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function dateLabel(value: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value)) : "时间未知"; }

export function OwnedWorkMatchingView({ organizationId, projectId }: { organizationId: string; projectId: string }) {
  const [payload, setPayload] = useState<MatchPayload | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [analysisUrls, setAnalysisUrls] = useState<Record<string, string>>({});
  const [startedAnalyses, setStartedAnalyses] = useState<Record<string, StartedAnalysis>>({});
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!organizationId || !projectId) return;
    setLoading(true);
    try {
      const response = await scopedFetch("/api/performance/work-matches?organizationId=" + encodeURIComponent(organizationId) + "&projectId=" + encodeURIComponent(projectId));
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as MatchPayload; setPayload(body);
      setSelected(Object.fromEntries(body.works.filter((work) => !work.matchedVideo && work.candidates[0]).map((work) => [work.id, work.candidates[0].id])));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "作品匹配数据加载失败。"); }
    finally { setLoading(false); }
  }, [organizationId, projectId]);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  async function analyzeWork(work: OwnedWork) {
    const url = analysisUrls[work.id]?.trim() || "";
    if (!url) { setError("请先粘贴这条作品的抖音分享链接。"); return; }
    setBusy("analyze-" + work.id); setError("");
    try {
      const response = await scopedFetch("/api/videos/from-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, projectId, url, title: work.title, analysisProfile: "standard" }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { video: { id: string }; reused?: boolean };
      setStartedAnalyses((current) => ({ ...current, [work.id]: { videoId: body.video.id, reused: Boolean(body.reused) } }));
      setAnalysisUrls((current) => ({ ...current, [work.id]: "" }));
      if (body.reused) await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "这条作品没有开始分析。"); }
    finally { setBusy(""); }
  }
  async function confirm(workId: string, videoId: string | null) {
    setBusy(workId); setError("");
    try {
      const response = await scopedFetch("/api/performance/work-matches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, workId, videoId }) });
      if (!response.ok) throw new Error(await readError(response));
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "作品匹配没有保存。"); }
    finally { setBusy(""); }
  }

  const progress = useMemo(() => payload?.summary.total ? Math.round(payload.summary.confirmed / payload.summary.total * 100) : 0, [payload]);
  if (loading && !payload) return <div className="management-state" role="status">正在整理本企业空间已发布作品…</div>;
  return <div className="owned-match-page">
    {error && <div className="inline-alert" role="alert">{error}</div>}
    <section className="panel owned-match-flow">
      <header><div><p className="section-kicker">本企业空间 · 已发布作品</p><h2>把运营数据绑定到视频分析</h2></div><button type="button" onClick={() => void load()} disabled={loading}>{loading ? "刷新中…" : "刷新候选"}</button></header>
      <ol><li className="done"><span>1</span><strong>导入XLSX</strong></li><li><span>2</span><strong>分析已发布作品</strong></li><li><span>3</span><strong>人工确认</strong></li><li><span>4</span><strong>生成复盘</strong></li></ol>
      <div className="owned-match-progress"><i style={{ width: progress + "%" }} /><span>已确认 {payload?.summary.confirmed || 0} / {payload?.summary.total || 0} 条公开作品</span></div>
    </section>
    <div className="owned-match-summary">
      <article><span>公开作品</span><strong>{payload?.summary.total || 0}</strong></article>
      <article><span>已绑定分析</span><strong>{payload?.summary.confirmed || 0}</strong></article>
      <article><span>待确认候选</span><strong>{payload?.summary.suggested || 0}</strong></article>
      <article><span>尚无候选</span><strong>{payload?.summary.unmatched || 0}</strong></article>
    </div>
    <section className="panel owned-match-list">
      <header><div><h2>作品与分析匹配</h2><span>只展示公开作品；系统推荐不会自动生效，必须人工确认。</span></div><Link href={"/analysis?organizationId=" + encodeURIComponent(organizationId) + "&projectId=" + encodeURIComponent(projectId)}>前往视频分析 →</Link></header>
      {!payload?.works.length ? <div className="list-empty">请先在“导入”中上传抖音作品列表。</div> : payload.works.map((work) => {
        const choice = work.candidates.find((candidate) => candidate.id === selected[work.id]) || work.candidates[0];
        const interactions = work.metrics.likes + work.metrics.comments + work.metrics.shares + work.metrics.saves;
        return <article className="owned-match-row" key={work.id}>
          <div className="owned-work-copy"><div><span className="status neutral">{work.genre || "未分类"}</span><span>{dateLabel(work.publishedAt)}</span></div><strong>{work.title}</strong><small>播放 {numberLabel(work.metrics.views)} · 互动 {numberLabel(interactions)}{work.metrics.followerDelta ? " · 增粉 " + numberLabel(work.metrics.followerDelta) : ""}</small></div>
          {work.matchedVideo ? <div className="owned-match-confirmed"><span className="status success">已确认</span><div><strong>{work.matchedVideo.title}</strong><small>{work.matchConfidence ?? work.matchedVideo.confidence}% 匹配 · {work.matchedVideo.reason}</small></div><Link href={"/analysis/" + work.matchedVideo.id + "?organizationId=" + encodeURIComponent(organizationId) + "&projectId=" + encodeURIComponent(projectId)}>查看分析</Link>{payload.canWrite && <button type="button" disabled={busy === work.id} onClick={() => void confirm(work.id, null)}>解除</button>}</div> : work.candidates.length ? <div className="owned-match-candidates"><label>推荐分析<select value={selected[work.id] || work.candidates[0].id} onChange={(event) => setSelected((current) => ({ ...current, [work.id]: event.target.value }))}>{work.candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.confidence}% · {candidate.title}</option>)}</select></label>{choice && <small>{choice.reason} · 分析于 {dateLabel(choice.analysisCreatedAt)}</small>}{payload.canWrite && <button type="button" className="primary-button" disabled={busy === work.id || !choice} onClick={() => void confirm(work.id, choice?.id || null)}>{busy === work.id ? "保存中…" : "确认绑定"}</button>}</div> : <div className="owned-analyze-box">{startedAnalyses[work.id] ? <><div><span className="status neutral">{startedAnalyses[work.id].reused ? "已有分析" : "分析已启动"}</span><strong>{startedAnalyses[work.id].reused ? "系统正在刷新匹配候选" : "后台正在下载并分析这条作品"}</strong><small>完成后点击“刷新候选”，再由你人工确认绑定。</small></div><Link href={"/analysis?organizationId=" + encodeURIComponent(organizationId) + "&projectId=" + encodeURIComponent(projectId)}>查看进度</Link></> : <><label><span>粘贴这条作品的抖音链接</span><input value={analysisUrls[work.id] || ""} onChange={(event) => setAnalysisUrls((current) => ({ ...current, [work.id]: event.target.value }))} maxLength={2000} placeholder="https://v.douyin.com/..." /></label><button type="button" className="primary-button" disabled={busy === "analyze-" + work.id || !(analysisUrls[work.id] || "").trim()} onClick={() => void analyzeWork(work)}>{busy === "analyze-" + work.id ? "正在启动…" : "开始分析"}</button><small>优先读取本机已登录的 Edge 抖音账号；读取失败时才需要 Cookie 文件。</small></>}</div>}
        </article>;
      })}
    </section>
  </div>;
}
