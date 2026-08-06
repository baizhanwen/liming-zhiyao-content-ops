"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { preferredOrganizationId, preferredProjectId, rememberCurrentScope } from "../lib/client-scope";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type Topic = { id: string; title: string; angle: string | null; source_type: string; source_ref: string | null; pillar: string | null; audience: string | null; objective: string | null; hook: string | null; rationale: string | null; priority: number; status: string; created_at: string };
type Citation = { id: string; topic_id: string; citation_type: string; citation_id: string; quote: string | null };
type KnowledgeItem = { id: string; title: string; status: string; category: string };
type GeneratedField = "angle" | "pillar" | "priority" | "audience" | "objective" | "hook" | "rationale";

const sourceLabels: Record<string, string> = { manual: "人工策划", knowledge: "品牌知识", video_analysis: "视频分析", performance: "历史表现", trend: "行业热点", comment: "评论需求" };
const generatedFields: GeneratedField[] = ["angle", "pillar", "priority", "audience", "objective", "hook", "rationale"];
const generatedFieldLabels: Record<GeneratedField, string> = { angle: "切入角度", pillar: "内容支柱", priority: "优先级", audience: "目标人群", objective: "内容目标", hook: "开场钩子", rationale: "选题理由" };
async function readError(response: Response) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; return body?.error?.message ?? "请求没有完成，请稍后重试。"; }

