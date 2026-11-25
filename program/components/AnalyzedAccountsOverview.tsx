"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ChartScatter, ChevronRight, ImageOff, UserRoundSearch } from "lucide-react";
import type { AnalyzedAccountsData, AnalyzedWork } from "../lib/analyzed-accounts";
import { formatClientDate, readApiError } from "../lib/client-format";
import { scopedFetch } from "../lib/client-scope";
import { useVideoCover } from "./VideoPlatformMetadata";
import { AccountWorkScatter } from "./AccountWorkScatter";
import "./analyzed-accounts-overview.css";

const metrics = { plays: "播放", likes: "点赞", comments: "评论", favorites: "收藏", shares: "分享" } as const;
const metricKeys = Object.keys(metrics) as (keyof typeof metrics)[];
const sortLabels = { publishedAt: "发布时间", plays: "播放量", likes: "点赞数" } as const;
type SortKey = keyof typeof sortLabels;
const counts = new Intl.NumberFormat("zh-CN");

function sortedWorks(works: AnalyzedWork[], sort: SortKey) {
  function value(work: AnalyzedWork) {
    return sort === "publishedAt" ? Date.parse(work.publishedAt ?? "") : work[sort];
  }
  return [...works].sort((a, b) => {
    const first = value(a), second = value(b);
    const firstKnown = typeof first === "number" && Number.isFinite(first);
    const secondKnown = typeof second === "number" && Number.isFinite(second);
    if (firstKnown && secondKnown && first !== second) return second - first;
    if (firstKnown !== secondKnown) return firstKnown ? -1 : 1;
    return b.analyzedAt.localeCompare(a.analyzedAt) || a.videoId.localeCompare(b.videoId);
  });
}

function WorkCover({ work }: { work: AnalyzedWork }) {
  const { cover, onError } = useVideoCover({ cover_url: work.coverUrl, cover_source: work.coverSource });
  return <span className="analyzed-work-cover">
    {/* eslint-disable-next-line @next/next/no-img-element -- Cover assets require the workspace browser session. */}
    {cover ? <img src={cover.url} alt="" title={cover.label} loading="lazy" onError={onError} /> : <ImageOff aria-hidden="true" />}
  </span>;
}

type Result = { request: string; data?: AnalyzedAccountsData; error?: string };
type Notice = { failed: boolean; text: string; accountKey?: string };

