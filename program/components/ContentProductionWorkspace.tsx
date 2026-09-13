"use client";
import { runScopedAction } from "../lib/client-scope";
import { useWorkspaceInitialization } from "./useWorkspaceInitialization";
import { readApiError as readError } from "../lib/client-format";

import { FormEvent, useCallback, useMemo, useRef, useState } from "react";
import { rewriteCharacterCount } from "../lib/single-benchmark-rewrite";
import { CoreStrategyPreview } from "./CoreStrategyPreview";
import { EcommerceEntry } from "./ecommerce/EcommerceEntry";
import type { CoreContentStrategy } from "../lib/content-strategy-policy";
import Link from "next/link";
import { topicKnowledgeSelection } from "../lib/topic-knowledge-selection";
import type { ProductionPack } from "../lib/content-production";
import { preferredProjectId, rememberCurrentScope, scopedFetch } from "../lib/client-scope";
import { deliveryPlan } from "../lib/delivery-entitlements";
type Organization = {
    id: string;
    name: string;
};
type Project = {
    id: string;
    name: string;
};
type Topic = {
    id: string;
    title: string;
    angle: string | null;
    status: string;
    priority: number;
};
type ContentItem = {
    id: string;
    topic_id: string;
    selected_knowledge_ids_json?: string;
    title: string;
    status: string;
    current_version: number;
    generation_mode: string;
    pack_json: string;
    full_script: string;
    short_script: string;
    prompt_version?: string | null;
    model_call_id?: string | null;
    topic_source_type?: string | null;
    topic_source_ref?: string | null;
    citation_count?: number;
    updated_at: string;
};
type BenchmarkEntry = {
    id: string;
    title: string | null;
    author_name: string | null;
    category?: string | null;
    score: number;
    reasons: string[];
    hasOutcomeData: boolean;
    recommended: boolean;
    feedback?: {
        usageCount: number;
        approvedCount: number;
        changesRequestedCount: number;
        publishedCount: number;
    };
};
type PackPanel = "diagnosis" | "creative" | "storyboard" | "sources";
const sourceLabels: Record<string, string> = { manual: "人工策划", knowledge: "品牌知识", video_analysis: "视频分析", performance: "数据复盘", trend: "行业热点", comment: "评论需求" };
const readinessLabels = { ready: "可以进入审核", revise: "建议修改后审核", blocked: "暂不建议发布" } as const;
const hookVerdictLabels = { strong: "开头成立", revise: "开头需加强", blocked: "开头承诺无法兑现" } as const;
const flowRiskLabels = { high: "高风险", medium: "中风险", low: "小建议" } as const;
const historyApplicationLabels = { passed: "已通过自动验收", review: "样本较少，仅供参考", rewrite: "存在偏离，建议调整" } as const;
const historyValueLabels: Record<string, string> = {
    question: "问题开场", numbered: "数字清单", contrast: "对比开场", story: "故事开场", pain_point: "痛点开场", direct: "直接陈述",
    private_message: "私信引导", comment: "评论引导", follow: "关注引导", consultation: "咨询转化", purchase: "购买转化",
    join: "社群转化", download: "资料领取", save_share: "收藏转发", none: "无直接引导", course: "课程成交",
    community: "社群引流", product: "产品销售", lead_magnet: "资料留资", brand_awareness: "品牌认知",
};
function historyValueLabel(value: string) {
    return value.split("、").map((item) => historyValueLabels[item] || item).join("、");
}
function HistoricalStyleApplicationReport({ report }: {
    report?: ProductionPack["historicalStyleApplication"];
}) {
    if (!report)
        return null;
    return <section className={`history-application-report status-${report.status}`}>
    <header>
      <div><span>历史文案应用报告</span><h3>{historyApplicationLabels[report.status]}</h3></div>
      <strong>{report.matchedChecks}/{report.totalChecks}</strong>
    </header>
    <p>系统根据 {report.sourceIds.length} 篇实际引用文案和整体高表现画像，对完整口播稿进行客观检测。</p>
    <div className="history-application-checks">
      {report.checks.map((check) => <article className={check.matched ? "matched" : "missed"} key={check.key}>
        <span>{check.matched ? "✓" : "!"}</span>
        <div><strong>{check.label}</strong><small>目标：{historyValueLabel(check.expected)}</small><small>实际：{historyValueLabel(check.actual)}</small></div>
      </article>)}
    </div>
    <footer className={report.originality.passed ? "passed" : "missed"}>
      <strong>{report.originality.passed ? "原创重复检测通过" : `发现连续重复 ${report.originality.longestSharedCharacters} 字`}</strong>
      <span>{report.originality.passed ? "没有发现 18 字以上的历史原文连续复用。" : report.originality.phrase || "请改写重复片段。"}</span>
    </footer>
  </section>;
}
function SourceUsageReport({ report }: {
    report?: ProductionPack["sourceUsageReport"];
}) {
    if (!report)
        return null;
    return <section className={`source-usage-report status-${report.status}`}>
    <header><div><span>来源采用与追溯报告</span><h3>{report.status === "verified" ? "关键来源均已形成证据" : "部分上下文尚未形成引用"}</h3></div><strong>{report.traceableCitationCount} 条</strong></header>
    <p>“提供给模型”不等于“实际采用”。这里只统计通过来源逐字校验、并随当前版本保存的引用。</p>
    <div>{report.groups.map((group) => <article className={group.citedCount > 0 ? "cited" : "uncited"} key={group.key}><span>{group.citedCount > 0 ? "✓" : group.required ? "!" : "—"}</span><div><strong>{group.label}</strong><small>候选 {group.availableCount} · 实际引用 {group.citedCount}{group.required ? " · 必须形成证据" : ""}</small>{group.evidenceQuotes[0] && <q>{group.evidenceQuotes[0]}</q>}</div></article>)}</div>
  </section>;
}
function QualityReviewReport({ review, benchmarkTitles }: { review: NonNullable<ProductionPack["qualityReview"]>; benchmarkTitles: Map<string, string> }) {
    return <section className={"quality-review readiness-" + review.publishReadiness}>
    <div className="quality-review-title"><h3>内容方法诊断</h3><span>{readinessLabels[review.publishReadiness]}</span></div>
    <small>已接入授权内容方法 · 单一核心、开头、共鸣、逻辑延续</small>
    <article><strong>单一核心机制</strong><p>{review.coreMechanism}</p></article>
    <article><strong>{hookVerdictLabels[review.hookDiagnosis.verdict]}</strong><p>话题：{review.hookDiagnosis.topic}</p><p>抓手：{review.hookDiagnosis.hook}</p><p>可信度：{review.hookDiagnosis.credibility}</p><p>悬念：{review.hookDiagnosis.suspense}</p></article>
    <article><strong>五维共鸣</strong><p>沉默解除：{review.resonance.silentRelease}</p><p>满足动机：{review.resonance.motivation}</p><p>有效立场：{review.resonance.stance}</p><p>首批传播者：{review.resonance.firstSharer}</p><p>信念与行动：{review.resonance.beliefShift}</p></article>
    {review.benchmarkMethods.length > 0 && <article><strong>参考素材借鉴说明</strong>{review.benchmarkMethods.map((method) => <p key={method.sourceId + ":" + method.method}>{method.method}：{method.application}<small>{benchmarkTitles.get(method.sourceId) || "对标样本"}</small></p>)}</article>}
    {review.flowRisks.length > 0 && <article><strong>逻辑与口播风险</strong>{review.flowRisks.map((risk, index) => <p key={risk.location + ":" + index}><b>{flowRiskLabels[risk.level]} · {risk.location}</b>：{risk.issue}<small>修改：{risk.fix}</small></p>)}</article>}
    {review.blockers.length > 0 && <article><strong>审核前阻塞项</strong>{review.blockers.map((item) => <p key={item}>{item}</p>)}</article>}
  </section>;
}
function ProductionDiagnosis({ pack, benchmarkTitles }: { pack: ProductionPack; benchmarkTitles: Map<string, string> }) {
    return <>
    <SourceUsageReport report={pack.sourceUsageReport}/>
    <HistoricalStyleApplicationReport report={pack.historicalStyleApplication}/>
    {pack.qualityReview && <QualityReviewReport review={pack.qualityReview} benchmarkTitles={benchmarkTitles}/>}
  </>;
}
function ProductionCreative({ pack }: { pack: ProductionPack }) {
    return <>
    <section><h3>开头备选</h3>{pack.hooks.map((item) => <p key={item}>{item}</p>)}</section>
    <section><h3>封面与发布</h3><div className="plain-chips">{pack.coverCopy.map((item) => <span key={item}>{item}</span>)}</div>{pack.publishTitles.map((item) => <p key={item}>{item}</p>)}</section>
    <section><h3>素材与表演</h3>{[...pack.performanceNotes, ...pack.brollSuggestions].map((item) => <p key={item}>{item}</p>)}</section>
    {pack.riskNotes.length > 0 && <section className="risk-pack"><h3>发布前确认</h3>{pack.riskNotes.map((item) => <p key={item}>{item}</p>)}</section>}
  </>;
}
function ProductionSources({ pack, benchmarkTitles }: { pack: ProductionPack; benchmarkTitles: Map<string, string> }) {
    return <section><h3>来源引用</h3>{pack.citations.map((item) => <p key={item.sourceType + ":" + item.sourceId}>{item.quote}<small>{item.sourceType === "benchmark" ? "参考素材 · 写法或内容依据 · " + (benchmarkTitles.get(item.sourceId) || "已移出的历史样本") : item.sourceType === "method_knowledge" ? "授权方法知识 · 原文可追溯" : item.sourceType === "historical_copy" ? "品牌历史文案 · 只学习结构与变现形式" : item.sourceType}</small></p>)}</section>;
}
function ProductionPackPanel({ pack, panel, onPanelChange, benchmarkTitles }: { pack: ProductionPack; panel: PackPanel; onPanelChange: (panel: PackPanel) => void; benchmarkTitles: Map<string, string> }) {
    return <aside className="production-pack">
    <header className="production-pack-header">
      <div><p className="section-kicker">创作辅助</p></div>
      <nav aria-label="生产包内容切换">
        <button type="button" className={panel === "diagnosis" ? "active" : ""} onClick={() => onPanelChange("diagnosis")}>内容诊断</button>
        <button type="button" className={panel === "creative" ? "active" : ""} onClick={() => onPanelChange("creative")}>开头与发布</button>
        <button type="button" className={panel === "storyboard" ? "active" : ""} onClick={() => onPanelChange("storyboard")}>分镜 <span>{pack.storyboard.length}</span></button>
        <button type="button" className={panel === "sources" ? "active" : ""} onClick={() => onPanelChange("sources")}>引用 <span>{pack.citations.length}</span></button>
      </nav>
    </header>
    <div className="production-pack-scroll">
      {panel === "diagnosis" && <ProductionDiagnosis pack={pack} benchmarkTitles={benchmarkTitles}/>}
      {panel === "creative" && <ProductionCreative pack={pack}/>}
      {panel === "storyboard" && <section className="storyboard-pack"><h3>分镜脚本</h3>{pack.storyboard.map((item, index) => <article key={item.shot + ":" + index}><strong>{item.shot} · {item.durationSec}s</strong><p>{item.visual}</p><small>{item.performance}</small></article>)}</section>}
      {panel === "sources" && <ProductionSources pack={pack} benchmarkTitles={benchmarkTitles}/>}
    </div>
  </aside>;
}

