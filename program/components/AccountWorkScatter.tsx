"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeftRight } from "lucide-react";
import type { EChartsCoreOption } from "echarts/core";
import type { AnalyzedAccount, AnalyzedWork } from "../lib/analyzed-accounts";
import { formatClientDate } from "../lib/client-format";
import { EChart } from "./EChart";

const axes = {
  publishedAt: "发布时间", durationSec: "视频时长（秒）", cutCount: "镜头切换次数", transcriptChars: "转写字数",
  plays: "播放量", likes: "点赞数", comments: "评论数", favorites: "收藏数", shares: "分享数",
  likeRate: "点赞率", favoriteRate: "收藏率", engagementRate: "互动率",
} as const;
type Axis = keyof typeof axes;
type Axes = { x: Axis; y: Axis };
type WorkEntry = { work: AnalyzedWork; author: string };
type Point = WorkEntry & { x: number; y: number };
const performanceAxes: Axes = { x: "publishedAt", y: "plays" };
const editingAxes: Axes = { x: "durationSec", y: "cutCount" };
const snapshotAxes = new Set<Axis>(["plays", "likes", "comments", "favorites", "shares", "likeRate", "favoriteRate", "engagementRate"]);
const rateNotes: Partial<Record<Axis, string>> = {
  likeRate: "点赞率 = 点赞数 ÷ 播放量", favoriteRate: "收藏率 = 收藏数 ÷ 播放量",
  engagementRate: "互动率 =（点赞 + 评论 + 收藏 + 分享）÷ 播放量",
};
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 });
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function axisValue(work: AnalyzedWork, axis: Axis): number | null {
  if (axis === "publishedAt") {
    const timestamp = Date.parse(work.publishedAt ?? "");
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (axis === "likeRate" || axis === "favoriteRate" || axis === "engagementRate") {
    if (work.plays == null || work.plays <= 0) return null;
    let interactions: number | null;
    if (axis === "engagementRate") {
      const { likes, comments, favorites, shares } = work;
      if (likes == null || comments == null || favorites == null || shares == null) return null;
      interactions = likes + comments + favorites + shares;
    } else {
      interactions = axis === "likeRate" ? work.likes : work.favorites;
    }
    return interactions == null ? null : interactions / work.plays * 100;
  }
  return work[axis] ?? null;
}

function formatValue(axis: Axis, value: number) {
  if (axis === "publishedAt") return date.format(value);
  if (rateNotes[axis]) return number.format(value) + "%";
  return number.format(value);
}

function defaultAxes(entries: WorkEntry[]) {
  const count = (pair: Axes) => entries.filter(({ work }) => axisValue(work, pair.x) != null && axisValue(work, pair.y) != null).length;
  const performanceCount = count(performanceAxes);
  return performanceCount < 2 && count(editingAxes) > performanceCount ? editingAxes : performanceAxes;
}

function chartAxis(axis: Axis) {
  const common = {
    name: axes[axis], nameLocation: "middle", nameTextStyle: { color: "#395e55", fontWeight: 600 },
    splitNumber: 4, axisLine: { show: true, lineStyle: { color: "#bfcec8" } }, axisTick: { show: false },
    splitLine: { show: true, lineStyle: { color: "#e6eeea", type: "dashed" } },
    axisLabel: { color: "#526f65", hideOverlap: true, fontSize: 11 },
  };
  if (axis === "publishedAt") return { ...common, type: "time" };
  return { ...common, type: "value", min: 0, minInterval: rateNotes[axis] || axis === "durationSec" ? undefined : 1,
    axisLabel: { ...common.axisLabel, formatter: (v: number) => compact.format(v) + (rateNotes[axis] ? "%" : "") } };
}

function scatterOption(points: Point[], pair: Axes, showAuthors: boolean): EChartsCoreOption {
  // Expose all works at an identical coordinate through one pointer target.
  const byCoordinate = new Map<string, Point[]>();
  for (const point of points) {
    const key = point.x + ":" + point.y;
    const group = byCoordinate.get(key);
    if (group) group.push(point);
    else byCoordinate.set(key, [point]);
  }
  const groups = Array.from(byCoordinate.values());
  function tooltip(params: { dataIndex: number }) {
    const group = groups[params.dataIndex];
    const box = document.createElement("div");
    box.className = "account-scatter-tip";
    for (const { work, author } of group.slice(0, 3)) {
      const title = document.createElement("strong");
      title.textContent = showAuthors ? author + " · " + work.title : work.title;
      box.appendChild(title);
    }
    if (group.length > 3) {
      const extra = document.createElement("small");
      extra.textContent = "同一坐标共 " + group.length + " 条作品";
      box.appendChild(extra);
    }
    for (const key of ["x", "y"] as const) {
      const value = document.createElement("span");
      value.textContent = axes[pair[key]] + "　" + formatValue(pair[key], group[0][key]);
      box.appendChild(value);
    }
    return box;
  }
  return {
    animation: false,
    grid: { top: 16, right: 22, bottom: 50, left: 64 },
    tooltip: { trigger: "item", triggerOn: "mousemove|click", confine: true, formatter: tooltip,
      borderColor: "#c2d5cc", textStyle: { color: "#163c35", fontSize: 12 } },
    xAxis: { ...chartAxis(pair.x), nameGap: 30 }, yAxis: { ...chartAxis(pair.y), nameGap: 48 },
    series: [{ type: "scatter", clip: false,
      data: groups.map(group => ({ value: [group[0].x, group[0].y], symbolSize: group.length > 1 ? 15 : 11 })),
      itemStyle: { color: "#13766f", borderColor: "#fff", borderWidth: 1, opacity: 0.92 },
      emphasis: { itemStyle: { color: "#064f4b" } },
    }],
  };
}

export function AccountWorkScatter({ accounts, scope, showAuthors = false }: { accounts: AnalyzedAccount[]; scope: string; showAuthors?: boolean }) {
  const entries = useMemo(() => accounts.flatMap(account => account.works.map(work => ({ work, author: account.name }))), [accounts]);
  const search = useSearchParams();
  const initial = useMemo(() => defaultAxes(entries), [entries]);
  const xAxis = search.get("xAxis"), yAxis = search.get("yAxis");
  const pair = useMemo<Axes>(() => xAxis && yAxis && xAxis !== yAxis && Object.hasOwn(axes, xAxis) && Object.hasOwn(axes, yAxis)
    ? { x: xAxis as Axis, y: yAxis as Axis } : initial, [xAxis, yAxis, initial]);
  const points = useMemo(() => entries.flatMap(entry => {
    const x = axisValue(entry.work, pair.x), y = axisValue(entry.work, pair.y);
    return x == null || y == null ? [] : [{ ...entry, x, y }];
  }), [entries, pair]);
  const option = useMemo(() => scatterOption(points, pair, showAuthors), [points, pair, showAuthors]);
  const missing = entries.length - points.length;
  const usesSnapshot = snapshotAxes.has(pair.x) || snapshotAxes.has(pair.y);
  function setChoice(axes: Axes) {
    const url = new URL(window.location.href);
    url.searchParams.set("xAxis", axes.x);
    url.searchParams.set("yAxis", axes.y);
    window.history.replaceState(window.history.state, "", url);
  }
  function choose(key: keyof Axes, value: Axis) {
    const other = key === "x" ? "y" : "x";
    setChoice({ ...pair, [key]: value, [other]: pair[other] === value ? pair[key] : pair[other] });
  }
  function select(key: keyof Axes) {
    const label = key === "x" ? "横轴" : "纵轴";
    return <label><span>{label}</span><select aria-label={label} value={pair[key]} onChange={e => choose(key, e.target.value as Axis)}>
      {(Object.keys(axes) as Axis[]).map(axis => <option value={axis} key={axis}>{axes[axis]}</option>)}
    </select></label>;
  }
  return <section className="account-scatter" aria-label="作品指标对比">
    <div className="account-scatter-head"><h3>作品指标对比</h3>
      <span aria-live="polite">{points.length} / {entries.length} 条作品可绘制</span>
    </div>
    <div className="account-scatter-controls">
      {select("x")}
      <button type="button" aria-label="交换横纵轴" title="交换横纵轴" onClick={() => setChoice({ x: pair.y, y: pair.x })}><ArrowLeftRight size={16} aria-hidden="true" /></button>
      {select("y")}
    </div>
    {points.length > 0 ? <EChart option={option} height={270} label={axes[pair.x] + "与" + axes[pair.y] + "散点图，" + points.length + "条作品"} /> :
      <p className="account-scatter-empty" role="status">还没有作品同时具备这两项数据。可以更换坐标轴，或在作品分析中更新数据。</p>}
    <div className="account-scatter-notes">
      {missing > 0 && <span>{missing} 条作品缺少所选指标或无法计算。</span>}
      {points.length === 1 && <span>当前组合只有 1 条作品可供查看。</span>}
      {usesSnapshot && points.length > 0 && <span>播放和互动数据取自各作品最近一次采集。</span>}
      {[pair.x, pair.y].map(axis => rateNotes[axis] && <span key={axis}>{rateNotes[axis]}。</span>)}
    </div>
    {points.length > 0 && <details className="account-scatter-data"><summary>查看绘图数据</summary>
      <div><table><thead><tr><th scope="col">作品</th><th scope="col">{axes[pair.x]}</th><th scope="col">{axes[pair.y]}</th></tr></thead>
        <tbody>{points.map(({ work, author, x, y }) => <tr key={work.videoId}>
          <th scope="row"><Link href={`/analysis/${encodeURIComponent(work.videoId)}?${scope}`}>{work.title}</Link>
            {showAuthors && <small>{author}</small>}
            {usesSnapshot && work.collectedAt && <small>采集于 {formatClientDate(work.collectedAt)}</small>}
          </th>
          <td>{formatValue(pair.x, x)}</td><td>{formatValue(pair.y, y)}</td>
        </tr>)}</tbody></table></div>
    </details>}
  </section>;
}
