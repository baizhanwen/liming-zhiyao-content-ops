"use client";
import { runScopedAction } from "../lib/client-scope";
import { useWorkspaceInitialization } from "./useWorkspaceInitialization";
import { loadClientProjects } from "../lib/client-scope";
import { readApiError as readError } from "../lib/client-format";
import { isScopeCancellation } from "../lib/client-scope-request";


import { TopicReferenceControls } from "./TopicReferenceControls";
import type { TopicBackground, TopicReferenceRecommendation, TopicSourcePreview } from "../lib/topic-reference-policy";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { rememberCurrentScope, scopedFetch } from "../lib/client-scope";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type Topic = { id: string; title: string; angle: string | null; source_type: string; source_ref: string | null; pillar: string | null; audience: string | null; objective: string | null; hook: string | null; rationale: string | null; priority: number; status: string; created_at: string };
type Citation = { id: string; topic_id: string; citation_type: string; citation_id: string; quote: string | null };
type KnowledgeItem = { id: string; title: string; status: string; category: string };
type GeneratedField = "angle" | "pillar" | "priority" | "audience" | "objective" | "hook" | "rationale";

const sourceLabels: Record<string, string> = { manual: "人工策划", knowledge: "品牌知识", video_analysis: "视频分析", performance: "历史表现", trend: "行业热点", comment: "评论需求", project_assistant: "灵感对话" };
const knowledgeCategoryLabels: Record<string, string> = { brand_story: "品牌故事", founder: "创始人/出镜人", case_study: "成功案例", customer_question: "客户问题", sales_script: "销售话术", high_performing_copy: "优质文案", industry_term: "行业术语", compliance: "合规红线", brand_voice: "品牌语气", client_preference: "修改偏好", other: "其他" };
const generatedFields: GeneratedField[] = ["angle", "pillar", "priority", "audience", "objective", "hook", "rationale"];
const generatedFieldLabels: Record<GeneratedField, string> = { angle: "切入角度", pillar: "内容支柱", priority: "优先级", audience: "目标人群", objective: "内容目标", hook: "开场钩子", rationale: "选题理由" };


