"use client";

import Link from "next/link";
import { useEffect, useState, useContext } from "react";
import { NavigationScope } from "./AppShell";
import { readApiError } from "../lib/client-format";
import { structureDraftHref } from "../lib/studio-links";
import "./reference-video-picker.css";

type Video = {
  videoId: string; analysisId: string; title: string; author: string | null;
  analyzedAt: string; libraryEntryId: string | null; segmentCount: number; unavailableReason: string | null;
};
type Scope = { organizationId: string; projectId: string };
type Props = { requested: Scope; ideaKind?: "card" | "topic"; ideaId?: string };

export function ReferenceVideoPicker({ requested, ideaKind, ideaId }: Props) {
  const active = useContext(NavigationScope);
  const scope = {
    organizationId: requested.organizationId || active.organizationId,
    projectId: requested.projectId || active.projectId,
  };
  return <Picker key={JSON.stringify(scope)} {...scope} ideaId={ideaId} ideaKind={ideaKind} />;
}

function Picker({ organizationId, projectId, ideaId, ideaKind }: Scope & Omit<Props, "requested">) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [canWrite, setCanWrite] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!organizationId || !projectId) return;
    const controller = new AbortController();
    async function read() {
      try {
        setLoading(true);
        setError("");
        const params = new URLSearchParams({ organizationId, projectId, search: query, page: String(page) });
        const response = await fetch("/api/studio/references?" + params, { signal: controller.signal });
        if (!response.ok) throw new Error(await readApiError(response));
        const data: { videos: Video[]; canWrite: boolean; hasNext: boolean } = await response.json();
        if (controller.signal.aborted) return;
        setVideos(data.videos);
        setCanWrite(data.canWrite);
        setHasNext(data.hasNext);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取参考视频失败。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void read();
    return () => controller.abort();
  }, [organizationId, projectId, query, page, reload]);

  const available = videos.filter(video => !video.unavailableReason);
  const unavailable = videos.filter(video => video.unavailableReason);
  const scope = { organizationId, projectId };
  const analysisUrl = "/analysis?" + new URLSearchParams(scope);
  function changePage(next: number) {
    setLoading(true);
    setPage(next);
  }
  return <section className="panel reference-video-picker">
    <h2>选择参考视频</h2>
    {organizationId && projectId && <form className="reference-video-search" onSubmit={event => {
      event.preventDefault(); setPage(1); setQuery(search.trim());
    }}>
      <label>搜索参考视频<input type="search" maxLength={200} placeholder="视频标题或作者" value={search}
        onChange={event => { setSearch(event.target.value); if (!event.target.value) { setQuery(""); setPage(1); } }} /></label>
      <button type="submit">搜索</button>
    </form>}
    {!organizationId || !projectId ? <p role="status">请选择企业空间。 <Link href="/space">打开空间</Link></p>
      : loading ? <p role="status">正在读取已分析的视频…</p>
      : error ? <p role="alert">{error} <button type="button" onClick={() => setReload(n => n + 1)}>重新读取</button></p>
      : !canWrite ? <p>当前账号只有查看权限。</p>
      : <>{available.length > 0 && <ul>{available.map(video => <li key={video.videoId}>
          <Link href={structureDraftHref({ ...scope, videoId: video.videoId, analysisId: video.analysisId,
            libraryEntryId: video.libraryEntryId ?? undefined, ...(ideaKind && ideaId ? { ideaKind, ideaId } : {}) })}>
            <span><strong>{video.title}</strong><small>{video.author && video.author + " · "}{video.segmentCount} 个结构段 · {new Date(video.analyzedAt).toLocaleDateString("zh-CN")}</small></span>
            <span aria-hidden="true">→</span>
          </Link></li>)}</ul>}
        {!videos.length && <p>{query ? "没有找到匹配的视频。" : "这个空间还没有已分析的参考视频。"} <Link href={analysisUrl}>去分析视频</Link></p>}
        {!available.length && unavailable.length > 0 && <p>这批视频的最新分析还缺少完整结构。可以核对报告或 <Link href={analysisUrl}>去分析其他视频</Link>。</p>}
        {unavailable.length > 0 && <details className="reference-video-pending"><summary>{unavailable.length} 条待补全结构的视频</summary><ul>{unavailable.map(video => {
          const params = new URLSearchParams({ ...scope, analysisId: video.analysisId });
          if (video.libraryEntryId) params.set("libraryEntryId", video.libraryEntryId);
          return <li key={video.videoId}><Link href={`/analysis/${encodeURIComponent(video.videoId)}?${params}`}>
            <span><strong>{video.title}</strong><small>{video.unavailableReason}</small></span><span>查看分析</span></Link></li>;
        })}</ul></details>}
        {(page > 1 || hasNext) && <nav className="reference-video-pages" aria-label="参考视频分页">
          <button type="button" disabled={page === 1} onClick={() => changePage(page - 1)}>上一页</button>
          <span>第 {page} 页</span>
          <button type="button" disabled={!hasNext} onClick={() => changePage(page + 1)}>下一页</button>
        </nav>}</>}
  </section>;
}
