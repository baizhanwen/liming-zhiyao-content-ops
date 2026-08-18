"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "./AppShell";
import { deliveryPlan } from "../lib/delivery-entitlements";

type Organization = { id: string; name: string; role: string };
type Dashboard = {
  summary: { pendingReviews: number; publishedMonth: number; activeJobs: number; failedJobs: number; upcomingSchedules: number; monthlyContentTarget: number };
  reviews: Array<{ id: string; review_stage: string; title: string; project_name: string; due_at: string | null }>;
  jobs: Array<{ id: string; status: string; progress: number; current_stage: string | null; title: string | null; project_name: string; updated_at: string }>;
  projects: Array<{ id: string; name: string; content_target: number; status: string }>;
};

async function errorMessage(response: Response) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; return body?.error?.message ?? "工作台加载失败。"; }

export function DashboardWorkspace() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function loadDashboard(id: string) {
    setLoading(true); setError("");
    const response = await fetch(`/api/dashboard?organizationId=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(await errorMessage(response));
    setDashboard(await response.json() as Dashboard); setLoading(false);
  }

  useEffect(() => { let active = true; (async () => { try { const response = await fetch("/api/organizations"); if (!response.ok) throw new Error(await errorMessage(response)); const body = await response.json() as { organizations: Organization[] }; if (!active) return; setOrganizations(body.organizations); const first = body.organizations[0]?.id ?? ""; setOrganizationId(first); if (first) await loadDashboard(first); else setLoading(false); } catch (reason) { if (active) { setError(reason instanceof Error ? reason.message : "工作台加载失败。"); setLoading(false); } } })(); return () => { active = false; }; }, []);

  const publishedProgress = dashboard?.summary.monthlyContentTarget ? Math.min(100, Math.round(dashboard.summary.publishedMonth / dashboard.summary.monthlyContentTarget * 100)) : 0;
  return <AppShell activePath="/">
    <section className="page-heading"><div><p>{new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</p><h1>运营工作台</h1><span>所有数字均来自当前公司真实业务记录。</span></div><Link className="primary-button link-button" href="/content"><span aria-hidden="true">＋</span> 新建内容</Link></section>
    {organizations.length > 1 && <div className="management-toolbar dashboard-scope"><label>公司空间<select value={organizationId} onChange={async (event) => { setOrganizationId(event.target.value); await loadDashboard(event.target.value); }}>{organizations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></div>}
    {loading && <div className="management-state" role="status">正在汇总真实运营数据…</div>}
    {error && <div className="inline-alert" role="alert">{error}</div>}
    {!loading && !organizationId && <section className="setup-card"><span className="setup-step">开始使用</span><h2>先创建公司和客户项目</h2><p>完成初始化后，工作台会自动汇总审核、发布、分析和内容进度。</p><Link className="primary-button link-button" href="/projects">创建公司空间</Link></section>}
    {dashboard && <>
      <section className="attention-grid" aria-label="真实运营概览">
        <article className={dashboard.summary.pendingReviews ? "attention-card important" : "attention-card"}><div className="card-eyebrow"><span className="signal red" />待审核</div><div className="big-number">{dashboard.summary.pendingReviews}</div><p>条内容等待决定</p><div className="card-trend">来自内部审核队列</div><Link href="/workflow?view=review">进入审核中心 →</Link></article>
        <article className="attention-card"><div className="card-eyebrow"><span className="signal amber" />本月发布进度</div><div className="progress-copy"><strong>{dashboard.summary.publishedMonth} / {dashboard.summary.monthlyContentTarget || "—"}</strong><span>已发布 / 目标</span></div><div className="progress-track" aria-label={`本月完成 ${publishedProgress}%`}><i style={{ width: `${publishedProgress}%` }} /></div><div className="card-trend">未来 7 天安排 {dashboard.summary.upcomingSchedules} 条</div></article>
        {deliveryPlan.features.videoAnalysis && <article className="attention-card"><div className="card-eyebrow"><span className="signal blue" />分析处理中</div><div className="big-number">{dashboard.summary.activeJobs}</div><p>个任务正在排队或运行</p><div className={dashboard.summary.failedJobs ? "card-trend urgent" : "card-trend positive"}>失败任务 {dashboard.summary.failedJobs} 个</div><Link href="/analysis">查看分析任务 →</Link></article>}
        <article className="attention-card compact"><div className="card-eyebrow"><span className="signal green" />客户项目</div><div className="big-number">{dashboard.projects.length}</div><p>个项目处于服务范围</p><div className="card-trend positive">月内容目标合计 {dashboard.summary.monthlyContentTarget} 条</div><Link href="/projects">管理客户项目 →</Link></article>
      </section>
      <section className="content-grid dashboard-live-grid"><div className="main-column"><article className="panel review-panel"><div className="panel-heading"><div><p className="section-kicker">待审核内容</p><h2>{dashboard.reviews.length ? "优先处理临近截止的内容" : "当前没有待审核内容"}</h2></div><Link href="/workflow?view=review">查看全部</Link></div>{dashboard.reviews.length ? <div className="table-wrap"><table><thead><tr><th>内容</th><th>项目</th><th>阶段</th><th>截止</th></tr></thead><tbody>{dashboard.reviews.map((item) => <tr key={item.id}><td><strong>{item.title}</strong></td><td>{item.project_name}</td><td><span className="status neutral">内部审核</span></td><td>{item.due_at ? new Date(item.due_at).toLocaleDateString("zh-CN") : "未设置"}</td></tr>)}</tbody></table></div> : <div className="dashboard-empty">审核队列已清空，可以继续推进内容生产。</div>}</article></div>{deliveryPlan.features.videoAnalysis && <div className="side-column"><article className="panel jobs-panel"><div className="panel-heading"><div><p className="section-kicker">最近分析任务</p><h2>运行状态</h2></div><Link href="/analysis">全部</Link></div>{dashboard.jobs.length ? dashboard.jobs.map((job) => <div className="job" key={job.id}><span className={`job-icon ${job.status === "completed" ? "complete" : job.status === "failed" ? "error" : ""}`}>{job.status === "failed" ? "!" : "影"}</span><div><strong>{job.title || "未命名分析任务"}</strong><small>{job.project_name} · {job.current_stage || job.status}</small>{!['completed','failed','cancelled'].includes(job.status) && <div className="progress-track small"><i style={{ width: `${job.progress}%` }} /></div>}</div><em className={job.status === "completed" ? "complete-text" : ""}>{job.status === "failed" ? "失败" : job.status === "completed" ? "完成" : `${job.progress}%`}</em></div>) : <div className="dashboard-empty">还没有分析任务。</div>}</article></div>}</section>
    </>}
  </AppShell>;
}
