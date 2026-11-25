"use client";

import { useMemo, useRef, useState } from "react";
import { analyzeVideoComments } from "../lib/video-comment-insights";
import type { PlatformComments } from "../lib/video-platform-comments";

export type VideoCoverSource = "platform" | "keyframe" | null;
const coverSourceLabels = { platform: "平台原封面", keyframe: "视频截图" };

export type VideoPlatformInfo = {
  platform?: string;
  source_url?: string | null;
  created_at?: string | null;
  platform_title?: string | null;
  platform_description?: string | null;
  platform_work_id?: string | null;
  author_name?: string | null;
  published_at?: string | null;
  published_at_source?: string | null;
  duration_sec?: number | null;
  cover_url?: string | null;
  cover_source?: VideoCoverSource;
  fallback_cover_url?: string | null;
  metadata_status?: "available" | "partial" | "failed" | "refreshing" | null;
  metadata_message?: string | null;
  metadata_attempted_at?: string | null;
  metadata_collected_at?: string | null;
  title?: string | null;
};

const metricLabels = {
  plays: "播放", likes: "点赞", comments: "评论", favorites: "收藏", shares: "分享",
} as const;
export type VideoMetricSnapshot = Partial<Record<keyof typeof metricLabels, number | null>> & {
  collected_at: string | null;
  source: string;
};
const metricKeys = Object.keys(metricLabels) as Array<keyof typeof metricLabels>;
const metricSources: Record<string, string> = { tikhub: "TikHub", public: "平台公开数据", client_backend: "创作者后台", manual: "手动录入" };
const counts = new Intl.NumberFormat("zh-CN");
const timestamps = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function observedTime(value?: string | null) {
  if (!value) return "未获取";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? <time dateTime={value}>{timestamps.format(date)}</time> : "未获取";
}

function metricValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? counts.format(value) : "未获取";
}

export function resolveVideoCover(video: VideoPlatformInfo, failed: string[] = [], frame = video.fallback_cover_url) {
  if (video.cover_url && !failed.includes(video.cover_url)) {
    return { url: video.cover_url, label: video.cover_source ? coverSourceLabels[video.cover_source] : "视频封面" };
  }
  return frame && !failed.includes(frame) ? { url: frame, label: coverSourceLabels.keyframe } : null;
}

export function useVideoCover(video: VideoPlatformInfo | undefined, frame?: string) {
  const [failed, setFailed] = useState<string[]>([]);
  const cover = video ? resolveVideoCover(video, failed, frame) : null;
  return {
    cover, failed: failed.length > 0,
    onError: () => { if (cover) setFailed(current => current.includes(cover.url) ? current : [...current, cover.url]); },
    retry: () => setFailed([]),
  };
}

export function VideoListCover({ video }: { video: VideoPlatformInfo & { source_type: string } }) {
  const { cover, onError } = useVideoCover(video);
  if (!cover) return <span className={`media-kind ${video.source_type}`}>{video.source_type === "url" ? "链" : "媒"}</span>;
  // eslint-disable-next-line @next/next/no-img-element -- Scoped media routes require the browser session.
  return <img className="analysis-record-cover" src={cover.url} alt={cover.label} title={cover.label} loading="lazy" onError={onError} />;
}

function SourceCover({ cover, failed, onError }: ReturnType<typeof useVideoCover>) {
  if (!cover) return <p className="platform-cover-empty">{failed ? "封面暂时无法读取" : "暂无封面"}</p>;
  const { url, label } = cover;
  return <a className="platform-cover-preview" href={url} target="_blank" rel="noopener noreferrer" aria-label={`查看${label}大图（在新标签页打开）`}>
    {/* eslint-disable-next-line @next/next/no-img-element -- The original cover and frame are served by authenticated asset routes. */}
    <img src={url} alt={label} onError={onError} />
    <span>{label}</span>
  </a>;
}