export function TopicWorkspace({ initialOrganizationId = "", initialProjectId = "", sourceVideoId = "" }: { initialOrganizationId?: string; initialProjectId?: string; sourceVideoId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState(""); const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [topics, setTopics] = useState<Topic[]>([]); const [citations, setCitations] = useState<Citation[]>([]); const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]); const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const [generatingFields, setGeneratingFields] = useState<GeneratedField[]>([]); const [generationMessage, setGenerationMessage] = useState(""); const topicFormRef = useRef<HTMLFormElement>(null);

  const loadWorkspace = useCallback(async (orgId: string, projId: string) => {
    if (!orgId || !projId) return; const query = `organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`;
    const [topicResponse, knowledgeResponse] = await Promise.all([fetch(`/api/topics?${query}`), fetch(`/api/knowledge?${query}`)]);
    if (!topicResponse.ok) throw new Error(await readError(topicResponse)); if (!knowledgeResponse.ok) throw new Error(await readError(knowledgeResponse));
    const topicBody = await topicResponse.json() as { topics: Topic[]; citations: Citation[]; canWrite: boolean }; const knowledgeBody = await knowledgeResponse.json() as { items: KnowledgeItem[] };
    setTopics(topicBody.topics); setCitations(topicBody.citations); setCanWrite(topicBody.canWrite); setKnowledge(knowledgeBody.items.filter((item) => item.status === "confirmed"));
  }, []);
  const loadProjects = useCallback(async (orgId: string, preferred = "") => { const response = await fetch(`/api/projects?organizationId=${encodeURIComponent(orgId)}`); if (!response.ok) throw new Error(await readError(response)); const body = await response.json() as { projects: Project[] }; setProjects(body.projects); const selected = preferredProjectId(body.projects, preferred); setProjectId(selected); rememberCurrentScope(orgId, selected); await loadWorkspace(orgId, selected); }, [loadWorkspace]);
  useEffect(() => { let active = true; (async () => { try { const response = await fetch("/api/organizations"); if (!response.ok) throw new Error(await readError(response)); const body = await response.json() as { organizations: Organization[] }; if (!active) return; setOrganizations(body.organizations); const selected = preferredOrganizationId(body.organizations, initialOrganizationId); setOrganizationId(selected); if (selected) await loadProjects(selected, initialProjectId); } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "加载失败"); } finally { if (active) setLoading(false); } })(); return () => { active = false; }; }, [initialOrganizationId, initialProjectId, loadProjects]);

  async function createTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); const formElement = event.currentTarget; const form = new FormData(formElement); const sourceKnowledgeItemId = sourceVideoId ? "" : String(form.get("sourceKnowledgeItemId") || "");
    const priority = String(form.get("priority") || "").trim();
    const response = await fetch("/api/topics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, sourceVideoId, sourceKnowledgeItemId, title: form.get("title"), angle: form.get("angle"), pillar: form.get("pillar"), audience: form.get("audience"), objective: form.get("objective"), hook: form.get("hook"), rationale: form.get("rationale"), priority: priority ? Number(priority) : 50 }) });
    if (!response.ok) { setError(await readError(response)); setSaving(false); return; } const body = await response.json() as { topic: Topic; citation: Citation | null }; setTopics((current) => [body.topic, ...current]); if (body.citation) setCitations((current) => [{ ...body.citation!, topic_id: body.topic.id }, ...current]); formElement.reset(); setGenerationMessage(""); setSaving(false);
  }

  function formValue(name: string) {
    const element = topicFormRef.current?.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    return element?.value?.trim() ?? "";
  }

  async function generateTopicFields(targets: GeneratedField[]) {
    if (!targets.length || !topicFormRef.current) return;
    const title = formValue("title");
    if (title.length < 2) { setError("请先填写选题标题，再使用 AI 补全。"); topicFormRef.current.elements.namedItem("title") instanceof HTMLElement && (topicFormRef.current.elements.namedItem("title") as HTMLElement).focus(); return; }
    setGeneratingFields(targets); setGenerationMessage(""); setError("");
    try {
      const draft = { title, angle: formValue("angle"), pillar: formValue("pillar"), priority: formValue("priority"), audience: formValue("audience"), objective: formValue("objective"), hook: formValue("hook"), rationale: formValue("rationale") };
      const response = await fetch("/api/topics/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, sourceVideoId, sourceKnowledgeItemId: sourceVideoId ? "" : formValue("sourceKnowledgeItemId"), draft, targets }) });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json() as { generated: Partial<Record<GeneratedField, string | number>> };
      for (const field of targets) {
        const element = topicFormRef.current?.elements.namedItem(field) as HTMLInputElement | HTMLTextAreaElement | null;
        if (element && body.generated[field] !== undefined) element.value = String(body.generated[field]);
      }
      setGenerationMessage(targets.length === 1 ? `${generatedFieldLabels[targets[0]]}已重新生成，你可以直接修改或再次生成。` : `已补全 ${targets.length} 项空白内容，原有内容保持不变。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "选题内容生成失败，请稍后再试。"); }
    finally { setGeneratingFields([]); }
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

  if (loading) return <div className="management-state" role="status">正在载入选题中心…</div>;
  if (error && organizations.length === 0) return <div className="management-state error-state"><strong>暂时无法进入选题中心</strong><p>{error}</p><small>请确认本地身份已启用，并先创建公司与客户项目。</small></div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><span aria-hidden="true">◇</span><h2>请先创建客户项目</h2><p>选题必须归属于明确的客户项目。</p></div>;
  return <div className="topic-workspace"><div className="management-toolbar topic-toolbar"><label>公司<select value={organizationId} onChange={async (event) => { const id = event.target.value; setOrganizationId(id); await loadProjects(id); }}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label><label>客户项目<select value={projectId} onChange={async (event) => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await loadWorkspace(organizationId, id); }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><span>{topics.length} 个选题</span></div>{error && <div className="inline-alert" role="alert">{error}</div>}
    <div className="topic-layout"><section className="panel topic-list-panel"><div className="panel-heading"><div><p className="section-kicker">复用方法，不做近义词洗稿</p><h2>选题池</h2></div></div>{topics.length ? <div className="topic-list">{topics.map((topic) => { const topicCitations = citations.filter((citation) => citation.topic_id === topic.id); return <article key={topic.id}><div className="topic-card-head"><span className="topic-priority">P{topic.priority}</span><span className="status neutral">{topic.status === "idea" ? "想法" : topic.status === "selected" ? "已入选" : topic.status === "drafting" ? "生产中" : "已归档"}</span></div><h3>{topic.title}</h3>{topic.angle && <p>{topic.angle}</p>}<dl><div><dt>内容支柱</dt><dd>{topic.pillar || "待归类"}</dd></div><div><dt>目标人群</dt><dd>{topic.audience || "待补充"}</dd></div><div><dt>内容目标</dt><dd>{topic.objective || "待补充"}</dd></div></dl><footer><span>{sourceLabels[topic.source_type] || topic.source_type}</span>{topicCitations.length > 0 && <em title={topicCitations[0].quote || "已保留来源"}>已引用 {topicCitations.length} 条证据</em>}</footer></article>; })}</div> : <div className="list-empty">从品牌知识、视频分析或人工策划创建第一个选题。</div>}</section>
      {canWrite && <aside className="create-panel topic-create">
        <p className="section-kicker">新选题</p><h2>{sourceVideoId ? "从视频分析转为选题" : "加入项目选题池"}</h2>
        {sourceVideoId && <div className="source-banner"><strong>已关联分析结果</strong><span>创建时会由服务端确认该视频属于当前项目。</span></div>}
        <form ref={topicFormRef} className="stack-form" onSubmit={createTopic}>
          <label><span className="topic-field-heading"><span>选题标题</span><em className="topic-required-note">必填</em></span><input name="title" required minLength={2} maxLength={160} placeholder="明确讲什么，而不是宽泛关键词" /></label>
          {!sourceVideoId && <label>引用品牌知识<select name="sourceKnowledgeItemId" defaultValue=""><option value="">不引用</option>{knowledge.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
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
  </div>;
}
