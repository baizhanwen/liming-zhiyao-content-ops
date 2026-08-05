"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type KnowledgeItem = { id: string; category: string; title: string; status: string; current_version: number; body: string; source_type: string; source_ref: string | null; confirmed_at: string | null; updated_at: string };
type Strategy = { id: string; version: number; name: string; status: string; positioning: string; target_audience: string; pain_points: string[]; pillars: string[]; objectives: string[]; cadence: string | null; conversion_path: string | null; effective_from: string | null; updated_at: string };

const categoryLabels: Record<string, string> = { brand_story: "品牌故事", founder: "创始人/出镜人", case_study: "成功案例", customer_question: "客户问题", sales_script: "销售话术", high_performing_copy: "历史优质文案", industry_term: "行业术语", compliance: "禁用词与合规", brand_voice: "品牌语气", client_preference: "客户修改偏好", other: "其他" };
const sourceLabels: Record<string, string> = { manual: "人工录入", document: "客户资料", url: "网页来源", client_feedback: "客户反馈", analysis: "分析沉淀" };
async function readError(response: Response) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; return body?.error?.message ?? "请求没有完成，请稍后重试。"; }
function splitList(value: FormDataEntryValue | null) { return String(value || "").split(/[，,\n]/).map((item) => item.trim()).filter(Boolean); }
function equalTopicMix(pillars: string[]) { const base = pillars.length ? Math.floor(100 / pillars.length) : 0; const remainder = 100 - base * pillars.length; return pillars.map((pillar, index) => ({ pillar, ratio: base + (index < remainder ? 1 : 0) })); }
function dateLabel(value: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value)) : "—"; }

