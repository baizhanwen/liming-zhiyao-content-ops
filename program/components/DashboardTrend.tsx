"use client";

import { CalendarDays, ChartNoAxesCombined, ChevronDown, TrendingDown, TrendingUp } from "lucide-react";
import { useState, type CSSProperties, type KeyboardEvent } from "react";

export type ProductionDay = { date: string; count: number };

const shortDate = (iso: string) => iso.slice(5).replace("-", "/");
const sum = (days: ProductionDay[]) => days.reduce((total, day) => total + day.count, 0);

export function DashboardTrend({ days, personal }: { days: ProductionDay[]; personal: boolean }) {
  const [period, setPeriod] = useState(14);
  const [selectedDate, setSelectedDate] = useState("");
  const rows = days.slice(-period);
  const previousRows = days.slice(-2 * period, -period);
  const total = sum(rows);
  const previous = sum(previousRows);
  const comparable = rows.length === period && previousRows.length === period;
  const change = comparable && previous > 0 ? (total - previous) / previous * 100 : null;
  const highest = Math.max(0, ...rows.map(day => day.count));
  const step = Math.max(1, Math.ceil(highest / 4));
  const maximum = 4 * step;
  const selected = rows.find(day => day.date === selectedDate) ?? rows.findLast(day => day.count === highest);
  const ChangeIcon = change !== null && change < 0 ? TrendingDown : TrendingUp;

  function moveDay(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = rows.length - 1;
    const next = { ArrowLeft: Math.max(0, index - 1), ArrowRight: Math.min(last, index + 1), Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
  }

  return <section className="home-trend" aria-labelledby="home-trend-title">
    <div className="home-trend-header">
      <h2 id="home-trend-title"><ChartNoAxesCombined aria-hidden="true" />{personal ? "我的内容产出趋势" : "内容产出趋势"}</h2>
      <label className="home-trend-period field-affix field-compact"><CalendarDays aria-hidden="true" />
        <select aria-label="统计周期" value={period} onChange={event => { setPeriod(Number(event.target.value)); setSelectedDate(""); }}>
          {[7, 14, 30].map(value => <option key={value} value={value}>近 {value} 天</option>)}
        </select><ChevronDown aria-hidden="true" />
      </label>
    </div>
    {rows.length ? <>
      <div className="home-trend-summary">
        <p><strong>{total.toLocaleString("zh-CN")}</strong> 篇</p>
        {change !== null && <span className="home-trend-change"><ChangeIcon aria-hidden="true" />{change > 0 ? "+" : ""}{change.toFixed(1)}%</span>}
        {comparable && <small>{previous > 0 ? "较上期" : "上期无产出"}</small>}
        <span className="home-trend-legend">每日产出</span>
      </div>
      <div className={`home-plot period-${period}`} style={{ "--days": rows.length } as CSSProperties}>
        <div className="home-plot-scale" aria-hidden="true">{[4,3,2,1,0].map(i => <span style={{ top: (4-i)*25+"%" }} key={i}>{i * step}</span>)}</div>
        <div className="home-plot-bars" role="group" aria-label="每日新增稿件，可用左右方向键查看日期">
          {[0,25,50,75,100].map(position => <i key={position} className="home-plot-grid" style={{ top: position+"%" }} aria-hidden="true" />)}
          {rows.map((day, index) => {
            const active = selected?.date === day.date;
            return <button key={day.date} type="button" className="home-day" aria-label={`${day.date} 新增 ${day.count} 篇稿件`} aria-pressed={active}
              tabIndex={active ? 0 : -1} style={{ "--height": day.count / maximum * 100+"%" } as CSSProperties}
              onMouseEnter={() => setSelectedDate(day.date)} onFocus={() => setSelectedDate(day.date)} onClick={() => setSelectedDate(day.date)} onKeyDown={event => moveDay(event, index)}>
              <span className="home-day-bar" />{active && total > 0 && <span className="home-day-tip" aria-hidden="true">{day.count} 篇</span>}
            </button>;
          })}
          {!total && <p className="home-plot-empty">这段时间暂无新增稿件</p>}
        </div>
        <div className="home-plot-labels" aria-hidden="true">{rows.map((day, index) =>
          <span key={day.date} className={day.date === selected?.date ? "current" : ""}>{period < 30 || index % 5 === 0 || index === rows.length - 1 ? shortDate(day.date) : ""}</span>)}</div>
      </div>
    </> : <p className="home-trend-unavailable">暂无可用的产出统计。</p>}
  </section>;
}
