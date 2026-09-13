"use client";
import { runScopedAction } from "../lib/client-scope";
import { useWorkspaceInitialization } from "./useWorkspaceInitialization";
import { readApiError as readError, formatClientDate } from "../lib/client-format";


import { ChangeEvent, FormEvent, useCallback, useState } from "react";
import { AlertTriangle, Archive, Check, Database, Download, FileSearch, FileSpreadsheet, History, Lightbulb, PencilLine, Save, Search, UploadCloud, Video, Workflow } from "lucide-react";
import { preferredProjectId, rememberCurrentScope, scopedFetch } from "../lib/client-scope";
import { validateKnowledgeImportRows, type KnowledgeImportIssue } from "../lib/knowledge-import";
import { readFirstWorksheet } from "../lib/xlsx-table";

type Organization = { id: string; name: string };
type Project = { id: string; name: string; status?: string };
type KnowledgeItem = { id: string; category: string; title: string; status: string; current_version: number; body: string; source_type: string; source_ref: string | null; confirmed_at: string | null; updated_at: string }; type KnowledgeVersion = { version: number; body: string; source_type: string; source_ref: string | null; change_summary: string | null; created_at: string };
type Strategy = { id: string; version: number; name: string; status: string; positioning: string; target_audience: string; pain_points: string[]; pillars: string[]; objectives: string[]; cadence: string | null; conversion_path: string | null; effective_from: string | null; updated_at: string };
type StrategySpace = { id: string; name: string; status: string; strategies: Strategy[] };
type KnowledgeImportPreview = { filename: string; rawRows: Record<string, unknown>[]; validCount: number; issues: KnowledgeImportIssue[] };
type MethodSource = { id: string; name: string; revision: string; item_count: number; synced_at: string };
type MethodAtom = { id: string; knowledge: string; original: string; url: string | null; published_at: string | null; topics: string[]; skills: string[]; type: string; confidence: string; matchedTerms: string[] };
type MethodologyTask = "topic" | "content" | "analysis";
type MethodologyKind = "core_playbook" | "module" | "rule";
type MethodologyEntry = { id: string; title: string; task: MethodologyTask | "all"; kind: MethodologyKind; stage: string; platform: string; mode: string; risk: "low" | "medium" | "high"; version: string; instruction: string; requiredEvidence: string[]; keywords: string[]; source: { package: string; document: string; revision: string; note: string } };
type MethodologyGroup = { task: MethodologyTask; label: string; description: string; entries: MethodologyEntry[] };
type MethodologyCatalogResponse = {
  catalog: {
    id: string; name: string; version: string; entryCount: number;
    taskCounts: Record<MethodologyTask, number>;
    kindCounts: Record<MethodologyKind, number>;
    frameworks: {
      contentStrategyFamilyCount: number;
      contentHookTypeCount: number;
      analysisRubricDimensionCount: number;
      contentStrategyFamilies: Array<{ id: string; name: string; use: string }>;
      contentHookTypes: string[];
      analysisRubricDimensions: Array<{ id: string; name: string; evidence: string }>;
    };
  };
  groups: MethodologyGroup[];
  resultCount: number;
};

const categoryLabels: Record<string, string> = { brand_story: "品牌故事", founder: "创始人/出镜人", case_study: "成功案例", customer_question: "客户问题", sales_script: "销售话术", high_performing_copy: "历史优质文案", industry_term: "行业术语", compliance: "禁用词与合规", brand_voice: "品牌语气", client_preference: "客户修改偏好", other: "其他" };
const sourceLabels: Record<string, string> = { manual: "人工录入", document: "客户资料", url: "网页来源", client_feedback: "客户反馈", analysis: "分析沉淀" };
const AUTHORIZED_METHOD_LIBRARY_VISIBLE = false;

function splitList(value: FormDataEntryValue | null) { return String(value || "").split(/[，,\n]/).map((item) => item.trim()).filter(Boolean); }
function equalTopicMix(pillars: string[]) { const base = pillars.length ? Math.floor(100 / pillars.length) : 0; const remainder = 100 - base * pillars.length; return pillars.map((pillar, index) => ({ pillar, ratio: base + (index < remainder ? 1 : 0) })); }
const dateLabel = (value: string | null) => formatClientDate(value, "date");

const methodologyTaskLabels: Record<MethodologyTask, { title: string; caption: string }> = {
  topic: { title: "选题规划", caption: "先确定受众、问题和内容目标" },
  content: { title: "内容生成", caption: "再组织钩子、结构和口播表达" },
  analysis: { title: "视频诊断", caption: "最后用时间码和画面证据复盘" },
};
const methodologyKindLabels: Record<MethodologyKind, string> = { core_playbook: "核心流程", module: "方法模块", rule: "强制门禁" };
const methodologyStageLabels: Record<string, string> = { routing: "任务路由", planning: "规划", hook: "开头", structure: "结构", drafting: "成稿", evidence: "证据", diagnosis: "诊断", verification: "验收" };

function MethodTaskIcon({ task }: { task: MethodologyTask }) {
  if (task === "topic") return <Lightbulb aria-hidden="true" />;
  if (task === "analysis") return <Video aria-hidden="true" />;
  return <Workflow aria-hidden="true" />;
}