export function KnowledgeWorkspace({ initialOrganizationId = "", initialProjectId = "" }: { initialOrganizationId?: string; initialProjectId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState(""); const [tab, setTab] = useState<"knowledge" | "strategy">("knowledge");
  const [items, setItems] = useState<KnowledgeItem[]>([]); const [strategies, setStrategies] = useState<Strategy[]>([]); const [canWrite, setCanWrite] = useState(false); const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState("");

  const loadWorkspace = useCallback(async (orgId: string, projId: string) => {
    if (!orgId || !projId) { setItems([]); setStrategies([]); return; }
    const query = `organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`;
    const [knowledgeResponse, strategyResponse] = await Promise.all([fetch(`/api/knowledge?${query}`), fetch(`/api/strategies?${query}`)]);
    if (!knowledgeResponse.ok) throw new Error(await readError(knowledgeResponse)); if (!strategyResponse.ok) throw new Error(await readError(strategyResponse));
    const knowledge = await knowledgeResponse.json() as { items: KnowledgeItem[]; canWrite: boolean; canManage: boolean }; const strategy = await strategyResponse.json() as { strategies: Strategy[]; canWrite: boolean; canManage: boolean };
    setItems(knowledge.items); setStrategies(strategy.strategies); setCanWrite(knowledge.canWrite && strategy.canWrite); setCanManage(knowledge.canManage && strategy.canManage);
  }, []);

  const loadProjects = useCallback(async (orgId: string, preferred = "") => {
    const response = await fetch(`/api/projects?organizationId=${encodeURIComponent(orgId)}`); if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as { projects: Project[] }; setProjects(body.projects); const selected = body.projects.some((project) => project.id === preferred) ? preferred : body.projects[0]?.id ?? ""; setProjectId(selected); await loadWorkspace(orgId, selected);
  }, [loadWorkspace]);

  useEffect(() => { let active = true; (async () => { try { const response = await fetch("/api/organizations"); if (!response.ok) throw new Error(await readError(response)); const body = await response.json() as { organizations: Organization[] }; if (!active) return; setOrganizations(body.organizations); const selected = body.organizations.some((organization) => organization.id === initialOrganizationId) ? initialOrganizationId : body.organizations[0]?.id ?? ""; setOrganizationId(selected); if (selected) await loadProjects(selected, initialProjectId); } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "加载失败"); } finally { if (active) setLoading(false); } })(); return () => { active = false; }; }, [initialOrganizationId, initialProjectId, loadProjects]);

  async function createKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); const form = new FormData(event.currentTarget);
    const response = await fetch("/api/knowledge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, title: form.get("title"), category: form.get("category"), body: form.get("body"), sourceType: form.get("sourceType"), sourceRef: form.get("sourceRef") }) });
    if (!response.ok) { setError(await readError(response)); setSaving(false); return; } const body = await response.json() as { item: KnowledgeItem }; setItems((current) => [body.item, ...current]); event.currentTarget.reset(); setSaving(false);
  }

  async function confirmKnowledge(itemId: string) {
    setError(""); const response = await fetch(`/api/knowledge/${itemId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId }) });
    if (!response.ok) { setError(await readError(response)); return; } const body = await response.json() as { item: { status: string; confirmed_at: string } }; setItems((current) => current.map((item) => item.id === itemId ? { ...item, ...body.item } : item));
  }

  async function createStrategy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); const form = new FormData(event.currentTarget);
    const pillars = splitList(form.get("pillars"));
    const response = await fetch("/api/strategies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, name: form.get("name"), positioning: form.get("positioning"), persona: form.get("persona"), targetAudience: form.get("targetAudience"), painPoints: splitList(form.get("painPoints")), pillars, objectives: splitList(form.get("objectives")), cadence: form.get("cadence"), conversionPath: form.get("conversionPath"), styleNotes: form.get("styleNotes"), topicMix: equalTopicMix(pillars) }) });
    if (!response.ok) { setError(await readError(response)); setSaving(false); return; } const body = await response.json() as { strategy: Strategy }; setStrategies((current) => [body.strategy, ...current]); event.currentTarget.reset(); setSaving(false);
  }

  async function activateStrategy(strategyId: string) {
    setError(""); const response = await fetch(`/api/strategies/${strategyId}/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId }) });
    if (!response.ok) { setError(await readError(response)); return; } const body = await response.json() as { strategy: { id: string; status: string; effective_from: string } }; setStrategies((current) => current.map((strategy) => strategy.id === strategyId ? { ...strategy, status: "active", effective_from: body.strategy.effective_from } : strategy.status === "active" ? { ...strategy, status: "retired" } : strategy));
  }

  if (loading) return <div className="management-state" role="status">正在载入品牌知识空间…</div>;
  if (error && organizations.length === 0) return <div className="management-state error-state"><strong>暂时无法进入知识库</strong><p>{error}</p><small>本地预览不会伪造登录身份；请在私有站点登录后使用真实项目数据。</small></div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><span aria-hidden="true">▤</span><h2>请先创建客户项目</h2><p>品牌知识和内容策略必须归属于明确的客户项目。</p></div>;

  return <div className="knowledge-workspace">
    <div className="management-toolbar knowledge-toolbar"><label>公司<select value={organizationId} onChange={async (event) => { const id = event.target.value; setOrganizationId(id); await loadProjects(id); }}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label><label>客户项目<select value={projectId} onChange={async (event) => { const id = event.target.value; setProjectId(id); await loadWorkspace(organizationId, id); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><div className="segmented-control" aria-label="知识库视图"><button className={tab === "knowledge" ? "active" : ""} type="button" onClick={() => setTab("knowledge")}>品牌知识</button><button className={tab === "strategy" ? "active" : ""} type="button" onClick={() => setTab("strategy")}>内容策略</button></div></div>
    {error && <div className="inline-alert" role="alert">{error}</div>}
    {tab === "knowledge" ? <div className="knowledge-layout"><section className="panel knowledge-list-panel"><div className="panel-heading"><div><p className="section-kicker">已确认知识才参与生成</p><h2>{items.filter((item) => item.status === "confirmed").length} 条正式知识 · {items.filter((item) => item.status === "draft").length} 条待确认</h2></div></div>{items.length ? <div className="knowledge-list">{items.map((item) => <article key={item.id}><div className="knowledge-card-head"><span>{categoryLabels[item.category] || item.category}</span><em className={`status ${item.status === "confirmed" ? "success" : "neutral"}`}>{item.status === "confirmed" ? "已确认" : item.status === "draft" ? "待确认" : "已归档"}</em></div><h3>{item.title}</h3><p>{item.body}</p><footer><span>{sourceLabels[item.source_type] || item.source_type} · v{item.current_version} · {dateLabel(item.updated_at)}</span>{item.status === "draft" && canManage && <button type="button" onClick={() => confirmKnowledge(item.id)}>确认沉淀</button>}</footer></article>)}</div> : <div className="list-empty">先录入品牌故事、案例、客户问题、语气或合规要求。</div>}</section>{canWrite && <aside className="create-panel knowledge-create"><p className="section-kicker">新增知识草稿</p><h2>保留来源，再由负责人确认</h2><form className="stack-form" onSubmit={createKnowledge}><label>标题<input name="title" required minLength={2} maxLength={120} /></label><div className="form-row"><label>分类<select name="category" defaultValue="brand_story">{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>来源<select name="sourceType" defaultValue="manual">{Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><label>知识正文<textarea name="body" required minLength={10} maxLength={20000} rows={7} /></label><label>来源说明或链接<input name="sourceRef" maxLength={1000} placeholder="文件名、网页链接或反馈记录" /></label><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "保存为待确认知识"}</button></form></aside>}</div> : <div className="strategy-layout"><section className="strategy-list">{strategies.length ? strategies.map((strategy) => <article className={`panel strategy-card ${strategy.status}`} key={strategy.id}><div className="panel-heading"><div><p className="section-kicker">策略 v{strategy.version}</p><h2>{strategy.name}</h2></div><span className={`status ${strategy.status === "active" ? "success" : "neutral"}`}>{strategy.status === "active" ? "当前启用" : strategy.status === "draft" ? "草稿" : "历史版本"}</span></div><div className="strategy-body"><section><h3>账号定位</h3><p>{strategy.positioning}</p></section><section><h3>目标人群</h3><p>{strategy.target_audience}</p></section><section><h3>内容支柱</h3><div className="plain-chips">{strategy.pillars?.map((pillar) => <span key={pillar}>{pillar}</span>)}</div></section><section><h3>阶段目标</h3><ul>{strategy.objectives?.map((objective) => <li key={objective}>{objective}</li>)}</ul></section></div><footer><span>{strategy.status === "active" ? `启用于 ${dateLabel(strategy.effective_from)}` : `更新于 ${dateLabel(strategy.updated_at)}`}</span>{strategy.status !== "active" && canManage && <button type="button" onClick={() => activateStrategy(strategy.id)}>启用此版本</button>}</footer></article>) : <div className="empty-panel"><span aria-hidden="true">⌁</span><h2>还没有内容策略</h2><p>建立第一版账号定位、目标人群、内容支柱和阶段目标。</p></div>}</section>{canWrite && <aside className="create-panel strategy-create"><p className="section-kicker">新策略版本</p><h2>创建后先保存为草稿</h2><form className="stack-form" onSubmit={createStrategy}><label>版本名称<input name="name" required minLength={2} maxLength={100} placeholder="例如：专业管理顾问增长策略" /></label><label>账号定位<textarea name="positioning" required minLength={5} rows={3} /></label><label>人设定位<input name="persona" maxLength={1000} /></label><label>目标人群<textarea name="targetAudience" required minLength={2} rows={2} /></label><label>用户痛点（逗号分隔）<textarea name="painPoints" required rows={2} /></label><label>内容支柱（逗号分隔）<input name="pillars" required /></label><label>阶段目标（逗号分隔）<textarea name="objectives" required rows={2} /></label><div className="form-row"><label>更新频率<input name="cadence" placeholder="每周 3 条" /></label><label>转化路径<input name="conversionPath" /></label></div><label>内容风格<textarea name="styleNotes" rows={2} /></label><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "创建策略草稿"}</button></form></aside>}</div>}
  </div>;
}
