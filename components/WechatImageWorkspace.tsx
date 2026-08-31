"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, LayoutTemplate, RefreshCw, ShieldCheck, Sparkles, WandSparkles } from "lucide-react";
import { toPng } from "html-to-image";
import { WechatPosterCanvas } from "./WechatPosterCanvas";
import { preferredOrganizationId, preferredProjectId, rememberCurrentScope, scopedFetch } from "../lib/client-scope";
import type { WechatImageContent, WechatImageRatioId, WechatImageTemplateId } from "../lib/wechat-image-generation";
import { getInfographicTemplate, pickInfographicTemplate, templateChoicesForRatio } from "../lib/wechat-infographic";
import { auditPosterElement, type PosterQualityReport } from "../lib/poster-visual-quality";

type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type ContextUsed = { brandKnowledgeCount: number; brandKnowledgeTitles: string[]; hasActiveStrategy: boolean; methodKnowledgeCount: number };

const visualThemes: Array<{ id: WechatImageTemplateId; name: string; description: string }> = [
  { id: "executive-dark", name: "深色商业", description: "适合老板认知、商业洞察与趋势判断" },
  { id: "method-warm", name: "米白方法论", description: "适合步骤拆解、知识科普与实操清单" },
  { id: "professional-blue", name: "蓝色专业", description: "适合企业服务、数据方法与咨询内容" },
];

const ratios: Array<{ id: WechatImageRatioId; label: string; use: string; width: number; height: number }> = [
  { id: "3:4", label: "3:4", use: "公众号竖图", width: 1080, height: 1440 },
  { id: "4:3", label: "4:3", use: "横版信息图", width: 1200, height: 900 },
  { id: "16:9", label: "16:9", use: "封面与宽屏", width: 1600, height: 900 },
  { id: "1:1", label: "1:1", use: "方形社交图", width: 1080, height: 1080 },
];

async function messageFrom(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message || "服务暂时无法完成请求。";
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 48) || "公众号图片";
}