function CommentInsights({ sample, onShow }: { sample: PlatformComments; onShow: (rank: number) => void }) {
  const { topics, questionRanks, topLikedRanks, textCount } = useMemo(() => analyzeVideoComments(sample.comments), [sample.comments]);
  function sources(ranks: number[]) {
    return ranks.map(rank => <button key={rank} type="button" aria-label={`查看第 ${rank} 条原评论`} onClick={() => onShow(rank)}>#{rank}</button>);
  }
  function excerpt(rank: number) {
    const row = sample.comments[rank - 1];
    const chars = Array.from(row.text.trim().replace(/\s+/gu, " "));
    if (!chars.length) return row.has_image ? "图片评论" : "原文未提供";
    return `“${chars.slice(0, 46).join("")}${chars.length > 46 ? "…" : ""}”`;
  }

  return <section className="platform-comment-insights" aria-label="评论简析">
    <header><h3>评论简析</h3><small>{sample.status === "failed" ? "上次" : "本次"}采集 {sample.comments.length} 条</small></header>
    {textCount > 0 ? <>
      <h4>反复提及</h4>
      {topics.length ? topics.map(({ term, ranks }) => <div className="comment-evidence" key={term}>
        <strong>{term}</strong><small>{ranks.length} 条</small>{sources(ranks)}
      </div>) : <p>未提取到重复关键词。</p>}
      <h4>评论里的提问</h4>
      {questionRanks.length ? <><p>{excerpt(questionRanks[0])}</p><div className="comment-evidence"><small>{questionRanks.length} 条</small>{sources(questionRanks)}</div></> : <p>未识别到明确提问。</p>}
    </> : <p>这组评论缺少可分析的文字。</p>}
    {topLikedRanks.length > 0 && <>
      <h4>样本内最高赞</h4>
      <p>{excerpt(topLikedRanks[0])}</p>
      <div className="comment-evidence"><strong>{metricValue(sample.comments[topLikedRanks[0] - 1].like_count)} 赞</strong>{topLikedRanks.length > 1 && <small>并列</small>}{sources(topLikedRanks)}</div>
    </>}
  </section>;
}

function SourceComments({ sample, busy }: { sample: PlatformComments; busy: boolean }) {
  const originals = useRef<HTMLOListElement>(null);
  function showComment(rank: number) {
    const target = originals.current?.children.item(rank - 1);
    if (!(target instanceof HTMLElement)) return;
    target.focus({ preventScroll: true });
    const pane = target.closest<HTMLElement>(".workspace-split[data-independent-scroll] > .report-source-column");
    if (pane) {
      const top = Math.max(pane.getBoundingClientRect().top, pane.closest(".shell-paper")?.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0);
      pane.scrollTop += target.getBoundingClientRect().top - top - 8;
    } else {
      target.scrollIntoView({ block: "center" });
    }
  }
  const hasSample = Boolean(sample.collected_at);
  const failed = sample.status === "failed";
  const count = sample.comments.length;
  let summary = `${count} 条`;
  if (busy) summary = "正在更新";
  else if (failed) summary = hasSample ? "更新失败 · 上次 " + count + " 条" : "采集失败";
  else if (sample.status === "not_collected") summary = "待采集";

  return <details className="platform-comments">
    <summary>一级评论 <span>{summary}</span></summary>
    <p className="platform-sampled-at">TikHub · 抖音 Web · 按接口顺序取前 10 条</p>
    {hasSample && <p className="platform-sampled-at">采集于 {observedTime(sample.collected_at)}</p>}
    {failed && <p className="platform-fetch-note" role="status">{sample.error || "本次未能取得评论。"}</p>}
    {count > 0 && <><CommentInsights sample={sample} onShow={showComment} />
    <ol aria-label="原评论" ref={originals}>
      {sample.comments.map(row => <li key={row.comment_id} tabIndex={-1}>
        <p className="platform-comment-text">{row.text || (row.has_image ? "图片评论" : "原文未提供")}</p>
        <div className="platform-comment-meta">
          {row.text && row.has_image && <span>含图片</span>}
          {row.like_count != null && <span>{counts.format(row.like_count)} 赞</span>}
          {row.reply_count != null && <span>{counts.format(row.reply_count)} 回复</span>}
          {row.published_at && observedTime(row.published_at)}
        </div>
      </li>)}
    </ol></>}
    {count === 0 && sample.status === "available" && <p className="platform-sampled-at">本次未返回可展示的一级评论。</p>}
  </details>;
}

export function VideoPlatformMetadata({ video, snapshots, platformComments, coverState, busy, disabled, onRefresh }: {
  video: VideoPlatformInfo;
  snapshots: VideoMetricSnapshot[];
  platformComments?: PlatformComments | null;
  coverState: ReturnType<typeof useVideoCover>;
  busy: boolean;
  disabled: boolean;
  onRefresh?: () => void;
}) {
  const snapshot = snapshots[0];
  const hasProblem = video.metadata_status === "partial" || video.metadata_status === "failed";
  return <section className="report-platform-data" id="report-platform-data" aria-label="作品数据">
    <header><h2>作品数据</h2>{video.metadata_status && video.metadata_status !== "refreshing" && <span className={`platform-fetch-state ${video.metadata_status}`}>{{ available: "已获取", partial: "部分获取", failed: "采集失败" }[video.metadata_status]}</span>}
      {onRefresh && <button type="button" className="secondary-button" onClick={onRefresh} disabled={disabled} title="更新作品资料、封面、互动数据和一级评论">{busy ? "正在采集…" : "更新作品数据"}</button>}</header>
    <div className="platform-source-info">
      <SourceCover {...coverState} />
      <dl>
        <div><dt>作者</dt><dd>{video.author_name || "未获取"}</dd></div>
        <div><dt>发布时间</dt><dd>{observedTime(video.published_at)}</dd></div>
        {video.published_at && <div><dt>时间来源</dt><dd>{video.published_at_source === "tikhub" ? "TikHub" : "未记录"}</dd></div>}
        {video.duration_sec != null && <div><dt>视频时长</dt><dd>{counts.format(video.duration_sec)} 秒</dd></div>}
        {video.platform_work_id && <div><dt>作品 ID</dt><dd>{video.platform_work_id}</dd></div>}
      </dl>
    </div>
    {video.platform === "douyin" && video.source_url && <a className="platform-source-link" href={video.source_url} target="_blank" rel="noopener noreferrer">在抖音查看作品 ↗</a>}
    {video.platform_title && video.platform_title !== video.title && <p className="platform-source-title">{video.platform_title}</p>}
    {video.platform_description && video.platform_description !== (video.platform_title || video.title) && <details className="platform-description"><summary>作品描述</summary><p>{video.platform_description}</p></details>}
    {snapshot ? <>
      <dl className="platform-metric-values">{metricKeys.map(key => <div key={key}><dt>{metricLabels[key]}</dt><dd>{metricValue(snapshot[key])}</dd></div>)}</dl>
      <p className="platform-sampled-at">指标采集于 {observedTime(snapshot.collected_at)} · {metricSources[snapshot.source] || "来源未记录"}</p>
    </> : <p className="platform-sampled-at">暂无互动数据快照</p>}
    {video.metadata_collected_at && snapshot?.collected_at !== video.metadata_collected_at && <p className="platform-sampled-at">作品资料采集于 {observedTime(video.metadata_collected_at)} · TikHub</p>}
    {hasProblem && <p className="platform-fetch-note" role="status">{video.metadata_message || (video.metadata_status === "failed" ? "最近一次采集失败" : "部分数据未获取")}{video.metadata_attempted_at && <>（{observedTime(video.metadata_attempted_at)}）</>}</p>}
    {snapshots.length > 1 && <details className="platform-snapshot-history">
      <summary>最近 {snapshots.length} 次指标采集</summary>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Allows keyboard users to scroll the table horizontally in narrow layouts. */}
      <div tabIndex={0} role="region" aria-label="指标采集历史表格">
        <table><thead><tr><th scope="col">采集时间</th><th scope="col">来源</th>{metricKeys.map(key => <th scope="col" key={key}>{metricLabels[key]}</th>)}</tr></thead>
          <tbody>{snapshots.map((row, index) => <tr key={`${row.collected_at}:${index}`}><td>{observedTime(row.collected_at)}</td><td>{metricSources[row.source] || "未记录"}</td>{metricKeys.map(key => <td key={key}>{metricValue(row[key])}</td>)}</tr>)}</tbody></table>
      </div>
    </details>}
    {platformComments && <SourceComments sample={platformComments} busy={busy} />}
  </section>;
}