function MethodologyCard({ entry }: { entry: MethodologyEntry }) {
  return <article className={`methodology-card kind-${entry.kind}`}>
    <header><span>{methodologyKindLabels[entry.kind]} · {methodologyStageLabels[entry.stage] || entry.stage}</span><em>{entry.risk === "high" ? "严格约束" : entry.risk === "medium" ? "需核验" : "通用"}</em></header>
    <h4>{entry.title}</h4><p>{entry.instruction}</p>
    <details><summary>查看证据要求与来源</summary><div className="methodology-card-detail"><section><strong>执行前需要</strong><ul>{entry.requiredEvidence.map((item) => <li key={item}>{item}</li>)}</ul></section><section><strong>适用范围</strong><p>{entry.platform === "all" ? "全平台" : entry.platform} · {entry.mode === "all" ? "全部模式" : entry.mode} · v{entry.version}</p></section><small>{entry.source.package} / {entry.source.document}<br />修订 {entry.source.revision} · {entry.source.note}</small><code>{entry.id}</code></div></details>
  </article>;
}

function MethodologyTrack({ group }: { group: MethodologyGroup }) {
  const core = group.entries.filter((entry) => entry.kind === "core_playbook");
  const modules = group.entries.filter((entry) => entry.kind === "module");
  const rules = group.entries.filter((entry) => entry.kind === "rule");
  return <section className={`methodology-track task-${group.task}`}>
    <header className="methodology-track-heading"><span className="methodology-track-icon"><MethodTaskIcon task={group.task} /></span><div><p>{methodologyTaskLabels[group.task].caption}</p><h3>{methodologyTaskLabels[group.task].title}</h3><small>{group.description}</small></div><em>{group.entries.length} 项方法</em></header>
    {core.length > 0 && <div className="methodology-core-row">{core.map((entry) => <MethodologyCard key={entry.id} entry={entry} />)}</div>}
    {modules.length > 0 && <section className="methodology-method-section"><header><strong>本环节的方法模块</strong><span>{modules.length} 项</span></header><div className="methodology-card-grid">{modules.map((entry) => <MethodologyCard key={entry.id} entry={entry} />)}</div></section>}
    {rules.length > 0 && <section className="methodology-method-section rules"><header><strong>不可跳过的质量门禁</strong><span>{rules.length} 项</span></header><div className="methodology-card-grid">{rules.map((entry) => <MethodologyCard key={entry.id} entry={entry} />)}</div></section>}
  </section>;
}