export function TopicWorkspace({ initialOrganizationId = "", initialProjectId = "", sourceVideoId = "" }: { initialOrganizationId?: string; initialProjectId?: string; sourceVideoId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState(""); const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [topics, setTopics] = useState<Topic[]>([]); const [citations, setCitations] = useState<Citation[]>([]); const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]); const [canWrite, setCanWrite] = useState(false); const [canDelete, setCanDelete] = useState(false);
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const [movingTopicId, setMovingTopicId] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<Topic | null>(null); const [deleteConfirmation, setDeleteConfirmation] = useState(""); const [deletingTopicId, setDeletingTopicId] = useState("");
  const [accountBackground, setAccountBackground] = useState<TopicBackground | null>(null);
  const [includeSourceVideo, setIncludeSourceVideo] = useState(true);
  const [sourcesUsed, setSourcesUsed] = useState<TopicSourcePreview[] | null>(null);
  const [recommendations, setRecommendations] = useState<{ query: string; items: TopicReferenceRecommendation[] } | null>(null);
  const [recommending, setRecommending] = useState(false);
  const generatedValues = useRef<Partial<Record<GeneratedField, string>>>({});
  const [linkedVideoScope, setLinkedVideoScope] = useState("");
  const activeSourceVideoId = includeSourceVideo && linkedVideoScope === organizationId + ":" + projectId ? sourceVideoId : "";
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [generatingFields, setGeneratingFields] = useState<GeneratedField[]>([]); const [generationMessage, setGenerationMessage] = useState(""); const topicFormRef = useRef<HTMLFormElement>(null); const deleteConfirmationInputRef = useRef<HTMLInputElement>(null);

  const loadWorkspace = useCallback(async (orgId: string, projId: string) => {
    if (orgId && projId) setLinkedVideoScope(current => current || orgId + ":" + projId);
    setAccountBackground(null); setIncludeSourceVideo(true); setSourcesUsed(null); setRecommendations(null); setRecommending(false); setGenerationMessage(""); generatedValues.current = {}; topicFormRef.current?.reset();
    setSelectedKnowledgeIds([]); setDeleteCandidate(null); setDeleteConfirmation(""); if (!orgId || !projId) return; const query = `organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`;
    const [topicResponse, knowledgeResponse] = await Promise.all([scopedFetch(`/api/topics?${query}`), scopedFetch(`/api/knowledge?${query}`)]);
    if (!topicResponse.ok) throw new Error(await readError(topicResponse)); if (!knowledgeResponse.ok) throw new Error(await readError(knowledgeResponse));
    const topicBody = await topicResponse.json() as { topics: Topic[]; citations: Citation[]; canWrite: boolean; canDelete: boolean; accountBackground: TopicBackground | null }; const knowledgeBody = await knowledgeResponse.json() as { items: KnowledgeItem[] };
    setAccountBackground(topicBody.accountBackground); setTopics(topicBody.topics); setCitations(topicBody.citations); setCanWrite(topicBody.canWrite); setCanDelete(topicBody.canDelete); setKnowledge(knowledgeBody.items.filter((item) => item.status === "confirmed"));
  }, []);
  const loadProjects = useCallback(async (orgId: string, preferred = "") => {
    const body = await loadClientProjects<Project>(orgId, preferred); setProjects(body.projects); const selected = body.selected; setProjectId(selected); rememberCurrentScope(orgId, selected); await loadWorkspace(orgId, selected); }, [loadWorkspace]);
  useWorkspaceInitialization({ initialOrganizationId, initialProjectId, setOrganizations, setOrganizationId, loadProjects, setError, setLoading, failureMessage: "加载失败" });
  useEffect(() => { if (deleteCandidate) deleteConfirmationInputRef.current?.focus(); }, [deleteCandidate]);
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id.startsWith("topic-")) document.getElementById(id)?.scrollIntoView({ block: "center" });
  }, [topics]);

  async function createTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); const formElement = event.currentTarget; const form = new FormData(formElement); const sourceKnowledgeItemIds = selectedKnowledgeIds;
    const priority = String(form.get("priority") || "").trim();
    const response = await scopedFetch("/api/topics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, sourceVideoId: activeSourceVideoId, sourceKnowledgeItemIds, title: form.get("title"), angle: form.get("angle"), pillar: form.get("pillar"), audience: form.get("audience"), objective: form.get("objective"), hook: form.get("hook"), rationale: form.get("rationale"), priority: priority ? Number(priority) : 50 }) });
    if (!response.ok) { setError(await readError(response)); setSaving(false); return; } const body = await response.json() as { topic: Topic; citation: Citation | null; citations?: Citation[] }; const createdCitations = body.citations ?? (body.citation ? [body.citation] : []); setTopics((current) => [body.topic, ...current]); if (createdCitations.length) setCitations((current) => [...createdCitations, ...current]); formElement.reset(); setSourcesUsed(null); setRecommendations(null); generatedValues.current = {}; setSelectedKnowledgeIds([]); setGenerationMessage(""); setSaving(false);
  }

  async function moveTopicToProduction(topic: Topic) {
    const destination = `/content?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&topicId=${encodeURIComponent(topic.id)}`;
    if (topic.status === "drafting") { window.location.assign(destination); return; }
    setMovingTopicId(topic.id); setError("");
    try {
      const response = await scopedFetch("/api/content-items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, topicId: topic.id }) });
      if (!response.ok) throw new Error(await readError(response));
      const created = await response.json() as { item: { id: string } };
      setTopics((current) => current.map((item) => item.id === topic.id ? { ...item, status: "drafting" } : item));
      // Both entry points generate an actual draft; failures remain visible in production.
      await scopedFetch(`/api/content-items/${created.item.id}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, writingIntent: "auto", creationMode: "standard", benchmarkEntryIds: [], recommendedBenchmarkIds: [] }) });
      window.location.assign(destination);
    } catch (reason) { if (!isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "选题进入内容生产失败，请稍后重试。"); setMovingTopicId(""); }
  }

  function closeDeleteConfirmation() {
    if (deletingTopicId) return;
    setDeleteCandidate(null); setDeleteConfirmation("");
  }

  async function deleteTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!deleteCandidate || deleteConfirmation.trim() !== deleteCandidate.title) return;
    const topic = deleteCandidate; setDeletingTopicId(topic.id); setError("");
    try {
      const response = await scopedFetch("/api/topics", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, topicId: topic.id, confirmationTitle: deleteConfirmation }) });
      if (!response.ok) throw new Error(await readError(response));
      setTopics((current) => current.filter((item) => item.id !== topic.id));
      setCitations((current) => current.filter((citation) => citation.topic_id !== topic.id));
      setDeleteCandidate(null); setDeleteConfirmation("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除选题失败，请稍后重试。"); }
    finally { setDeletingTopicId(""); }
  }

  function formValue(name: string) {
    const element = topicFormRef.current?.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    return element?.value?.trim() ?? "";
  }

  async function generateTopicFields(targets: GeneratedField[]) {
    if (!targets.length || !topicFormRef.current) return;
    const title = formValue("title");
    if (title.length < 2) { setError("请先填写选题标题，再使用 AI 补全。"); const titleInput = topicFormRef.current.elements.namedItem("title"); if (titleInput instanceof HTMLElement) titleInput.focus(); return; }
    setGeneratingFields(targets); setGenerationMessage(""); setError("");
    try {
      const draft = { title, angle: formValue("angle"), pillar: formValue("pillar"), priority: formValue("priority"), audience: formValue("audience"), objective: formValue("objective"), hook: formValue("hook"), rationale: formValue("rationale") };
      const response = await scopedFetch("/api/topics/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, sourceVideoId: activeSourceVideoId, sourceKnowledgeItemIds: selectedKnowledgeIds, draft, targets }) });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { generated: Partial<Record<GeneratedField, string | number>>; sourcesUsed: TopicSourcePreview[] };
      setSourcesUsed(body.sourcesUsed);
      for (const field of targets) {
        const element = topicFormRef.current?.elements.namedItem(field) as HTMLInputElement | HTMLTextAreaElement | null;
        if (element && body.generated[field] !== undefined) { element.value = String(body.generated[field]); generatedValues.current[field] = element.value; }
      }
      const baseMessage = targets.length === 1 ? `${generatedFieldLabels[targets[0]]}已重新生成，你可以直接修改或再次生成。` : `已补全 ${targets.length} 项空白内容，原有内容保持不变。`;
      setGenerationMessage(`${baseMessage} 已列出本次实际使用的来源，可展开核对。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "选题内容生成失败，请稍后再试。"); }
    finally { setGeneratingFields([]); }
  }

  async function recommendReferences() {
    const query = formValue("title");
    if (query.length < 2) { setError("请先填写选题标题。"); return; }
    setRecommending(true); setError("");
    try {
      const params = new URLSearchParams({ organizationId, projectId, query });
      const response = await scopedFetch("/api/topics/references?" + params);
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { query: string; recommendations: TopicReferenceRecommendation[] };
      if (formValue("title") === query) setRecommendations({ query: body.query, items: body.recommendations });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "推荐参考加载失败。"); }
    finally { setRecommending(false); }
  }

  function clearGeneratedFields() {
    for (const field of generatedFields) {
      const element = topicFormRef.current?.elements.namedItem(field) as HTMLInputElement | HTMLTextAreaElement | null;
      if (element && element.value === generatedValues.current[field]) element.value = "";
    }
    generatedValues.current = {}; setSourcesUsed(null);
    setGenerationMessage("已清空未手动修改的补全内容；你输入或修改过的内容仍保留，请核对后重新生成。");
  }

  function generateEmptyTopicFields() {
    const empty = generatedFields.filter((field) => !formValue(field));
    if (!empty.length) { setGenerationMessage("所有内容都已填写。如需调整，请点击对应字段旁的“单独生成”。"); return; }
    void generateTopicFields(empty);
  }

  function fieldGenerateButton(field: GeneratedField) {
    const busy = generatingFields.length > 0;
    return <button type="button" disabled={busy || saving} onClick={() => void generateTopicFields([field])}>{generatingFields.includes(field) ? "生成中…" : "单独生成"}</button>;
  }

  function toggleKnowledge(itemId: string) {
    if (selectedKnowledgeIds.includes(itemId)) { setSelectedKnowledgeIds((current) => current.filter((id) => id !== itemId)); return; }
    if (selectedKnowledgeIds.length >= 20) { setError("一次最多引用 20 条品牌知识。"); return; }
    setError(""); setSelectedKnowledgeIds((current) => [...current, itemId]);
  }

  if (loading) return <div className="management-state" role="status">正在载入选题中心…</div>;
  if (error && organizations.length === 0) return <div className="management-state error-state"><strong>暂时无法进入选题中心</strong><p>{error}</p><small>请确认本地身份已启用，并先创建公司与企业空间。</small></div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><h2>请先创建企业空间</h2><p>选题必须归属于明确的企业空间。</p></div>;
  return <div className="topic-workspace"><div className="management-toolbar topic-toolbar"><label>公司<select value={organizationId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setOrganizationId(id); await loadProjects(id); }, setError)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label><label>企业空间<select value={projectId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await loadWorkspace(organizationId, id); }, setError)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><span>{topics.length} 个选题</span></div>{error && <div className="inline-alert" role="alert">{error}</div>}
    <div className="topic-layout"><section className="panel topic-list-panel"><div className="panel-heading"><div><p className="section-kicker">复用方法，不做近义词洗稿</p><h2>选题池</h2></div></div>{topics.length ? <div className="topic-list">{topics.map((topic) => { const topicCitations = citations.filter((citation) => citation.topic_id === topic.id); return <article key={topic.id} id={"topic-" + topic.id}><div className="topic-card-head"><span className="topic-priority">P{topic.priority}</span><span className="status neutral">{topic.status === "idea" ? "想法" : topic.status === "selected" ? "已入选" : topic.status === "drafting" ? "生产中" : "已归档"}</span></div><h3>{topic.title}</h3>{topic.angle && <p>{topic.angle}</p>}<dl><div><dt>内容支柱</dt><dd>{topic.pillar || "待归类"}</dd></div><div><dt>目标人群</dt><dd>{topic.audience || "待补充"}</dd></div><div><dt>内容目标</dt><dd>{topic.objective || "待补充"}</dd></div></dl>{topic.source_type === "project_assistant" && <details className="topic-inspiration-sources"><summary>选题理由与参考来源</summary><p>{topic.rationale}</p>{topicCitations.map((citation) => <p key={citation.id}>{citation.quote || "已保留对标来源"}</p>)}{!topicCitations.length && <p>通用创意建议，未引用对标素材。</p>}{topic.source_ref && <a href={"/inspiration?organizationId=" + encodeURIComponent(organizationId) + "&projectId=" + encodeURIComponent(projectId) + "&conversationId=" + encodeURIComponent(topic.source_ref)}>查看原灵感对话 →</a>}</details>}<footer><div><span>{sourceLabels[topic.source_type] || topic.source_type}</span>{topicCitations.length > 0 && <em title={topicCitations[0].quote || "已保留来源"}>已保留 {topicCitations.length} 条参考</em>}</div><div className="topic-card-actions">{canDelete && <button className="topic-delete-button" type="button" onClick={() => { setError(""); setDeleteCandidate(topic); setDeleteConfirmation(""); }}>删除</button>}{topic.status !== "archived" && (canWrite || topic.status === "drafting") && <button type="button" disabled={movingTopicId === topic.id} onClick={() => void moveTopicToProduction(topic)}>{movingTopicId === topic.id ? "正在生成口播稿…" : topic.status === "drafting" ? "继续生产 →" : "进入生产 →"}</button>}</div></footer></article>; })}</div> : <div className="list-empty">从品牌知识、视频分析或人工策划创建第一个选题。</div>}</section>
      {canWrite && <aside className="create-panel topic-create">
        <p className="section-kicker">新选题</p><h2>{sourceVideoId ? "从视频分析转为选题" : "加入项目选题池"}</h2>
        {sourceVideoId && <div className="source-banner"><strong>已关联分析结果</strong><span>创建时会由服务端确认该视频属于当前项目。</span></div>}
        <form ref={topicFormRef} className="stack-form" onSubmit={createTopic}>
          <label htmlFor="topic-title" aria-label="选题标题"><span className="topic-field-heading"><span>选题标题</span><em className="topic-required-note">必填</em></span><input id="topic-title" name="title" required minLength={2} maxLength={160} placeholder="明确讲什么，而不是宽泛关键词" onChange={() => setRecommendations(null)} /></label>
          <fieldset className="topic-knowledge-picker" disabled={generatingFields.length > 0 || saving}><legend><span>引用品牌知识</span><em>可多选 · 已选 {selectedKnowledgeIds.length} 条</em></legend><div className="topic-knowledge-actions"><span>只有勾选的知识参与补全；未勾选不会自动引用</span><div><button type="button" disabled={!knowledge.length || selectedKnowledgeIds.length === Math.min(knowledge.length, 20)} onClick={() => { setError(""); setSelectedKnowledgeIds(knowledge.slice(0, 20).map((item) => item.id)); }}>全选</button><button type="button" disabled={!selectedKnowledgeIds.length} onClick={() => setSelectedKnowledgeIds([])}>清空</button></div></div>{knowledge.length ? <div className="topic-knowledge-options">{knowledge.map((item) => { const inputId = `topic-knowledge-${item.id}`; return <label className="topic-knowledge-option" htmlFor={inputId} aria-label={item.title} key={item.id}><input id={inputId} type="checkbox" name="sourceKnowledgeItemIds" value={item.id} checked={selectedKnowledgeIds.includes(item.id)} onChange={() => toggleKnowledge(item.id)} /><span><strong>{item.title}</strong><small>{knowledgeCategoryLabels[item.category] || item.category}</small></span></label>; })}</div> : <p className="topic-knowledge-empty">还没有已确认的品牌知识。</p>}</fieldset>
          <TopicReferenceControls background={accountBackground} videoAvailable={Boolean(sourceVideoId && linkedVideoScope === organizationId + ":" + projectId)} includeVideo={includeSourceVideo} onVideoChange={setIncludeSourceVideo} selected={knowledge.filter(item => selectedKnowledgeIds.includes(item.id))} recommendations={recommendations} recommending={recommending} busy={generatingFields.length > 0 || saving} onRecommend={() => void recommendReferences()} onAdd={toggleKnowledge} sources={sourcesUsed} onClearGenerated={clearGeneratedFields} />
          <div className="topic-ai-toolbar"><div><strong>AI 智能补全</strong><span>只填写空白项，不覆盖你已经输入的内容</span></div><button type="button" disabled={generatingFields.length > 0 || saving} onClick={generateEmptyTopicFields}>{generatingFields.length > 1 ? `正在补全 ${generatingFields.length} 项…` : "一键补全空白内容"}</button></div>
          {generationMessage && <p className="topic-generation-message" role="status">{generationMessage}</p>}
          <label><span className="topic-field-heading"><span>切入角度</span>{fieldGenerateButton("angle")}</span><textarea name="angle" rows={3} maxLength={2000} /></label>
          <div className="form-row"><label><span className="topic-field-heading"><span>内容支柱</span>{fieldGenerateButton("pillar")}</span><input name="pillar" maxLength={200} /></label><label><span className="topic-field-heading"><span>优先级</span>{fieldGenerateButton("priority")}</span><input name="priority" type="number" min={0} max={100} placeholder="不填写默认 50" /></label></div>
          <label><span className="topic-field-heading"><span>目标人群</span>{fieldGenerateButton("audience")}</span><input name="audience" maxLength={1000} /></label>
          <label><span className="topic-field-heading"><span>内容目标</span>{fieldGenerateButton("objective")}</span><input name="objective" maxLength={1000} placeholder="涨粉、收藏、咨询或建立认知" /></label>
          <label><span className="topic-field-heading"><span>开场钩子</span>{fieldGenerateButton("hook")}</span><textarea name="hook" rows={2} maxLength={500} /></label>
          <label><span className="topic-field-heading"><span>选题理由</span>{fieldGenerateButton("rationale")}</span><textarea name="rationale" rows={2} maxLength={2000} /></label>
          <button className="primary-button" disabled={saving || generatingFields.length > 0}>{saving ? "正在创建…" : "创建选题"}</button>
        </form>
        <a className="production-entry" href={`/content?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`}>进入内容生产 →</a>
      </aside>}
    </div>
    {deleteCandidate && <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDeleteConfirmation(); }} onKeyDown={(event) => { if (event.key === "Escape") closeDeleteConfirmation(); }}><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-topic-title" aria-describedby="delete-topic-description"><form onSubmit={deleteTopic}><p className="section-kicker">管理员确认</p><h2 id="delete-topic-title">删除选题</h2><p id="delete-topic-description">删除后，这个选题会从选题池隐藏；已经进入内容生产的稿件和历史版本不会被删除。</p><div className="confirmation-topic-name">{deleteCandidate.title}</div><label htmlFor="delete-topic-confirmation">输入完整选题标题以确认<input ref={deleteConfirmationInputRef} id="delete-topic-confirmation" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} autoComplete="off" /></label><div className="confirmation-actions"><button type="button" onClick={closeDeleteConfirmation} disabled={deletingTopicId === deleteCandidate.id}>取消</button><button className="confirmation-danger" disabled={deleteConfirmation.trim() !== deleteCandidate.title || deletingTopicId === deleteCandidate.id}>{deletingTopicId === deleteCandidate.id ? "正在删除…" : "确认删除"}</button></div></form></section></div>}
  </div>;
}
