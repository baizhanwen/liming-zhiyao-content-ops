"use client";
import type { ModelServiceStatus as ModelServiceState } from "../lib/model-service-status";


import { scopedFetch, rememberCurrentScope } from "../lib/client-scope";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AppShell } from "./AppShell";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { EnvironmentSetupPanel } from "./EnvironmentSetupPanel";

type Organization = { id: string; name: string; role: string };

type ModelServices = {
  contentGeneration: ModelServiceState;
  analysisText: ModelServiceState;
  visualUnderstanding: ModelServiceState;
  projectAssistant: ModelServiceState;
};
type Operations = {
  organization: { id: string; name: string; status: string };
  organizationRole: string;
  capacity: { plan_code: "starter" | "team" | "scale"; project_quota: number; member_quota: number; monthly_analysis_quota: number; monthly_model_call_quota: number; storage_quota_bytes: number; retention_days: number };
  license: { planCode: string; planName: string; deliveryMode: boolean; features: { videoAnalysis: boolean; wechatImages: boolean; insights: boolean } };
  usage: { projects: number; members: number; analyses: number; modelCalls: number; storageBytes: number };
  alerts: Array<{ code: string; severity: "warning" | "critical"; title: string; message: string }>;
  services: { database: string; analyzerCredentialConfigured: boolean; analyzerOnline: boolean; contentModelConfigured: boolean; models: ModelServices; localPasswordConfigured: boolean; lastWorkerHeartbeat: string | null };
  recentAudit: Array<{ id: string; action: string; target_type: string; actor_email: string; project_name: string | null; created_at: string }>;
};