export function AnalyzedAccountsOverview({ organizationId, projectId }: { organizationId: string; projectId: string }) {
  const params = useSearchParams();
  const scope = new URLSearchParams({ organizationId, projectId }).toString();
  const sameScope = (!params.get("organizationId") || params.get("organizationId") === organizationId) &&
    (!params.get("projectId") || params.get("projectId") === projectId);
  const selectedKey = sameScope ? params.get("account") : null;
  const order = params.get("sort");
  const sort: SortKey = order === "plays" || order === "likes" ? order : "publishedAt";
  const [revision, setRevision] = useState(0);
  const request = scope + ":" + revision;
  const [result, setResult] = useState<Result | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [identifying, setIdentifying] = useState("");
  const compareWorks = sameScope && params.get("compare") === "1";
  const identification = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await scopedFetch("/api/analytics/accounts?" + scope, { signal: controller.signal });
        if (!response.ok) throw new Error(await readApiError(response));
        const data = await response.json() as AnalyzedAccountsData;
        if (!controller.signal.aborted) setResult({ request, data });
      } catch (reason) {
        if (!controller.signal.aborted) setResult({ request, error: reason instanceof Error ? reason.message : "账号列表读取失败。" });
      }
    }
    void load();
    return () => controller.abort();
  }, [request, scope]);

  useEffect(() => () => identification.current?.abort(), [scope]);

  function overviewHref(account?: string, sortBy?: SortKey) {
    const query = new URLSearchParams(scope);
    query.set("view", "overview");
    if (account) query.set("account", account);
    if (sortBy && sortBy !== "publishedAt") query.set("sort", sortBy);
    if (account && account === selectedKey) {
      for (const key of ["xAxis", "yAxis"]) {
        const value = params.get(key);
        if (value) query.set(key, value);
      }
    }
    return "/insights?" + query;
  }

  function toggleComparison() {
    const url = new URL(window.location.href);
    url.searchParams.delete("account");
    url.searchParams.delete("sort");
    if (!sameScope) {
      url.searchParams.delete("xAxis");
      url.searchParams.delete("yAxis");
    }
    url.searchParams.set("organizationId", organizationId);
    url.searchParams.set("projectId", projectId);
    if (compareWorks) url.searchParams.delete("compare");
    else url.searchParams.set("compare", "1");
    window.history.replaceState(window.history.state, "", url);
  }

  async function identify(work: AnalyzedWork) {
    if (identification.current) return;
    const controller = new AbortController();
    identification.current = controller;
    setIdentifying(work.videoId);
    setNotice(null);
    try {
      const response = await scopedFetch("/api/videos/" + encodeURIComponent(work.videoId) + "/author", {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ organizationId, projectId }),
      });
      if (!response.ok) throw new Error(await readApiError(response, "未能识别账号。"));
      const { accountKey, authorName } = await response.json() as { accountKey?: string; authorName?: string | null };
      if (!controller.signal.aborted) {
        setNotice({ failed: false, text: authorName ? `已归入「${authorName}」。` : "已识别并归入对应账号。", accountKey });
        setRevision(n => n + 1);
      }
    } catch (reason) {
      if (!controller.signal.aborted) setNotice({ failed: true, text: reason instanceof Error ? reason.message : "识别请求未完成，请刷新后查看结果。" });
    } finally {
      if (!controller.signal.aborted) setIdentifying("");
      identification.current = null;
    }
  }

  if (result?.request !== request) return <p className="management-state" role="status">正在读取已分析的作品…</p>;
  const data = result.data;
  if (!data) return <div className="analyzed-accounts-feedback" role="alert">
    {result.error}<button type="button" className="secondary-button" onClick={() => setRevision(n => n + 1)}>重新读取</button>
  </div>;
  const pending = selectedKey === "unidentified";
  const account = data.accounts.find(item => item.accountKey === selectedKey);
  if (selectedKey) return <section className="panel analyzed-accounts" aria-label="账号作品">
    <header className="analyzed-accounts-head">
      <div>
        <Link href={overviewHref()} className="analyzed-back"><ArrowLeft size={14} aria-hidden="true" />全部账号</Link>
        <h2>{pending ? "待识别作品" : account?.name || "账号作品"}</h2>
        {account && <p>已分析 {counts.format(account.workCount)} 条作品</p>}
      </div>
    </header>
    {pending && notice && <p className={`analyzed-status${notice.failed ? " failed" : ""}`} role={notice.failed ? "alert" : "status"}>
      {notice.text}{notice.accountKey && <Link href={overviewHref(notice.accountKey)}>查看账号</Link>}
    </p>}
    {!account ? <p className="analyzed-empty">{pending ? "当前没有待识别作品。" : "当前空间没有这个账号的已分析作品。"}</p> : <>
      {!pending && <AccountWorkScatter key={account.accountKey} accounts={[account]} scope={scope} />}
      {pending && data.canWrite && account.works.some(work => work.canIdentify) &&
        <p className="analyzed-lookup-note">识别账号会查询这条作品的 TikHub 详情，可能产生一次接口用量。</p>}
      <div className="analyzed-work-list-head">
        <h3>作品列表</h3>
        <div className="analyzed-sort" role="group" aria-label="作品排序">
          {(Object.keys(sortLabels) as SortKey[]).map(key => <Link key={key} href={overviewHref(selectedKey, key)} replace scroll={false}
            aria-current={key === sort ? "true" : undefined}>{sortLabels[key]}</Link>)}
        </div>
      </div>
      <ul className="analyzed-works">{sortedWorks(account.works, sort).map(work => <li key={work.videoId}>
        <Link href={`/analysis/${encodeURIComponent(work.videoId)}?${scope}`} className="analyzed-work-link">
          <WorkCover work={work} /><span><strong>{work.title}</strong>
            <small>{work.publishedAt ? `发布于 ${formatClientDate(work.publishedAt, "fullDate")}` : "发布时间未获取"}</small>
          </span>
        </Link>
        <div className="analyzed-work-stats">
          <dl>{metricKeys.map(key => <div key={key}><dt>{metrics[key]}</dt><dd>{work[key] == null
            ? <><span className="analyzed-missing" title="未获取" aria-hidden="true">—</span><span className="sr-only">未获取</span></> : counts.format(work[key])}</dd></div>)}</dl>
          <small>{work.collectedAt ? `采集于 ${formatClientDate(work.collectedAt)}` : "暂无采集记录"}</small>
        </div>
        {pending && data.canWrite && work.canIdentify && <button type="button" className="secondary-button analyzed-identify" disabled={Boolean(identifying)}
          onClick={() => void identify(work)}>{identifying === work.videoId ? "识别中…" : "识别账号"}</button>}
      </li>)}</ul>
    </>}
  </section>;

  const knownAccounts = data.accounts.filter(item => item.accountKey !== "unidentified");
  const names = new Set<string>(), duplicateNames = new Set<string>();
  for (const item of data.accounts) {
    if (names.has(item.name)) duplicateNames.add(item.name);
    names.add(item.name);
  }
  return <section className="panel analyzed-accounts" aria-labelledby="analyzed-accounts-title">
    <header className="analyzed-accounts-head"><div><h2 id="analyzed-accounts-title">已分析的抖音账号</h2>
      <p>{knownAccounts.length} 个账号 · {counts.format(data.accounts.reduce((total, item) => total + item.workCount, 0))} 条作品</p></div>
      {knownAccounts.length > 0 && <button type="button" className="secondary-button analyzed-compare" aria-expanded={compareWorks}
        onClick={toggleComparison}><ChartScatter size={16} aria-hidden="true" />{compareWorks ? "收起对比" : "对比作品"}</button>}
    </header>
    {compareWorks && knownAccounts.length > 0 && <AccountWorkScatter accounts={knownAccounts} scope={scope} showAuthors />}
    {data.accounts.length ? <ul className="analyzed-account-list">{data.accounts.map(item => {
      const unknown = item.accountKey === "unidentified";
      return <li key={item.accountKey}><Link href={overviewHref(item.accountKey)}>
        <span className={`analyzed-account-avatar${unknown ? " pending" : ""}`} aria-hidden="true">
          {unknown ? <UserRoundSearch size={19} /> : Array.from(item.name)[0]}
        </span>
        <span className="analyzed-account-label"><strong>{unknown ? "待识别作品" : item.name}</strong>
          <small>最近分析 {formatClientDate(item.lastAnalyzedAt)}{duplicateNames.has(item.name) && !unknown ? ` · 标识末六位 ${item.accountKey.slice(-6)}` : ""}</small>
        </span>
        <span className="analyzed-count">{counts.format(item.workCount)} 条作品</span><ChevronRight aria-hidden="true" size={16} />
      </Link></li>;
    })}</ul> : <div className="analyzed-empty"><p>当前空间还没有已分析的抖音作品。</p><Link href={`/analysis?${scope}`}>去视频分析</Link></div>}
  </section>;
}