export function WechatImageWorkspace({ initialOrganizationId = "", initialProjectId = "", initialTopic = "" }: { initialOrganizationId?: string; initialProjectId?: string; initialTopic?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [topic, setTopic] = useState(initialTopic);
  const [templateId, setTemplateId] = useState<WechatImageTemplateId>("professional-blue");
  const [ratioId, setRatioId] = useState<WechatImageRatioId>("3:4");
  const [layoutTemplate, setLayoutTemplate] = useState("");
  const [posterScale, setPosterScale] = useState(.7);
  const [renderReady, setRenderReady] = useState(false);
  const [qualityReport, setQualityReport] = useState<PosterQualityReport | null>(null);
  const [content, setContent] = useState<WechatImageContent | null>(null);
  const [contextUsed, setContextUsed] = useState<ContextUsed | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const posterRef = useRef<HTMLDivElement>(null);
  const posterStageRef = useRef<HTMLDivElement>(null);
  const selectedRatio = ratios.find((item) => item.id === ratioId) ?? ratios[0];
  const layoutChoices = content ? templateChoicesForRatio(ratioId) : [];
  const effectiveLayoutTemplate = content && !layoutChoices.some((item) => item.name === layoutTemplate)
    ? pickInfographicTemplate(content.structure, ratioId, layoutTemplate).name
    : layoutTemplate;
  const selectedLayout = getInfographicTemplate(effectiveLayoutTemplate);

  const loadProjects = useCallback(async (orgId: string, preferred = "") => {
    rememberCurrentScope(orgId, "");
    const response = await scopedFetch(`/api/projects?organizationId=${encodeURIComponent(orgId)}`);
    if (!response.ok) throw new Error(await messageFrom(response));
    const body = await response.json() as { projects: Project[] };
    setProjects(body.projects);
    const selected = preferredProjectId(body.projects, preferred);
    setProjectId(selected);
    rememberCurrentScope(orgId, selected);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch("/api/organizations");
        if (response.status === 401) { window.location.replace(`/login?returnTo=${encodeURIComponent("/wechat-images")}`); return; }
        if (!response.ok) throw new Error(await messageFrom(response));
        const body = await response.json() as { organizations: Organization[] };
        if (!active) return;
        setOrganizations(body.organizations);
        const selected = preferredOrganizationId(body.organizations, initialOrganizationId);
        setOrganizationId(selected);
        if (selected) await loadProjects(selected, initialProjectId);
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "工作区加载失败。"); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [initialOrganizationId, initialProjectId, loadProjects]);

  useEffect(() => {
    const stage = posterStageRef.current;
    if (!stage || !content) return;
    const resize = () => setPosterScale(Math.min(1, Math.max(.2, (stage.clientWidth - 48) / selectedRatio.width)));
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(stage);
    window.addEventListener("resize", resize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", resize); };
  }, [content, selectedRatio.width]);

  const onCanvasReady = useCallback(() => {
    setRenderReady(false);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const root = posterRef.current;
      if (!root) return;
      const report = auditPosterElement(root);
      setQualityReport(report);
      setRenderReady(report.passed);
    }));
  }, []);

  async function generate() {
    if (topic.trim().length < 4) { setError("请先填写至少 4 个字符的选题。"); return; }
    if (!organizationId || !projectId) { setError("请先选择企业空间。"); return; }
    setGenerating(true); setError(""); setNotice("");
    try {
      const response = await scopedFetch("/api/wechat-images/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, topic: topic.trim(), templateId, ratioId }) });
      if (!response.ok) throw new Error(await messageFrom(response));
      const body = await response.json() as { generated: WechatImageContent; contextUsed: ContextUsed };
      const layout = pickInfographicTemplate(body.generated.structure, ratioId);
      setContent(body.generated); setContextUsed(body.contextUsed); setLayoutTemplate(layout.name); setRenderReady(false);
      setNotice(`内容已生成，并智能匹配“${layout.label}”。双击画面文字可以编辑，也可以免费换一个版式。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "图片内容生成失败，请稍后重试。"); }
    finally { setGenerating(false); }
  }

  function updateField<Key extends keyof WechatImageContent>(key: Key, value: WechatImageContent[Key]) {
    setContent((current) => current ? { ...current, [key]: value } : current);
  }

  function shuffleLayout() {
    if (!content) return;
    const choices = templateChoicesForRatio(ratioId);
    const currentIndex = choices.findIndex((item) => item.name === effectiveLayoutTemplate);
    const next = choices[(currentIndex + 1 + choices.length) % choices.length] ?? pickInfographicTemplate(content.structure, ratioId, effectiveLayoutTemplate);
    setLayoutTemplate(next.name); setRenderReady(false); setError("");
    setNotice(`已切换为“${next.label}”，没有重新调用模型，也不会增加 Token 消耗。`);
  }

  async function downloadPng() {
    if (!posterRef.current || !content || !renderReady) return;
    setExporting(true); setError("");
    try {
      await document.fonts?.ready;
      const dataUrl = await toPng(posterRef.current, { cacheBust: true, pixelRatio: 1, width: selectedRatio.width, height: selectedRatio.height, backgroundColor: templateId === "executive-dark" ? "#11182b" : templateId === "method-warm" ? "#f4efe3" : "#eef4fb", style: { transform: "none" } });
      const anchor = document.createElement("a");
      anchor.download = `${safeFilename(topic)}-${selectedLayout?.label || "信息图"}-${selectedRatio.id.replace(":", "比")}.png`;
      anchor.href = dataUrl; anchor.click(); anchor.href = ""; anchor.remove();
      setNotice("高清 PNG 已下载。本次导出没有在服务器保存临时文件。");
    } catch (reason) { setError(reason instanceof Error ? `图片导出失败：${reason.message}` : "图片导出失败，请重试。"); }
    finally { setExporting(false); }
  }

  if (loading) return <div className="management-state" role="status">正在载入公众号图片工作区…</div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><h2>请先创建企业空间</h2><p>图片会自动继承当前项目的品牌知识和内容策略。</p></div>;

  const project = projects.find((item) => item.id === projectId);
  return <div className="wechat-image-workspace">
    <div className="management-toolbar wechat-image-toolbar"><label>公司<select value={organizationId} onChange={async (event) => { const id = event.target.value; setOrganizationId(id); setContent(null); await loadProjects(id); }}>{organizations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>企业空间<select value={projectId} onChange={(event) => { const id = event.target.value; setProjectId(id); setContent(null); rememberCurrentScope(organizationId, id); }}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span>导出尺寸 {selectedRatio.width} × {selectedRatio.height}</span></div>
    {error && <div className="inline-alert" role="alert">{error}</div>}
    {notice && <div className="wechat-image-notice" role="status">{notice}</div>}
    <div className="wechat-image-layout">
      <aside className="panel wechat-image-controls">
        <div className="panel-heading"><div><p className="section-kicker">第一步</p><h2>选题与样式</h2></div><WandSparkles aria-hidden="true" /></div>
        <div className="wechat-image-form">
          <label><span>选题</span><textarea value={topic} maxLength={180} rows={4} onChange={(event) => setTopic(event.target.value)} placeholder="例如：中小企业老板必须懂的 5 个 AI 概念" /></label>
          <fieldset><legend>选择比例</legend><div className="wechat-ratio-list">{ratios.map((ratio) => <button className={ratioId === ratio.id ? "active" : ""} type="button" key={ratio.id} onClick={() => { setRatioId(ratio.id); setRenderReady(false); }}><strong>{ratio.label}</strong><small>{ratio.use}</small></button>)}</div></fieldset>
          <fieldset><legend><LayoutTemplate aria-hidden="true" />选择视觉主题</legend><div className="wechat-template-list">{visualThemes.map((template) => <button className={templateId === template.id ? "active" : ""} type="button" key={template.id} onClick={() => { setTemplateId(template.id); setRenderReady(false); }}><i className={`wechat-template-swatch ${template.id}`} /><span><strong>{template.name}</strong><small>{template.description}</small></span></button>)}</div></fieldset>
          {content && <fieldset><legend><LayoutTemplate aria-hidden="true" />选择成熟版式</legend><div className="wechat-layout-choice-list">{layoutChoices.map((layout) => <button className={effectiveLayoutTemplate === layout.name ? "active" : ""} type="button" key={layout.name} onClick={() => { setLayoutTemplate(layout.name); setRenderReady(false); setNotice(`已切换为“${layout.label}”，不会重新调用模型。`); }}><i aria-hidden="true"><span /><span /><span /></i><strong>{layout.label}</strong></button>)}</div></fieldset>}
          <div className="wechat-auto-context"><ShieldCheck aria-hidden="true" /><div><strong>品牌知识自动继承</strong><span>生成时会读取“{project?.name}”已确认的品牌知识、内容策略和系统方法。</span></div></div>
          <button className="primary-button wechat-generate-button" type="button" disabled={generating} aria-busy={generating} onClick={() => void generate()}>{generating ? "正在组织内容与版式…" : content ? <><RefreshCw aria-hidden="true" />重新生成</> : <><Sparkles aria-hidden="true" />生成公众号图片</>}</button>
          {contextUsed && <div className="wechat-context-summary"><strong>本次提供给模型的上下文</strong><span>{contextUsed.brandKnowledgeCount} 条品牌知识 · {contextUsed.hasActiveStrategy ? "包含生效策略" : "暂无生效策略"} · {contextUsed.methodKnowledgeCount} 条方法参考</span>{contextUsed.brandKnowledgeTitles.length > 0 && <small title={contextUsed.brandKnowledgeTitles.join("、")}>候选品牌知识：{contextUsed.brandKnowledgeTitles.join("、")}</small>}</div>}
        </div>
      </aside>

      <section className="panel wechat-image-preview-panel">
        <div className="panel-heading"><div><p className="section-kicker">第二步</p><h2>{selectedLayout ? `智能版式 · ${selectedLayout.label}` : "预览与编辑"}</h2>{content && qualityReport && <span className={`poster-quality-status ${qualityReport.passed ? "passed" : "warning"}`}>{qualityReport.passed ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}{qualityReport.passed ? "设计检查通过" : qualityReport.issues[0]?.message}</span>}</div><div className="wechat-preview-actions"><button className="secondary-link" type="button" disabled={!content || exporting} onClick={shuffleLayout}><RefreshCw aria-hidden="true" />换一个版式</button><button className="secondary-link" type="button" disabled={!content || !renderReady || exporting} aria-busy={exporting} onClick={() => void downloadPng()}><Download aria-hidden="true" />{exporting ? "正在导出…" : "下载 PNG"}</button></div></div>
        {content ? <div className="wechat-poster-stage" ref={posterStageRef} style={{ height: selectedRatio.height * posterScale + 48 }}><div className={`wechat-infographic-frame ${templateId} ratio-${ratioId.replace(":", "-")}`} ref={posterRef} style={{ width: selectedRatio.width, height: selectedRatio.height, transform: `scale(${posterScale})` }}>
          <header><input aria-label="栏目名称" value={content.eyebrow} maxLength={24} onChange={(event) => updateField("eyebrow", event.target.value)} /><span>{selectedLayout?.label} · {ratioId}</span></header>
          <WechatPosterCanvas content={content} templateName={effectiveLayoutTemplate} ratio={ratioId} onReady={onCanvasReady} />
          <footer><textarea aria-label="总结" value={content.conclusion} maxLength={90} onChange={(event) => updateField("conclusion", event.target.value)} /><div><input aria-label="行动引导" value={content.cta} maxLength={48} onChange={(event) => updateField("cta", event.target.value)} /><input aria-label="品牌落款" value={content.footer} maxLength={32} onChange={(event) => updateField("footer", event.target.value)} /></div></footer>
        </div></div> : <div className="wechat-preview-empty"><h3>从一个选题开始</h3><p>系统会先判断内容结构，再从匹配的模板池中自动选择版式。</p><div><span>23 个已验证版式</span><span>智能匹配版式</span><span>换版不消耗 Token</span></div></div>}
      </section>
    </div>
  </div>;
}