async function responseError(response: Response) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; return body?.error?.message ?? "请求未完成。"; }
function percent(current: number, limit: number) { return limit ? Math.min(100, Math.round(current / limit * 100)) : 0; }
function bytes(value: number) { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`; }

export function SystemOperations() {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState(""); const [data, setData] = useState<Operations | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [passwordSaving, setPasswordSaving] = useState(false); const [passwordMessage, setPasswordMessage] = useState(""); const [visionProbing, setVisionProbing] = useState(false); const [visionProbeMessage, setVisionProbeMessage] = useState("");
  async function load(id: string) { rememberCurrentScope(id, ""); setLoading(true); const response = await scopedFetch(`/api/operations?organizationId=${encodeURIComponent(id)}`); if (!response.ok) throw new Error(await responseError(response)); setData(await response.json() as Operations); setLoading(false); }
  useEffect(() => { let active = true; (async () => { try { const response = await fetch("/api/organizations"); if (!response.ok) throw new Error(await responseError(response)); const body = await response.json() as { organizations: Organization[] }; if (!active) return; setOrganizations(body.organizations); const first = body.organizations[0]?.id ?? ""; setOrganizationId(first); if (first) await load(first); else setLoading(false); } catch (reason) { if (active) { setError(reason instanceof Error ? reason.message : "加载失败"); setLoading(false); } } })(); return () => { active = false; }; }, []);
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!data) return; setSaving(true); setError(""); const form = new FormData(event.currentTarget); const response = await scopedFetch("/api/operations", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, name: form.get("name") }) }); if (!response.ok) { setError(await responseError(response)); setSaving(false); return; } await load(organizationId); setSaving(false); }
  async function probeVision() {
    if (!organizationId) return;
    setVisionProbing(true); setVisionProbeMessage(""); setError("");
    try {
      const response = await scopedFetch("/api/operations/vision-probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId }) });
      if (!response.ok) { setVisionProbeMessage(await responseError(response)); return; }
      const body = await response.json() as { probe: { status: "passed" | "failed"; message: string } };
      setVisionProbeMessage(body.probe.status === "passed" ? "真实图片预检已通过。" : body.probe.message);
      await load(organizationId);
    } catch (reason) { setVisionProbeMessage(reason instanceof Error ? reason.message : "图片预检没有完成。"); }
    finally { setVisionProbing(false); }
  }
  async function savePassword(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPasswordSaving(true); setPasswordMessage(""); const element = event.currentTarget; const form = new FormData(element); const response = await scopedFetch("/api/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: form.get("currentPassword"), password: form.get("password"), confirmation: form.get("confirmation") }) }); if (!response.ok) { setPasswordMessage(await responseError(response)); setPasswordSaving(false); return; } element.reset(); setPasswordMessage("密码已更新，旧登录会话已退出，正在返回登录页…"); window.setTimeout(() => window.location.replace("/login?returnTo=%2Fsettings"), 800); }
  const quotas = data ? [
    ["运行中项目", data.usage.projects, data.capacity.project_quota, String],
    ["有效成员与待接受邀请", data.usage.members, data.capacity.member_quota, String],
    ...(data.license.features.videoAnalysis ? [["本月分析任务", data.usage.analyses, data.capacity.monthly_analysis_quota, String] as const, ["媒体存储", data.usage.storageBytes, data.capacity.storage_quota_bytes, bytes] as const] : []),
    ["本月模型调用", data.usage.modelCalls, data.capacity.monthly_model_call_quota, String],
  ] as const : [];
  return <AppShell activePath="/settings"><section className="page-heading"><div><p>稳定运行与商业化基础</p><h1>系统运营中心</h1><span>监控健康、用量、配额、审计和本地数据保护。</span></div><button className="secondary-button" onClick={() => organizationId && load(organizationId)}>刷新状态</button></section>
    {organizations.length > 0 && <div className="management-toolbar"><label>公司<select value={organizationId} onChange={async (event) => { setOrganizationId(event.target.value); await load(event.target.value); }}>{organizations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><span>{data ? data.license.planName : "加载中"}</span></div>}
    {loading && <div className="management-state">正在检查系统状态…</div>}{error && <div className="inline-alert" role="alert">{error}</div>}
    {!loading && !organizationId && <div className="empty-panel"><h2>请先创建公司空间</h2><Link className="primary-button link-button" href="/projects">前往初始化</Link></div>}
    {data && <div className="operations-layout"><section className="operations-main"><div className="service-grid"><article className="panel service-card"><span className="signal green"/><small>结构化数据库</small><strong>运行正常</strong><p>D1 可读写，健康检查已通过。</p></article>{data.license.features.videoAnalysis && <article className="panel service-card"><span className={data.services.analyzerOnline ? "signal green" : "signal amber"}/><small>视频分析服务</small><strong>{data.services.analyzerOnline ? "自动分析运行中" : !data.services.analyzerCredentialConfigured ? "等待服务凭据" : !data.services.models.analysisText.configured ? "等待分析文本模型" : "服务未连接"}</strong><p>{data.services.lastWorkerHeartbeat ? `最近心跳 ${new Date(data.services.lastWorkerHeartbeat).toLocaleString("zh-CN")}` : data.services.models.analysisText.configured ? "请重新启动项目或单独启动分析服务" : "完成模型配置后即可启动"}</p></article>}</div><article className="panel operations-panel model-status-panel"><div className="panel-heading"><div><p className="section-kicker">模型配置与隔离状态</p><h2>四类模型链路</h2></div><span>页面只显示提供方和模型名，不返回任何密钥</span></div><div className="model-status-grid">{Object.values(data.services.models).map((model) => {
          const signal = model.readiness === "ready" || model.readiness === "shared" ? "green" : model.readiness === "failed" ? "red" : "amber";
          return <section key={model.id} className={"model-status-card " + model.readiness}><header><span className={"signal " + signal}/><div><small>{model.label}</small><strong>{model.stateLabel}</strong></div><em>{model.isolation === "independent" ? "独立" : "复用"}</em></header><p>{model.provider || "未填写提供方"}<b>/</b>{model.model || "未填写模型或工具"}</p><span>{model.note}</span>{model.missing.length > 0 && <small>缺少：{model.missing.join("、")}</small>}{model.id === "visualUnderstanding" && <div className="model-probe-actions"><button type="button" disabled={visionProbing || !model.keyFormatValid} onClick={() => void probeVision()}>{visionProbing ? "正在测试图片…" : "测试真实图片能力"}</button><span>{model.probeCheckedAt ? `最近预检 ${new Date(model.probeCheckedAt).toLocaleString("zh-CN")}` : "将消耗一次低成本图片理解请求"}{model.probeStatus === "failed" && (model.probeHttpStatus || model.probeRequestId) ? ` · HTTP ${model.probeHttpStatus ?? "—"}${model.probeRequestId ? ` · 请求 ${model.probeRequestId}` : ""}` : ""}</span>{visionProbeMessage && <small>{visionProbeMessage}</small>}</div>}</section>;
        })}</div></article>
      {data.license.features.videoAnalysis && <EnvironmentSetupPanel key={`environment:${organizationId}`} organizationId={organizationId} canManage={data.organizationRole === "admin"} />}
      <ModelSettingsPanel key={organizationId} organizationId={organizationId} canManage={data.organizationRole === "admin"} onSaved={() => load(organizationId)} />
      <article id="alerts" className="panel operations-panel"><div className="panel-heading"><div><p className="section-kicker">运行告警</p><h2>{data.alerts.length ? `${data.alerts.length} 项需要关注` : "当前没有活动告警"}</h2></div></div>{data.alerts.length ? <div className="alert-list">{data.alerts.map((alert) => <div className={`operation-alert ${alert.severity}`} key={alert.code}><span>{alert.severity === "critical" ? "!" : "△"}</span><div><strong>{alert.title}</strong><p>{alert.message}</p></div></div>)}</div> : <div className="dashboard-empty">分析任务、模型调用、发布记录和审核时效均未触发阈值。</div>}</article>
      <article className="panel operations-panel"><div className="panel-heading"><div><p className="section-kicker">用量与授权配额</p><h2>当前授权：{data.license.planName}</h2></div><span>保留期 {data.capacity.retention_days} 天</span></div><div className="quota-list">{quotas.map(([label,current,limit,format]) => <div className="quota-row" key={label}><div><strong>{label}</strong><span>{format(current)} / {format(limit)}</span></div><div className="progress-track"><i style={{width:`${percent(current,limit)}%`}} /></div><small>{percent(current,limit)}%</small></div>)}</div></article>
      <article className="panel operations-panel"><div className="panel-heading"><div><p className="section-kicker">最近审计</p><h2>关键操作记录</h2></div><Link href="/settings#backup">本地备份</Link></div><div className="audit-list">{data.recentAudit.map((item) => <div key={item.id}><span>{item.action}</span><strong>{item.project_name || item.target_type}</strong><small>{item.actor_email} · {new Date(item.created_at).toLocaleString("zh-CN")}</small></div>)}</div></article></section>
      <aside className="operations-side">{data.organizationRole === "admin" && <article className="create-panel settings-card"><p className="section-kicker">公司与运行版本</p><h2>完整开发版</h2><form className="stack-form" onSubmit={save}><label>公司名称<input name="name" defaultValue={data.organization.name} minLength={2} maxLength={80} required /></label><label>当前版本<input value={data.license.planName} readOnly /></label><p>后续统一使用完整开发版。更新程序前请备份本地数据和配置；运行容量显示在服务概览中。</p><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "保存公司名称"}</button></form></article>}<article className="create-panel settings-card"><p className="section-kicker">局域网账号</p><h2>{data.services.localPasswordConfigured ? "修改当前账号密码" : "设置当前账号密码"}</h2><p>密码至少 10 个字符。修改成功后会退出该账号的全部旧会话。</p><form className="stack-form" onSubmit={savePassword}>{data.services.localPasswordConfigured && <label>当前密码<input name="currentPassword" type="password" minLength={10} maxLength={128} autoComplete="current-password" required /></label>}<label>新密码<input name="password" type="password" minLength={10} maxLength={128} autoComplete="new-password" required /></label><label>确认密码<input name="confirmation" type="password" minLength={10} maxLength={128} autoComplete="new-password" required /></label>{passwordMessage && <div className="inline-alert" role="status">{passwordMessage}</div>}<button className="primary-button" disabled={passwordSaving}>{passwordSaving ? "正在保存…" : data.services.localPasswordConfigured ? "修改密码" : "设置局域网密码"}</button></form></article><article id="backup" className="create-panel settings-card"><p className="section-kicker">备份与恢复</p><h2>保护本地业务数据</h2><p>停止服务后双击 <code>tools\backup-local.bat</code> 创建带时间戳的完整本地状态包。恢复时运行 <code>tools\restore-local.bat</code>，旧状态会先保留为可回退副本。</p></article><article className="create-panel settings-card"><p className="section-kicker">合规文档</p><h2>使用边界</h2><p><Link href="/privacy">隐私政策草案 →</Link></p><p><Link href="/terms">服务条款草案 →</Link></p></article></aside></div>}
  </AppShell>;
}