function KnowledgeCard({ item, canManage, saving, action, onConfirm, onEdit, onArchive, onHistory }: {
  item: KnowledgeItem; canManage: boolean; saving: boolean; action: string;
  onConfirm: () => void; onEdit: (event: FormEvent<HTMLFormElement>) => void; onArchive: () => void; onHistory: () => void;
}) {
  const busy = Boolean(action);
  return <article className="knowledge-card">
    <div className="knowledge-card-head"><span>{categoryLabels[item.category] || item.category}</span><em className={`status ${item.status === "confirmed" ? "success" : "neutral"}`}>{item.status === "confirmed" ? "已确认" : item.status === "draft" ? "待确认" : "已归档"}</em></div>
    <h3>{item.title}</h3><p>{item.body}</p>
    <footer className="knowledge-card-footer"><span>{sourceLabels[item.source_type] || item.source_type} · v{item.current_version} · {dateLabel(item.updated_at)}</span><div className="knowledge-card-actions">
      {item.status === "draft" && canManage && <button className="knowledge-action-button confirm" type="button" disabled={busy} onClick={onConfirm}><Check aria-hidden="true" />{action.startsWith("confirm:") ? "确认中…" : "确认沉淀"}</button>}
      <button className="knowledge-action-button" type="button" disabled={busy} onClick={onHistory}><History aria-hidden="true" />{action.startsWith("history:") ? "读取中…" : "历史"}</button>
      {canManage && item.status !== "archived" && <><details className="knowledge-edit-menu"><summary className="knowledge-action-button"><PencilLine aria-hidden="true" />编辑</summary><form className="stack-form knowledge-edit-form" onSubmit={onEdit}><div className="knowledge-edit-heading"><strong>编辑新版本</strong><span>原版本会继续保留</span></div><label>标题<input name="title" defaultValue={item.title} required minLength={2} maxLength={120} /></label><label>分类<select name="category" defaultValue={item.category}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>正文<textarea name="body" defaultValue={item.body} required minLength={10} maxLength={20000} rows={5} /></label><label>来源<select name="sourceType" defaultValue={item.source_type}>{Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>来源说明<input name="sourceRef" defaultValue={item.source_ref || ""} maxLength={1000} /></label><label>变更说明<input name="changeSummary" defaultValue="编辑产生新版本" maxLength={500} /></label><button className="knowledge-editor-save" disabled={saving}><Save aria-hidden="true" />{saving ? "保存中…" : "保存新版本"}</button></form></details><button className="knowledge-action-button danger" type="button" disabled={busy} onClick={onArchive}><Archive aria-hidden="true" />{action.startsWith("archive:") ? "归档中…" : "归档"}</button></>}
    </div></footer>
  </article>;
}

function StrategyCard({ strategy, canManage = false, onActivate }: { strategy: Strategy; canManage?: boolean; onActivate?: () => void }) {
  return <article className={`panel strategy-card ${strategy.status}`}>
    <div className="panel-heading"><div><p className="section-kicker">策略 v{strategy.version}</p><h2>{strategy.name}</h2></div><span className={`status ${strategy.status === "active" ? "success" : "neutral"}`}>{strategy.status === "active" ? "当前启用" : strategy.status === "draft" ? "草稿" : "历史版本"}</span></div>
    <div className="strategy-body"><section><h3>账号定位</h3><p>{strategy.positioning}</p></section><section><h3>目标人群</h3><p>{strategy.target_audience}</p></section><section><h3>内容支柱</h3><div className="plain-chips">{strategy.pillars?.map((pillar) => <span key={pillar}>{pillar}</span>)}</div></section><section><h3>阶段目标</h3><ul>{strategy.objectives?.map((objective) => <li key={objective}>{objective}</li>)}</ul></section></div>
    <footer><span>{strategy.status === "active" ? `启用于 ${dateLabel(strategy.effective_from)}` : `更新于 ${dateLabel(strategy.updated_at)}`}</span>{strategy.status !== "active" && canManage && onActivate && <button type="button" onClick={onActivate}>启用此版本</button>}</footer>
  </article>;
}

export function KnowledgeWorkspace({ initialOrganizationId = "", initialProjectId = "" }: { initialOrganizationId?: string; initialProjectId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState(""); const [tab, setTab] = useState<"knowledge" | "strategy" | "method">("knowledge");
  const [items, setItems] = useState<KnowledgeItem[]>([]); const [strategies, setStrategies] = useState<Strategy[]>([]); const [canWrite, setCanWrite] = useState(false); const [canManage, setCanManage] = useState(false); const [knowledgeHistory, setKnowledgeHistory] = useState<KnowledgeVersion[] | null>(null);
  const [organizationRole, setOrganizationRole] = useState<"admin" | "member">("member"); const [strategyScope, setStrategyScope] = useState<"organization" | "project">("project"); const [strategySpaces, setStrategySpaces] = useState<StrategySpace[]>([]); const [strategyOverviewLoading, setStrategyOverviewLoading] = useState(false);
  const [knowledgeAction, setKnowledgeAction] = useState("");
  const importScope = `${organizationId}:${projectId}`;
  const [importState, setImportState] = useState<{ scope: string; preview: KnowledgeImportPreview | null; message: string }>({ scope: "", preview: null, message: "" });
  const knowledgeImportPreview = importState.scope === importScope ? importState.preview : null;
  const knowledgeImportMessage = importState.scope === importScope ? importState.message : "";
  const [knowledgeImportBusy, setKnowledgeImportBusy] = useState<"" | "reading" | "importing">("");
  function setKnowledgeImportPreview(value: KnowledgeImportPreview | null | ((current: KnowledgeImportPreview | null) => KnowledgeImportPreview | null)) {
    setImportState((current) => ({ scope: importScope, preview: typeof value === "function" ? value(current.scope === importScope ? current.preview : null) : value, message: current.scope === importScope ? current.message : "" }));
  }
  function setKnowledgeImportMessage(message: string) {
    setImportState((current) => ({ scope: importScope, preview: current.scope === importScope ? current.preview : null, message }));
  }
  const [methodSource, setMethodSource] = useState<MethodSource | null>(null); const [methodAtoms, setMethodAtoms] = useState<MethodAtom[]>([]); const [methodQuery, setMethodQuery] = useState(""); const [methodSearching, setMethodSearching] = useState(false); const [canTransferMethods, setCanTransferMethods] = useState(false); const [methodTransferring, setMethodTransferring] = useState(false);
  const [methodologyCatalog, setMethodologyCatalog] = useState<MethodologyCatalogResponse | null>(null); const [methodologyTask, setMethodologyTask] = useState<"all" | MethodologyTask>("all"); const [methodologyQuery, setMethodologyQuery] = useState("");
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState("");

  const loadWorkspace = useCallback(async (orgId: string, projId: string) => {
    if (!orgId || !projId) { setItems([]); setStrategies([]); setMethodSource(null); setMethodAtoms([]); setMethodologyCatalog(null); return; }
    const query = `organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`;
    const [knowledgeResponse, strategyResponse, methodResponse, methodologyResponse] = await Promise.all([
      scopedFetch(`/api/knowledge?${query}`),
      scopedFetch(`/api/strategies?${query}`),
      AUTHORIZED_METHOD_LIBRARY_VISIBLE ? scopedFetch(`/api/authorized-knowledge?${query}&metadataOnly=1`) : Promise.resolve(null),
      AUTHORIZED_METHOD_LIBRARY_VISIBLE ? scopedFetch(`/api/authorized-methodology?${query}`) : Promise.resolve(null),
    ]);
    if (!knowledgeResponse.ok) throw new Error(await readError(knowledgeResponse)); if (!strategyResponse.ok) throw new Error(await readError(strategyResponse));
    if (methodResponse && !methodResponse.ok) throw new Error(await readError(methodResponse)); if (methodologyResponse && !methodologyResponse.ok) throw new Error(await readError(methodologyResponse));
    const knowledge = await knowledgeResponse.json() as { items: KnowledgeItem[]; canWrite: boolean; canManage: boolean }; const strategy = await strategyResponse.json() as { strategies: Strategy[]; canWrite: boolean; canManage: boolean };
    setItems(knowledge.items); setStrategies(strategy.strategies); setCanWrite(knowledge.canWrite && strategy.canWrite); setCanManage(knowledge.canManage && strategy.canManage);
    if (methodResponse && methodologyResponse) {
      const method = await methodResponse.json() as { source: MethodSource | null; atoms: MethodAtom[]; canTransfer: boolean }; const methodology = await methodologyResponse.json() as MethodologyCatalogResponse;
      setMethodSource(method.source); setMethodAtoms(method.atoms); setCanTransferMethods(Boolean(method.canTransfer)); setMethodologyCatalog(methodology);
    } else {
      setMethodSource(null); setMethodAtoms([]); setCanTransferMethods(false); setMethodologyCatalog(null);
    }
  }, []);

  const loadStrategyOverview = useCallback(async (orgId: string) => {
    if (!orgId) { setStrategySpaces([]); return; }
    setStrategyOverviewLoading(true);
    try {
      const response = await scopedFetch(`/api/strategies?organizationId=${encodeURIComponent(orgId)}&scope=organization`);
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { spaces: StrategySpace[] }; setStrategySpaces(body.spaces);
    } finally { setStrategyOverviewLoading(false); }
  }, []);

  const loadProjects = useCallback(async (orgId: string, preferred = "") => {
    rememberCurrentScope(orgId, "");
    const response = await scopedFetch(`/api/projects?organizationId=${encodeURIComponent(orgId)}`); if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as { projects: Project[]; organizationRole: "admin" | "member" }; setProjects(body.projects); setOrganizationRole(body.organizationRole); setStrategyScope(body.organizationRole === "admin" ? "organization" : "project");
    if (body.organizationRole !== "admin") setStrategySpaces([]);
    const selected = preferredProjectId(body.projects, preferred); setProjectId(selected); rememberCurrentScope(orgId, selected);
    await Promise.all([loadWorkspace(orgId, selected), body.organizationRole === "admin" ? loadStrategyOverview(orgId) : Promise.resolve()]);
  }, [loadStrategyOverview, loadWorkspace]);

  useWorkspaceInitialization({ initialOrganizationId, initialProjectId, setOrganizations, setOrganizationId, loadProjects, setError, setLoading, failureMessage: "加载失败" });

  async function createKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); const formElement = event.currentTarget; const form = new FormData(formElement);
    const response = await scopedFetch("/api/knowledge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, title: form.get("title"), category: form.get("category"), body: form.get("body"), sourceType: form.get("sourceType"), sourceRef: form.get("sourceRef") }) });
    if (!response.ok) { setError(await readError(response)); setSaving(false); return; } const body = await response.json() as { item: KnowledgeItem }; setItems((current) => [body.item, ...current]); formElement.reset(); setSaving(false);
  }

  async function confirmKnowledge(itemId: string) {
    setKnowledgeAction(`confirm:${itemId}`); setError(""); try { const response = await scopedFetch(`/api/knowledge/${itemId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId }) });
      if (!response.ok) { setError(await readError(response)); return; } const body = await response.json() as { item: { status: string; confirmed_at: string } }; setItems((current) => current.map((item) => item.id === itemId ? { ...item, ...body.item } : item));
    } finally { setKnowledgeAction(""); }
  }

  async function editKnowledge(itemId: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); const formElement = event.currentTarget; const form = new FormData(formElement);
    const response = await scopedFetch(`/api/knowledge/${itemId}?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, title: form.get("title"), category: form.get("category"), body: form.get("body"), sourceType: form.get("sourceType"), sourceRef: form.get("sourceRef"), changeSummary: form.get("changeSummary") }) });
    if (!response.ok) { setError(await readError(response)); setSaving(false); return; }
    setSaving(false); await loadWorkspace(organizationId, projectId);
  }

  async function showKnowledgeHistory(itemId: string) {
    setKnowledgeAction(`history:${itemId}`); setError(""); try { const response = await scopedFetch(`/api/knowledge/${itemId}?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`);
      if (!response.ok) { setError(await readError(response)); return; } const body = await response.json() as { history: KnowledgeVersion[] }; setKnowledgeHistory(body.history);
    } finally { setKnowledgeAction(""); }
  }

  async function archiveKnowledge(itemId: string) {
    if (!window.confirm("确认归档这条品牌知识？历史版本保留，但新生成不再检索。")) return;
    setKnowledgeAction(`archive:${itemId}`); setError(""); try { const response = await scopedFetch(`/api/knowledge/${itemId}?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
      if (!response.ok) { setError(await readError(response)); return; } await loadWorkspace(organizationId, projectId);
    } finally { setKnowledgeAction(""); }
  }

  async function selectKnowledgeImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    setKnowledgeImportBusy("reading"); setKnowledgeImportMessage(""); setError("");
    try {
      if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("请选择 .xlsx 格式的品牌知识模板。");
      if (file.size > 5 * 1024 * 1024) throw new Error("品牌知识导入文件不能超过 5 MB。");
      const rawRows = await readFirstWorksheet(file) as Record<string, unknown>[];
      const validation = validateKnowledgeImportRows(rawRows);
      setKnowledgeImportPreview({ filename: file.name, rawRows, validCount: validation.rows.length, issues: validation.issues });
      setKnowledgeImportMessage(validation.rows.length ? `预检完成：${validation.rows.length} 条可以导入${validation.issues.length ? `，${validation.issues.length} 条需要修改` : ""}。` : "没有发现可导入的有效知识，请按问题提示修改 Excel。" );
    } catch (reason) { setKnowledgeImportPreview(null); setError(reason instanceof Error ? reason.message : "Excel 文件读取失败。"); }
    finally { setKnowledgeImportBusy(""); }
  }

  async function importKnowledgeWorkbook() {
    if (!knowledgeImportPreview?.validCount) return;
    setKnowledgeImportBusy("importing"); setKnowledgeImportMessage(""); setError("");
    try {
      const response = await scopedFetch("/api/knowledge/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, filename: knowledgeImportPreview.filename, rows: knowledgeImportPreview.rawRows }) });
      const body = await response.json().catch(() => null) as { importedCount?: number; rejectedCount?: number; issues?: KnowledgeImportIssue[]; error?: { message?: string } } | null;
      if (!response.ok) { if (body?.issues) setKnowledgeImportPreview((current) => current ? { ...current, issues: body.issues ?? current.issues } : current); throw new Error(body?.error?.message ?? "品牌知识批量导入失败。"); }
      setKnowledgeImportMessage(`已导入 ${body?.importedCount ?? 0} 条待确认知识${body?.rejectedCount ? `，跳过 ${body.rejectedCount} 条` : ""}。负责人确认后才会参与内容生成。`);
      setKnowledgeImportPreview(null); await loadWorkspace(organizationId, projectId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "品牌知识批量导入失败。"); }
    finally { setKnowledgeImportBusy(""); }
  }
  async function createStrategy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); const formElement = event.currentTarget; const form = new FormData(formElement);
    const pillars = splitList(form.get("pillars"));
    const response = await scopedFetch("/api/strategies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, name: form.get("name"), positioning: form.get("positioning"), persona: form.get("persona"), targetAudience: form.get("targetAudience"), painPoints: splitList(form.get("painPoints")), pillars, objectives: splitList(form.get("objectives")), cadence: form.get("cadence"), conversionPath: form.get("conversionPath"), styleNotes: form.get("styleNotes"), topicMix: equalTopicMix(pillars) }) });
    if (!response.ok) { setError(await readError(response)); setSaving(false); return; } const body = await response.json() as { strategy: Strategy }; setStrategies((current) => [body.strategy, ...current]); formElement.reset();
    try { if (organizationRole === "admin") await loadStrategyOverview(organizationId); } catch (reason) { setError(reason instanceof Error ? reason.message : "管理员策略总览刷新失败。"); } finally { setSaving(false); }
  }

  async function activateStrategy(strategyId: string) {
    setError(""); const response = await scopedFetch(`/api/strategies/${strategyId}/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId }) });
    if (!response.ok) { setError(await readError(response)); return; } const body = await response.json() as { strategy: { id: string; status: string; effective_from: string } }; setStrategies((current) => current.map((strategy) => strategy.id === strategyId ? { ...strategy, status: "active", effective_from: body.strategy.effective_from } : strategy.status === "active" ? { ...strategy, status: "retired" } : strategy));
    try { if (organizationRole === "admin") await loadStrategyOverview(organizationId); } catch (reason) { setError(reason instanceof Error ? reason.message : "管理员策略总览刷新失败。"); }
  }

  async function enterStrategySpace(spaceId: string) {
    setProjectId(spaceId); setStrategyScope("project"); rememberCurrentScope(organizationId, spaceId); await loadWorkspace(organizationId, spaceId);
  }

  async function searchMethodKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!organizationId || !projectId) return; setMethodSearching(true); setError("");
    try {
      const query = `organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(methodQuery)}`;
      const response = await scopedFetch(`/api/authorized-knowledge?${query}`); if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { source: MethodSource | null; atoms: MethodAtom[]; canTransfer: boolean }; setMethodSource(body.source); setMethodAtoms(body.atoms); setCanTransferMethods(Boolean(body.canTransfer));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "授权方法知识检索失败。"); }
    finally { setMethodSearching(false); }
  }

  async function exportMethodLibrary() {
    if (!organizationId || !canTransferMethods) return; setMethodTransferring(true); setError("");
    try {
      const response = await scopedFetch(`/api/authorized-knowledge/transfer?organizationId=${encodeURIComponent(organizationId)}`); if (!response.ok) throw new Error(await readError(response));
      const blob = await response.blob(); const href = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = href; anchor.download = `利明智耀授权方法库-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(href);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "授权方法库导出失败。"); }
    finally { setMethodTransferring(false); }
  }

  async function importMethodLibrary(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file || !organizationId || !canTransferMethods) return;
    setMethodTransferring(true); setError("");
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("方法库文件不能超过 20 MB。");
      const payload = JSON.parse(await file.text()) as Record<string, unknown>;
      const response = await scopedFetch("/api/authorized-knowledge/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, organizationId }) });
      if (!response.ok) throw new Error(await readError(response)); await loadWorkspace(organizationId, projectId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "授权方法库导入失败。"); }
    finally { setMethodTransferring(false); }
  }

  if (loading) return <div className="management-state" role="status">正在载入品牌知识空间…</div>;
  if (error && organizations.length === 0) return <div className="management-state error-state"><strong>暂时无法进入知识库</strong><p>{error}</p><small>请确认本地身份已启用，并先创建公司与企业空间。</small></div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><h2>请先创建企业空间</h2><p>品牌知识和内容策略必须归属于明确的企业空间。</p></div>;
  const normalizedMethodologyQuery = methodologyQuery.trim().toLocaleLowerCase("zh-CN");
  const visibleMethodologyGroups = (methodologyCatalog?.groups ?? []).filter((group) => methodologyTask === "all" || group.task === methodologyTask).map((group) => ({
    ...group,
    entries: normalizedMethodologyQuery ? group.entries.filter((entry) => [entry.title, entry.instruction, entry.id, ...entry.keywords, ...entry.requiredEvidence].join(" ").toLocaleLowerCase("zh-CN").includes(normalizedMethodologyQuery)) : group.entries,
  })).filter((group) => group.entries.length > 0);
  const isOrganizationAdmin = organizationRole === "admin";
  const overviewStrategyCount = strategySpaces.reduce((total, space) => total + space.strategies.length, 0);
  const activeStrategySpaceCount = strategySpaces.filter((space) => space.strategies.some((strategy) => strategy.status === "active")).length;

  return <div className="knowledge-workspace">
    <div className="management-toolbar knowledge-toolbar"><label>公司<select value={organizationId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setOrganizationId(id); await loadProjects(id); }, setError)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label><label>企业空间<select value={projectId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await loadWorkspace(organizationId, id); if (tab === "strategy") setStrategyScope("project"); }, setError)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><div className="segmented-control" aria-label="知识库视图"><button className={tab === "knowledge" ? "active" : ""} type="button" onClick={() => setTab("knowledge")}>品牌知识</button><button className={tab === "strategy" ? "active" : ""} type="button" onClick={() => { setTab("strategy"); if (isOrganizationAdmin) setStrategyScope("organization"); }}>内容策略</button>{AUTHORIZED_METHOD_LIBRARY_VISIBLE && <button className={tab === "method" ? "active" : ""} type="button" onClick={() => setTab("method")}>授权方法论</button>}</div></div>
    {error && <div className="inline-alert" role="alert">{error}</div>}
    {AUTHORIZED_METHOD_LIBRARY_VISIBLE && tab === "method" && methodologyCatalog && <section className="methodology-view">
      <header className="panel methodology-hero">
        <div className="methodology-hero-copy"><p className="section-kicker">授权方法论 · 目录 {methodologyCatalog.catalog.version}</p><h2>系统按任务选择方法，不把整库塞给模型</h2><span>方法只规定怎么策划、创作和诊断；客户事实来自品牌知识与项目记忆，视频判断仍然必须绑定转写、画面和时间码。</span><div className="methodology-flow-map" aria-label="方法论调用链">{(["topic", "content", "analysis"] as const).map((task, index) => <div key={task}><i><MethodTaskIcon task={task} /></i><span><strong>{methodologyTaskLabels[task].title}</strong><small>{methodologyTaskLabels[task].caption}</small></span>{index < 2 && <b aria-hidden="true" />}</div>)}</div></div>
        <dl><div><dt>业务方法链</dt><dd>3</dd><small>选题 · 生成 · 分析</small></div><div><dt>核心流程</dt><dd>{methodologyCatalog.catalog.kindCounts.core_playbook}</dd><small>每次任务选择一套</small></div><div><dt>方法模块</dt><dd>{methodologyCatalog.catalog.kindCounts.module}</dd><small>按场景组合调用</small></div><div><dt>质量门禁</dt><dd>{methodologyCatalog.catalog.kindCounts.rule}</dd><small>事实与证据不可跳过</small></div></dl>
      </header>

      <section className="panel methodology-command-bar"><div><p className="section-kicker">查看系统实际会调用的方法</p><div className="methodology-task-tabs" role="tablist" aria-label="方法论业务环节"><button className={methodologyTask === "all" ? "active" : ""} type="button" onClick={() => setMethodologyTask("all")}>全部方法 <span>{methodologyCatalog.catalog.entryCount}</span></button>{(["topic", "content", "analysis"] as const).map((task) => <button className={methodologyTask === task ? "active" : ""} type="button" key={task} onClick={() => setMethodologyTask(task)}>{methodologyTaskLabels[task].title} <span>{methodologyCatalog.catalog.taskCounts[task]}</span></button>)}</div></div><label><Search aria-hidden="true" /><input value={methodologyQuery} onChange={(event) => setMethodologyQuery(event.target.value)} maxLength={200} placeholder="搜索方法、执行规则或证据要求" /></label></section>

      {visibleMethodologyGroups.length ? <div className="methodology-tracks">{visibleMethodologyGroups.map((group) => <MethodologyTrack key={group.task} group={group} />)}</div> : <div className="empty-panel"><FileSearch aria-hidden="true" /><h2>没有匹配的方法论</h2><p>换一个更具体的关键词，或切换到全部方法。</p></div>}

      <section className="methodology-framework-library"><header><div><p className="section-kicker">已整理成可调用结构</p><h2>辅助框架</h2></div><span>框架用于选方法，不直接提供客户事实</span></header><div className="methodology-framework-grid">
        <article><header><Lightbulb aria-hidden="true" /><div><strong>{methodologyCatalog.catalog.frameworks.contentStrategyFamilyCount} 类内容策略</strong><span>决定从什么角度进入问题</span></div></header><ul className="strategy-family-list">{methodologyCatalog.catalog.frameworks.contentStrategyFamilies.map((item) => <li key={item.id}><strong>{item.name}</strong><span>{item.use}</span></li>)}</ul></article>
        <article><header><Workflow aria-hidden="true" /><div><strong>{methodologyCatalog.catalog.frameworks.contentHookTypeCount} 类安全钩子</strong><span>开头必须由正文兑现</span></div></header><div className="methodology-hook-cloud">{methodologyCatalog.catalog.frameworks.contentHookTypes.map((item) => <span key={item}>{item}</span>)}</div></article>
        <article><header><Video aria-hidden="true" /><div><strong>{methodologyCatalog.catalog.frameworks.analysisRubricDimensionCount} 维分析量表</strong><span>每个判断都对应证据类型</span></div></header><ul className="rubric-dimension-list">{methodologyCatalog.catalog.frameworks.analysisRubricDimensions.map((item) => <li key={item.id}><strong>{item.name}</strong><span>{item.evidence}</span></li>)}</ul></article>
      </div></section>

      <details className="panel methodology-source-vault"><summary><span><Database aria-hidden="true" /><span><strong>来源追溯与底层授权方法库</strong><small>{methodSource ? `${methodSource.item_count.toLocaleString()} 条原子 · 修订 ${methodSource.revision.slice(0, 7)} · ${dateLabel(methodSource.synced_at)} 同步` : "尚未同步底层授权来源"}</small></span></span><em>展开管理</em></summary><div className="methodology-source-body"><header><div><p>原子库用于补充方法出处和检索，不再作为这个页面的主体，也不会被整库直接送入模型。</p>{methodSource && <small>{methodSource.name} · 完整版本 {methodSource.revision}</small>}</div>{canTransferMethods && <div className="method-transfer-actions"><button type="button" disabled={methodTransferring || !methodSource} onClick={() => void exportMethodLibrary()}>导出方法库</button><label className={methodTransferring ? "disabled" : ""}>导入方法库<input type="file" accept="application/json,.json" disabled={methodTransferring} onChange={(event) => void importMethodLibrary(event)} /></label></div>}</header><form className="method-source-search" onSubmit={searchMethodKnowledge}><label><Search aria-hidden="true" /><input aria-label="搜索底层授权来源" value={methodQuery} onChange={(event) => setMethodQuery(event.target.value)} maxLength={500} placeholder="按业务问题检索底层来源" /></label><button disabled={methodSearching}>{methodSearching ? "检索中…" : "检索来源"}</button></form>{methodAtoms.length ? <div className="method-knowledge-results compact">{methodAtoms.map((atom) => <article key={atom.id}><div><span>{atom.type} · {atom.confidence === "high" ? "高置信度" : atom.confidence === "medium" ? "中置信度" : "低置信度"}</span><em>{atom.id}</em></div><h3>{atom.knowledge}</h3><details><summary>查看授权原文与来源</summary><p>{atom.original}</p>{atom.url && <a href={atom.url} target="_blank" rel="noreferrer">打开来源 ↗</a>}</details><footer>{atom.topics.map((topic) => <span key={topic}>{topic}</span>)}</footer></article>)}</div> : <div className="list-empty">{methodQuery.trim() ? "没有匹配的底层来源。" : "输入具体业务问题后检索对应的授权来源。"}</div>}</div></details>
    </section>}
    <div style={{ display: tab === "knowledge" || tab === "strategy" ? "contents" : "none" }}>
    {knowledgeHistory && <aside className="panel knowledge-history-panel" role="dialog" aria-label="知识版本历史"><div className="panel-heading"><div><p className="section-kicker">只读版本记录</p><h2>知识版本历史</h2></div><button type="button" onClick={() => setKnowledgeHistory(null)}>关闭</button></div>{knowledgeHistory.length ? <ol className="knowledge-history-list">{knowledgeHistory.map((version) => <li key={version.version}><div><strong>v{version.version}</strong><span>{dateLabel(version.created_at)} · {sourceLabels[version.source_type] || version.source_type}</span></div><p>{version.body}</p>{version.change_summary && <small>{version.change_summary}</small>}</li>)}</ol> : <div className="list-empty">暂无历史版本。</div>}</aside>}
    {tab === "knowledge" ? <div className="knowledge-layout">
      <section className="panel knowledge-list-panel"><div className="panel-heading"><div><p className="section-kicker">已确认知识才参与生成</p><h2>{items.filter((item) => item.status === "confirmed").length} 条正式知识 · {items.filter((item) => item.status === "draft").length} 条待确认</h2></div></div>{items.length ? <div className="knowledge-list">{items.map((item) => <KnowledgeCard key={item.id} item={item} canManage={canManage} saving={saving} action={knowledgeAction.endsWith(item.id) ? knowledgeAction : ""} onConfirm={() => void confirmKnowledge(item.id)} onEdit={(event) => void editKnowledge(item.id, event)} onArchive={() => void archiveKnowledge(item.id)} onHistory={() => void showKnowledgeHistory(item.id)} />)}</div> : <div className="list-empty">先录入品牌故事、案例、客户问题、语气或合规要求。</div>}</section>
      {canWrite && <aside className="create-panel knowledge-create">
        <section className="knowledge-bulk-import"><header><div><p className="section-kicker">Excel 批量导入</p><h2>一次录入多条品牌知识</h2></div><a href="/templates/品牌知识库导入模板.xlsx" download><Download aria-hidden="true" />下载模板</a></header>
          <label className={`knowledge-import-drop${knowledgeImportPreview ? " has-file" : ""}`}><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={Boolean(knowledgeImportBusy)} onChange={(event) => void selectKnowledgeImport(event)} />{knowledgeImportPreview ? <FileSpreadsheet aria-hidden="true" /> : <UploadCloud aria-hidden="true" />}<span><strong>{knowledgeImportBusy === "reading" ? "正在读取 Excel…" : knowledgeImportPreview?.filename || "选择填写好的 Excel"}</strong><small>{knowledgeImportPreview ? `${knowledgeImportPreview.validCount} 条有效 · ${knowledgeImportPreview.issues.length} 条需修改` : "单次最多 100 条，导入后统一进入待确认"}</small></span></label>
          {knowledgeImportPreview?.issues.length ? <details className="knowledge-import-issues"><summary><AlertTriangle aria-hidden="true" />查看 {knowledgeImportPreview.issues.length} 个问题</summary><ul>{knowledgeImportPreview.issues.slice(0, 8).map((issue, index) => <li key={`${issue.rowNumber}-${index}`}>{issue.rowNumber ? `第 ${issue.rowNumber} 行：` : ""}{issue.message}</li>)}</ul>{knowledgeImportPreview.issues.length > 8 && <small>其余问题请修改后重新上传预检。</small>}</details> : null}
          {knowledgeImportMessage && <p className="knowledge-import-message" role="status">{knowledgeImportMessage}</p>}
          {knowledgeImportPreview && <button className="knowledge-import-submit" type="button" disabled={!knowledgeImportPreview.validCount || Boolean(knowledgeImportBusy)} onClick={() => void importKnowledgeWorkbook()}><UploadCloud aria-hidden="true" />{knowledgeImportBusy === "importing" ? "正在导入…" : `导入 ${knowledgeImportPreview.validCount} 条有效知识`}</button>}
        </section>
        <div className="knowledge-create-divider"><span>或逐条录入</span></div>
        <p className="section-kicker">新增知识草稿</p><h2>保留来源，再由负责人确认</h2><form className="stack-form" onSubmit={createKnowledge}><label>标题<input name="title" required minLength={2} maxLength={120} /></label><div className="form-row"><label>分类<select name="category" defaultValue="brand_story">{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>来源<select name="sourceType" defaultValue="manual">{Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><label>知识正文<textarea name="body" required minLength={10} maxLength={20000} rows={7} /></label><label>来源说明或链接<input name="sourceRef" maxLength={1000} placeholder="文件名、网页链接或反馈记录" /></label><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "保存为待确认知识"}</button></form>
      </aside>}
    </div> : <>
      {isOrganizationAdmin && <section className="panel strategy-scope-bar"><div><p className="section-kicker">管理员策略视图</p><strong>{activeStrategySpaceCount} / {strategySpaces.length} 个企业空间已启用策略</strong><span>共 {overviewStrategyCount} 个策略版本，可集中检查各空间的定位与阶段目标。</span></div><div className="segmented-control" aria-label="内容策略查看范围"><button className={strategyScope === "organization" ? "active" : ""} type="button" onClick={() => setStrategyScope("organization")}>全部企业空间</button><button className={strategyScope === "project" ? "active" : ""} type="button" onClick={() => setStrategyScope("project")}>当前企业空间</button></div></section>}
      {isOrganizationAdmin && strategyScope === "organization" ? <section className="strategy-overview" aria-label="全部企业空间内容策略">
        {strategyOverviewLoading ? <div className="management-state" role="status">正在汇总全部企业空间的内容策略…</div> : strategySpaces.length ? strategySpaces.map((space) => {
          const activeStrategy = space.strategies.find((strategy) => strategy.status === "active");
          return <section className="strategy-space-group" key={space.id}><header><div><p className="section-kicker">企业空间 · {space.status === "active" ? "运行中" : space.status === "paused" ? "已暂停" : space.status === "archived" ? "已归档" : "筹备中"}</p><h2>{space.name}</h2><span>{activeStrategy ? `当前启用：${activeStrategy.name}` : space.strategies.length ? "已有策略版本，但尚未启用" : "尚未建立内容策略"}</span></div>{space.status !== "archived" && <button type="button" onClick={() => void enterStrategySpace(space.id)}>进入空间管理</button>}</header>{space.strategies.length ? <div className="strategy-list">{space.strategies.map((strategy) => <StrategyCard key={strategy.id} strategy={strategy} />)}</div> : <div className="strategy-space-empty"><strong>暂无策略</strong><span>{space.status === "archived" ? "该空间已归档，仅保留历史策略供管理员查阅。" : "进入该企业空间后创建第一版账号定位、目标人群和内容支柱。"}</span></div>}</section>;
        }) : <div className="empty-panel"><h2>还没有企业空间</h2><p>创建企业空间后，管理员可以在这里集中查看全部内容策略。</p></div>}
      </section> : <div className="strategy-layout"><section className="strategy-list">{strategies.length ? strategies.map((strategy) => <StrategyCard key={strategy.id} strategy={strategy} canManage={canManage} onActivate={() => void activateStrategy(strategy.id)} />) : <div className="empty-panel"><span aria-hidden="true">⌁</span><h2>还没有内容策略</h2><p>建立第一版账号定位、目标人群、内容支柱和阶段目标。</p></div>}</section>{canWrite && <aside className="create-panel strategy-create"><p className="section-kicker">新策略版本</p><h2>创建后先保存为草稿</h2><form className="stack-form" onSubmit={createStrategy}><label>版本名称<input name="name" required minLength={2} maxLength={100} placeholder="例如：专业管理顾问增长策略" /></label><label>账号定位<textarea name="positioning" required minLength={5} rows={3} /></label><label>人设定位<input name="persona" maxLength={1000} /></label><label>目标人群<textarea name="targetAudience" required minLength={2} rows={2} /></label><label>用户痛点（逗号分隔）<textarea name="painPoints" required rows={2} /></label><label>内容支柱（逗号分隔）<input name="pillars" required /></label><label>阶段目标（逗号分隔）<textarea name="objectives" required rows={2} /></label><div className="form-row"><label>更新频率<input name="cadence" placeholder="每周 3 条" /></label><label>转化路径<input name="conversionPath" /></label></div><label>内容风格<textarea name="styleNotes" rows={2} /></label><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "创建策略草稿"}</button></form></aside>}</div>}
    </>}
    </div>
  </div>;
}