function readPack(value: string): ProductionPack | null { try {
    return JSON.parse(value) as ProductionPack;
}
catch {
    return null;
} }
function BenchmarkRewriteComparison({ report }: { report: NonNullable<ProductionPack["benchmarkRewrite"]> }) {
    return <section className="benchmark-rewrite-comparison">
      <header><div><strong>单条对标 · 逐段对照</strong><p>{report.sourceTitle}</p></div><span>原稿 {report.sourceCharacters} 字 · 本版 {report.generatedCharacters} 字</span></header>
      <p>钩子：{report.plan.hookTechnique}<br/>结尾：{report.plan.ctaTechnique}</p>
      <small>{report.status === "edited" ? "正文已人工修改，以下保留生成时的逐段对照，不代表修改后的正文仍然对齐。" : "篇幅与段落已检查，钩子、衔接和 CTA 已由 AI 校对。请结合具体内容复核。"} 字数含标点、不含空白。</small>
      <details><summary>查看 {report.plan.segments.length} 段参考与生成文案</summary>
        {report.plan.segments.map((segment, index) => <article key={index}>
          <h4>{index + 1}. {segment.role}</h4>
          <div className="benchmark-rewrite-columns"><div><small>参考原稿 · {rewriteCharacterCount(segment.sourceText)} 字</small><p>{segment.sourceText}</p></div><div><small>生成时新稿 · {rewriteCharacterCount(report.segments[index]?.text || "")} 字</small><p>{report.segments[index]?.text}</p></div></div>
          <p className="benchmark-rewrite-application">衔接：{segment.transition}<br/>应用：{report.segments[index]?.application}</p>
        </article>)}
      </details>
    </section>;
}
function replaceItem(items: ContentItem[], patch: Partial<ContentItem> & {
    id: string;
}) { return items.map((item) => item.id === patch.id ? { ...item, ...patch } : item); }
export function ContentProductionWorkspace({ initialOrganizationId = "", initialProjectId = "", initialTopicId = "" }: {
    initialOrganizationId?: string;
    initialProjectId?: string;
    initialTopicId?: string;
}) {
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [organizationId, setOrganizationId] = useState("");
    const [projects, setProjects] = useState<Project[]>([]);
    const [projectId, setProjectId] = useState("");
    const [topics, setTopics] = useState<Topic[]>([]);
    const [items, setItems] = useState<ContentItem[]>([]);
    const [coreStrategy, setCoreStrategy] = useState<CoreContentStrategy | null>(null);
    const [canWrite, setCanWrite] = useState(false);
    const [selectedId, setSelectedId] = useState("");
    const [benchmarks, setBenchmarks] = useState<BenchmarkEntry[]>([]);
    const [selectedBenchmarkIds, setSelectedBenchmarkIds] = useState<string[]>([]);
    const [creationMode, setCreationMode] = useState<"standard" | "single_benchmark">("standard");
    const creationModeRef = useRef(creationMode);
    const recommendationRequest = useRef(0);
    const [recommendedBenchmarkIds, setRecommendedBenchmarkIds] = useState<string[]>([]);
    const [recommendationLoading, setRecommendationLoading] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [packPanel, setPackPanel] = useState<PackPanel>("diagnosis");
    const loadRecommendations = useCallback(async (orgId: string, projId: string, contentId: string) => {
        const requestId = ++recommendationRequest.current;
        if (!orgId || !projId || !contentId || !deliveryPlan.features.videoAnalysis) {
            setBenchmarks([]);
            setSelectedBenchmarkIds([]);
            setRecommendedBenchmarkIds([]);
            return;
        }
        setRecommendationLoading(true);
        try {
            const query = `organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}&contentId=${encodeURIComponent(contentId)}`;
            const response = await scopedFetch(`/api/video-library/recommendations?${query}`);
            if (!response.ok)
                throw new Error(await readError(response));
            const body = await response.json() as {
                entries: BenchmarkEntry[];
                recommendedIds: string[];
            };
            if (requestId !== recommendationRequest.current) return;
            setBenchmarks(body.entries);
            setRecommendedBenchmarkIds(body.recommendedIds);
            setSelectedBenchmarkIds(creationModeRef.current === "single_benchmark" ? [] : body.recommendedIds);
        }
        catch (reason) {
            if (requestId !== recommendationRequest.current) return;
            setBenchmarks([]);
            setSelectedBenchmarkIds([]);
            setRecommendedBenchmarkIds([]);
            setError(reason instanceof Error ? reason.message : "素材推荐加载失败");
        }
        finally {
            if (requestId === recommendationRequest.current) setRecommendationLoading(false);
        }
    }, []);
    const loadWorkspace = useCallback(async (orgId: string, projId: string) => {
        if (!orgId || !projId)
            return;
        const query = `organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`;
        const [topicResponse, contentResponse] = await Promise.all([scopedFetch(`/api/topics?${query}`), scopedFetch(`/api/content-items?${query}`)]);
        if (!topicResponse.ok)
            throw new Error(await readError(topicResponse));
        if (!contentResponse.ok)
            throw new Error(await readError(contentResponse));
        const topicBody = await topicResponse.json() as {
            topics: Topic[];
        };
        const contentBody = await contentResponse.json() as {
            coreStrategy: CoreContentStrategy | null;
            items: ContentItem[];
            canWrite: boolean;
        };
        setTopics(topicBody.topics.filter((topic) => topic.status !== "archived"));
        setItems(contentBody.items);
        setCoreStrategy(contentBody.coreStrategy ?? null);
        setCanWrite(contentBody.canWrite);
        const preferred = contentBody.items.find((item) => item.topic_id === initialTopicId)?.id || contentBody.items[0]?.id || "";
        setSelectedId(preferred);
        setPackPanel("diagnosis");
        if (contentBody.canWrite)
            await loadRecommendations(orgId, projId, preferred);
        else {
            setBenchmarks([]);
            setSelectedBenchmarkIds([]);
            setRecommendedBenchmarkIds([]);
        }
    }, [initialTopicId, loadRecommendations]);
    const loadProjects = useCallback(async (orgId: string, preferred = "") => {
        rememberCurrentScope(orgId, "");
        const response = await scopedFetch(`/api/projects?organizationId=${encodeURIComponent(orgId)}`);
        if (!response.ok)
            throw new Error(await readError(response));
        const body = await response.json() as {
            projects: Project[];
        };
        setProjects(body.projects);
        const selected = preferredProjectId(body.projects, preferred);
        setProjectId(selected);
        rememberCurrentScope(orgId, selected);
        await loadWorkspace(orgId, selected);
    }, [loadWorkspace]);
    useWorkspaceInitialization({ initialOrganizationId, initialProjectId, setOrganizations, setOrganizationId, loadProjects, setError, setLoading, failureMessage: "加载失败" });
    const selected = items.find((item) => item.id === selectedId) ?? null;
    const pack = useMemo(() => selected ? readPack(selected.pack_json) : null, [selected]);
    const availableTopics = topics.filter((topic) => !items.some((item) => item.topic_id === topic.id));
    const benchmarkTitles = useMemo(() => new Map(benchmarks.map((entry) => [entry.id, entry.title || entry.author_name || "未命名对标样本"])), [benchmarks]);
    const usedBenchmarkCount = pack?.citations.filter((citation) => citation.sourceType === "benchmark").length ?? 0;
    const usedMethodKnowledgeCount = pack?.citations.filter((citation) => citation.sourceType === "method_knowledge").length ?? 0;
    const usedHistoricalCopyCount = pack?.citations.filter((citation) => citation.sourceType === "historical_copy").length ?? 0;
    async function createItem(topicId: string) {
        setBusy(`create:${topicId}`);
        setError("");
        const response = await scopedFetch("/api/content-items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, topicId }) });
        if (!response.ok) {
            setError(await readError(response));
            setBusy("");
            return;
        }
        const body = await response.json() as {
            item: ContentItem;
        };
        setItems((current) => [body.item, ...current]);
        setTopics((current) => current.map((topic) => topic.id === topicId ? { ...topic, status: "drafting" } : topic));
        setSelectedId(body.item.id);
        setPackPanel("diagnosis");
        await loadRecommendations(organizationId, projectId, body.item.id);
        setBusy("");
    }
    async function generateItem(contentId: string) {
        if (creationMode === "single_benchmark" && selectedBenchmarkIds.length !== 1) {
            setError("请先选择 1 条视频作为整篇文案的模板。"); return;
        }
        setBusy(`generate:${contentId}`);
        setError("");
        const response = await scopedFetch(`/api/content-items/${contentId}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, modelProfile: "max", creationMode, benchmarkEntryIds: selectedBenchmarkIds, recommendedBenchmarkIds }) });
        if (!response.ok) {
            setError(await readError(response));
            setBusy("");
            return;
        }
        const body = await response.json() as {
            item: Partial<ContentItem> & {
                id: string;
            };
        };
        setItems((current) => replaceItem(current, body.item));
        setBusy("");
    }
    function toggleBenchmark(entryId: string) {
        if (creationMode === "single_benchmark") {
            setError(""); setSelectedBenchmarkIds((current) => current.includes(entryId) ? [] : [entryId]); return;
        }
        if (selectedBenchmarkIds.includes(entryId)) {
            setSelectedBenchmarkIds((current) => current.filter((id) => id !== entryId));
            return;
        }
        if (selectedBenchmarkIds.length >= 5) {
            setError("一次最多选择 5 条参考素材。");
            return;
        }
        setError("");
        setSelectedBenchmarkIds((current) => [...current, entryId]);
    }
    async function saveVersion(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selected || !pack)
            return;
        setBusy(`save:${selected.id}`);
        setError("");
        const form = new FormData(event.currentTarget);
        const nextPack = { ...pack, fullScript: String(form.get("fullScript") || ""), shortScript: String(form.get("shortScript") || "") };
        const response = await scopedFetch(`/api/content-items/${selected.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, pack: nextPack, changeSummary: form.get("changeSummary") }) });
        if (!response.ok) {
            setError(await readError(response));
            setBusy("");
            return;
        }
        const body = await response.json() as {
            item: Partial<ContentItem> & {
                id: string;
            };
        };
        setItems((current) => replaceItem(current, body.item));
        setBusy("");
    }
    async function submitForReview(contentId: string) {
        setBusy(`review:${contentId}`);
        setError("");
        const response = await scopedFetch(`/api/content-items/${contentId}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, toStatus: "internal_review", note: "从内容生产提交内部审核" }) });
        if (!response.ok) {
            setError(await readError(response));
            setBusy("");
            return;
        }
        window.location.assign(`/workflow?view=review&organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&contentId=${encodeURIComponent(contentId)}`);
    }
    if (loading)
        return <div className="management-state" role="status">正在载入内容生产…</div>;
    if (error && organizations.length === 0)
        return <div className="management-state error-state"><strong>暂时无法进入内容生产</strong><p>{error}</p></div>;
    if (!organizationId || !projectId)
        return <div className="empty-panel"><h2>请先创建企业空间</h2><p>每份生产包必须归属于明确的企业空间。</p></div>;
    return <div className="production-workspace"><div className="management-toolbar production-toolbar"><label>公司<select value={organizationId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setOrganizationId(id); await loadProjects(id); }, setError)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label><label>企业空间<select value={projectId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await loadWorkspace(organizationId, id); }, setError)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><span>{items.length} 个内容任务</span></div><EcommerceEntry key={`${organizationId}:${projectId}`} organizationId={organizationId} projectId={projectId} />{error && <div className="inline-alert" role="alert">{error}</div>}
    <div className="production-layout"><aside className="panel production-list"><div className="panel-heading"><div><p className="section-kicker">版本化创作</p><h2>生产任务</h2></div></div>{items.length ? <div className="production-items">{items.map((item) => <button type="button" className={selectedId === item.id ? "active" : ""} key={item.id} onClick={() => { setSelectedId(item.id); setPackPanel("diagnosis"); if (canWrite)
                    void loadRecommendations(organizationId, projectId, item.id); }}><span className="status neutral">v{item.current_version}</span><strong>{item.title}</strong><small>{item.generation_mode === "ai" ? "AI 生产包" : item.generation_mode === "manual" ? "人工修订" : "结构草稿"}</small></button>)}</div> : <div className="list-empty">还没有进入生产的选题。</div>}{canWrite && availableTopics.length > 0 && <section className="topic-backlog"><h3>待生产选题</h3>{availableTopics.slice(0, 12).map((topic) => <div key={topic.id}><span><strong>{topic.title}</strong><small>P{topic.priority} · {topic.status === "selected" ? "已入选" : "选题池"}</small></span><button type="button" disabled={Boolean(busy)} onClick={() => createItem(topic.id)}>{busy === `create:${topic.id}` ? "创建中…" : "进入生产"}</button></div>)}</section>}</aside>
      <main className="panel production-editor">{selected && pack ? <><div className="production-editor-head"><div><p className="section-kicker">{selected.generation_mode === "ai" ? `提示词 ${selected.prompt_version || "已记录"}` : "可编辑结构草稿"}</p><h2>{selected.title}</h2><span>当前版本 v{selected.current_version} · 每次保存都会创建不可变新版本</span></div><div className="generation-actions">{canWrite && <><button type="button" disabled={Boolean(busy) || recommendationLoading || (creationMode === "single_benchmark" && selectedBenchmarkIds.length !== 1)} onClick={() => void runScopedAction(() => generateItem(selected.id), setError).finally(() => setBusy(""))}>{busy === `generate:${selected.id}` ? (creationMode === "single_benchmark" ? "拆解、仿写与校对中…" : "生成中…") : creationMode === "single_benchmark" ? "按单条模板生成" : "AI 生成新版本"}</button></>}{canWrite && (selected.status === "draft" || selected.status === "internal_revision") ? <button className="submit-review" type="button" disabled={Boolean(busy)} onClick={() => void submitForReview(selected.id)}>{busy === `review:${selected.id}` ? "提交中…" : "提交审核 →"}</button> : <a href={`/workflow?view=review&organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&contentId=${encodeURIComponent(selected.id)}`}>查看审核 →</a>}</div></div>
        {canWrite && deliveryPlan.features.videoAnalysis && <section className="production-creation-mode" aria-label="创作模式"><div role="group" aria-label="选择创作模式"><button type="button" aria-pressed={creationMode === "standard"} disabled={Boolean(busy)} onClick={() => { creationModeRef.current = "standard"; setCreationMode("standard"); setSelectedBenchmarkIds([]); setError(""); }}>普通创作</button><button type="button" aria-pressed={creationMode === "single_benchmark"} disabled={Boolean(busy)} onClick={() => { creationModeRef.current = "single_benchmark"; setCreationMode("single_benchmark"); setSelectedBenchmarkIds((ids) => ids.length === 1 ? ids : []); setError(""); }}>单条对标仿写</button></div><p>{creationMode === "single_benchmark" ? "让新选题沿用一条参考稿的结构与节奏。先拆解，再逐段生成和校对；总字数接近原稿，个人经历按真实资料替换。" : "围绕选题创作，可综合多条参考素材。"}</p></section>}
        <CoreStrategyPreview strategy={coreStrategy} />
        <div className="production-lineage"><strong>本次生成：选题 + 核心内容策略（自动读取） + 选题指定品牌知识 {topicKnowledgeSelection(selected.selected_knowledge_ids_json).length} 条 + 已选对标 {selectedBenchmarkIds.length} 条 + 内容方法规则</strong><small>品牌知识沿用选题阶段的勾选；未勾选时不读取品牌知识，也不自动加入项目记忆或历史视频片段。下方引用报告属于当前已保存版本，重新生成后才会更新。</small></div>
        {canWrite && deliveryPlan.features.videoAnalysis && <section className="benchmark-generation-context"><header><div><strong>{creationMode === "single_benchmark" ? "选择一条仿写模板" : "智能推荐参考素材"}</strong><span>{creationMode === "single_benchmark" ? "选择一个已分析视频，以完整原口播为模板，对齐字数、段落功能、钩子、衔接和 CTA。选择另一条会替换当前模板。" : "系统检索当前企业空间已分析对标，默认推荐 3–5 条，可手动增删；保留每条素材的引用与应用说明。"}</span></div><div><em>已选 {selectedBenchmarkIds.length}/{creationMode === "single_benchmark" ? 1 : 5}</em><button type="button" disabled={Boolean(busy) || recommendationLoading} onClick={() => void loadRecommendations(organizationId, projectId, selected.id)}>{recommendationLoading ? "检索中…" : "重新推荐"}</button></div></header>{benchmarks.length ? <div className="benchmark-generation-options">{benchmarks.slice(0, 50).map((entry) => <label key={entry.id} className={entry.recommended ? "recommended" : ""}><input aria-label={`选择参考素材：${entry.title || "未命名素材"}`} type="checkbox" disabled={Boolean(busy)} checked={selectedBenchmarkIds.includes(entry.id)} onChange={() => toggleBenchmark(entry.id)}/><span><strong>{entry.title || "未命名素材"}</strong><small>{entry.author_name || entry.category || "已完成分析"} · 匹配度 {entry.score}</small><small>{entry.reasons.slice(0, 2).join("；") || "综合素材内容与当前选题排序"}</small>{entry.feedback && (entry.feedback.approvedCount > 0 || entry.feedback.changesRequestedCount > 0 || entry.feedback.publishedCount > 0) && <small>本空间历史反馈：通过 {entry.feedback.approvedCount} · 退回 {entry.feedback.changesRequestedCount} · 发布 {entry.feedback.publishedCount}</small>}</span>{entry.recommended && <b>推荐</b>}{entry.hasOutcomeData && <b className="outcome">有真实数据</b>}</label>)}</div> : <p>{recommendationLoading ? "正在检索当前企业空间的对标内容库…" : <>当前企业空间的对标内容库还没有可用的已分析视频。请先进入<Link href="/analysis?view=benchmark">对标内容库</Link>添加并完成视频分析。</>}</p>}</section>}
        <div className="production-lineage"><span>来源：{sourceLabels[selected.topic_source_type || "manual"] || selected.topic_source_type || "人工策划"}</span><strong>选题 → 内容 v{selected.current_version} → {selected.status === "draft" ? "待提交审核" : "已进入协作流程"}</strong><small>本版实际引用：{selected.citation_count ?? pack.citations.length} 条来源证据随版本保留 · {usedBenchmarkCount ? `引用 ${usedBenchmarkCount} 条对标样本` : "未引用对标样本"} · {usedMethodKnowledgeCount ? `采用 ${usedMethodKnowledgeCount} 项内容方法` : "旧版本未记录方法调用"} · {usedHistoricalCopyCount ? `学习 ${usedHistoricalCopyCount} 篇品牌历史文案` : "暂无历史文案可学习"}</small></div>
        {pack.benchmarkRewrite && <BenchmarkRewriteComparison report={pack.benchmarkRewrite}/>}
        <form key={`${selected.id}:${selected.current_version}`} className="production-form" onSubmit={saveVersion}><section><label>完整口播稿<textarea name="fullScript" rows={16} defaultValue={pack.fullScript} readOnly={!canWrite}/></label><label>精简版<textarea name="shortScript" rows={7} defaultValue={pack.shortScript} readOnly={!canWrite}/></label>{canWrite && <div className="save-version"><input name="changeSummary" maxLength={500} placeholder="本次修改说明（可选）"/><button disabled={Boolean(busy)}>{busy === `save:${selected.id}` ? "保存中…" : "保存为新版本"}</button></div>}</section>
          <ProductionPackPanel pack={pack} panel={packPanel} onPanelChange={setPackPanel} benchmarkTitles={benchmarkTitles} /></form></> : <div className="production-empty"><span aria-hidden="true">✦</span><h2>从选题开始一份生产包</h2><p>先创建结构草稿，再用已确认知识和当前策略生成可审核口播稿。</p></div>}</main>
    </div>
  </div>;
}
