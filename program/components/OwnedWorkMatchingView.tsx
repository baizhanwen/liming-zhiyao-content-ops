"use client";
import { readApiError as readError, formatClientDate } from "../lib/client-format";


import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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


function numberLabel(value: number) { return new Intl.NumberFormat("zh-CN", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
const dateLabel = (value: string | null) => formatClientDate(value, "fullDate", "时间未知");

export function OwnedWorkMatchingView({ organizationId, projectId }: { organizationId: string; projectId: string }) {
  const [filter, setFilter] = useState("all");
  const [payload, setPayload] = useState<MatchPayload | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [analysisUrls, setAnalysisUrls] = useState<Record<string, string>>({});
  const [startedAnalyses, setStartedAnalyses] = useState<Record<string, StartedAnalysis>>({});
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!organizationId || !projectId) return;
    setLoading(true); setError("");
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

  if (loading && !payload) return <div className="management-state" role="status">正在读取作品匹配…</div>;
  const scope = new URLSearchParams({ organizationId, projectId });
  const works = (payload?.works ?? []).filter(work => {
    if (filter === "all") return true;
    const state = work.matchedVideo ? "confirmed" : work.candidates.length ? "suggested" : "unmatched";
    return state === filter;
  });
  return <div className="owned-match-page">
    {error && <div className="inline-alert" role="alert">{error}</div>}
    <section className="panel owned-match-list">
      <header className="match-list-head">
        <div><h2>已发布作品</h2>{!!payload?.works.length && <span>已确认 {payload.summary.confirmed} / {payload.summary.total} 条 · 候选需人工确认</span>}</div>
        <div className="match-list-actions">
          {!!payload?.works.length && <select aria-label="匹配状态" value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="all">全部作品（{payload.summary.total}）</option>
            <option value="suggested">待确认（{payload.summary.suggested}）</option>
            <option value="unmatched">暂无候选（{payload.summary.unmatched}）</option>
            <option value="confirmed">已确认（{payload.summary.confirmed}）</option>
          </select>}
          <button type="button" onClick={() => void load()} disabled={loading || !!busy}>{loading ? "刷新中…" : "刷新候选"}</button>
        </div>
      </header>
      {payload && !payload.works.length ? <div className="overview-empty">
        <h3>还没有可匹配的公开作品</h3>
        <p>导入抖音作品表后，可在这里关联已有的视频分析。</p>
        {payload.canWrite && <Link className="primary-button" href={`/insights?view=imports&${scope}`}>导入作品数据</Link>}
      </div> : payload && !works.length ? <p className="list-empty">当前筛选下没有作品。</p> : works.map(work => {
        const choice = work.candidates.find((candidate) => candidate.id === selected[work.id]) || work.candidates[0];
        const interactions = work.metrics.likes + work.metrics.comments + work.metrics.shares + work.metrics.saves;
        return <article className="owned-match-row" key={work.id}>
          <div className="owned-work-copy"><div><span className="status neutral">{work.genre || "未分类"}</span><span>{dateLabel(work.publishedAt)}</span></div><strong>{work.title}</strong><small>播放 {numberLabel(work.metrics.views)} · 互动 {numberLabel(interactions)}{work.metrics.followerDelta ? " · 增粉 " + numberLabel(work.metrics.followerDelta) : ""}</small></div>
          {work.matchedVideo ? <div className="owned-match-confirmed"><span className="status success">已确认</span><div><strong>{work.matchedVideo.title}</strong><small>{work.matchConfidence ?? work.matchedVideo.confidence}% 匹配 · {work.matchedVideo.reason}</small></div><Link href={"/analysis/" + work.matchedVideo.id + "?organizationId=" + encodeURIComponent(organizationId) + "&projectId=" + encodeURIComponent(projectId)}>查看分析</Link>{payload?.canWrite && <button type="button" disabled={busy === work.id} onClick={() => void confirm(work.id, null)}>解除</button>}</div> : work.candidates.length ? <div className="owned-match-candidates"><label>推荐分析<select value={selected[work.id] || work.candidates[0].id} onChange={(event) => setSelected((current) => ({ ...current, [work.id]: event.target.value }))}>{work.candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.confidence}% · {candidate.title}</option>)}</select></label>{choice && <small>{choice.reason} · 分析于 {dateLabel(choice.analysisCreatedAt)}</small>}{payload?.canWrite && <button type="button" className="primary-button" disabled={busy === work.id || !choice} onClick={() => void confirm(work.id, choice?.id || null)}>{busy === work.id ? "保存中…" : "确认绑定"}</button>}</div> : !payload?.canWrite ? <span className="owned-match-readonly">暂无匹配候选</span> : <div className="owned-analyze-box">{startedAnalyses[work.id] ? <><div><span className="status neutral">{startedAnalyses[work.id].reused ? "已有分析" : "分析已启动"}</span><strong>{startedAnalyses[work.id].reused ? "系统正在刷新匹配候选" : "后台正在下载并分析这条作品"}</strong><small>完成后点击“刷新候选”，再由你人工确认绑定。</small></div><Link href={"/analysis?organizationId=" + encodeURIComponent(organizationId) + "&projectId=" + encodeURIComponent(projectId)}>查看进度</Link></> : <><label><span>粘贴这条作品的抖音链接</span><input value={analysisUrls[work.id] || ""} onChange={(event) => setAnalysisUrls((current) => ({ ...current, [work.id]: event.target.value }))} maxLength={2000} placeholder="https://v.douyin.com/..." /></label><button type="button" className="primary-button" disabled={busy === "analyze-" + work.id || !(analysisUrls[work.id] || "").trim()} onClick={() => void analyzeWork(work)}>{busy === "analyze-" + work.id ? "正在启动…" : "开始分析"}</button></>}</div>}
        </article>;
      })}
      {!!payload?.works.length && <footer className="match-list-footer">
        <Link href={`/analysis?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`}>前往视频分析 →</Link>
      </footer>}
    </section>
  </div>;
}
