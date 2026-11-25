"use client";
import { runScopedAction } from "../lib/client-scope";
import { isScopeCancellation } from "../lib/client-scope-request";
import { useWorkspaceInitialization } from "./useWorkspaceInitialization";
import { readApiError as readError } from "../lib/client-format";

import { FormEvent, useCallback, useMemo, useRef, useState } from "react";
import { ArrowRight, WandSparkles } from "lucide-react";
import { RecordSidebar, RecordSidebarItem } from "./RecordSidebar";
import { SplitWorkspace } from "./SplitWorkspace";
import { rewriteCharacterCount } from "../lib/single-benchmark-rewrite";
import { CoreStrategyPreview } from "./CoreStrategyPreview";
import type { CoreContentStrategy } from "../lib/content-strategy-policy";
import Link from "next/link";
import { topicKnowledgeSelection } from "../lib/topic-knowledge-selection";
import type { ProductionPack } from "../lib/content-production";
import { preferredProjectId, rememberCurrentScope, scopedFetch } from "../lib/client-scope";
import { deliveryPlan } from "../lib/delivery-entitlements";
import { writingIntentLabels, type WritingIntent } from "../lib/content-writing-intent";
import { contentStatusLabels, type ContentStatus } from "../lib/content-workflow";
import { studioHref, structureDraftHref } from "../lib/studio-links";
import { isReferenceCreationReport } from "../lib/structure-creation";
import { DraftStoryboard } from "./DraftStoryboard";
import { ReferenceDraftResult } from "./ReferenceDraftResult";
import "./reference-draft.css";
import "./creation-cleanup.css";
type Organization = {
    id: string;
    name: string;
};
type Project = {
    id: string;
    name: string;
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
    rewrite_workspace_id?: string | null;
    rewrite_version?: number | null;
    citation_count?: number;
    latest_generation_status?: string | null;
    latest_generation_error?: string | null;
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
const sourceLabels: Record<string, string> = { manual: "人工策划", knowledge: "品牌知识", video_analysis: "视频分析", performance: "数据复盘", trend: "行业热点", comment: "评论需求", project_assistant: "灵感对话", inspiration_card: "灵感卡片", script_rewrite: "口播改写" };
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
export function ContentProductionWorkspace({ initialOrganizationId = "", initialProjectId = "", initialTopicId = "", initialContentId = "" }: {
    initialOrganizationId?: string;
    initialProjectId?: string;
    initialTopicId?: string;
    initialContentId?: string;
}) {
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [organizationId, setOrganizationId] = useState("");
    const [projects, setProjects] = useState<Project[]>([]);
    const [projectId, setProjectId] = useState("");
    const [items, setItems] = useState<ContentItem[]>([]);
    const [coreStrategy, setCoreStrategy] = useState<CoreContentStrategy | null>(null);
    const [canWrite, setCanWrite] = useState(false);
    const [selectedId, setSelectedId] = useState("");
    const [benchmarks, setBenchmarks] = useState<BenchmarkEntry[]>([]);
    const [selectedBenchmarkIds, setSelectedBenchmarkIds] = useState<string[]>([]);
    const [writingIntent, setWritingIntent] = useState<WritingIntent>("auto");
    const recommendationRequest = useRef(0);
    const editor = useRef<HTMLFormElement>(null);
    const [recommendedBenchmarkIds, setRecommendedBenchmarkIds] = useState<string[]>([]);
    const [recommendationLoading, setRecommendationLoading] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
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
            setSelectedBenchmarkIds([]);
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
        const contentResponse = await scopedFetch(`/api/content-items?${query}&contentId=${encodeURIComponent(initialContentId)}&topicId=${encodeURIComponent(initialTopicId)}`);
        if (!contentResponse.ok) throw new Error(await readError(contentResponse));
        const contentBody = await contentResponse.json() as {
            coreStrategy: CoreContentStrategy | null;
            items: ContentItem[];
            canWrite: boolean;
        };
        setItems(contentBody.items);
        setCoreStrategy(contentBody.coreStrategy ?? null);
        setCanWrite(contentBody.canWrite);
        const preferred = contentBody.items.find((item) => item.id === initialContentId)?.id || contentBody.items.find((item) => item.topic_id === initialTopicId)?.id || contentBody.items[0]?.id || "";
        setSelectedId(preferred);
        setWritingIntent("auto");
        if (contentBody.canWrite)
            await loadRecommendations(orgId, projId, preferred);
        else {
            setBenchmarks([]);
            setSelectedBenchmarkIds([]);
            setRecommendedBenchmarkIds([]);
        }
    }, [initialContentId, initialTopicId, loadRecommendations]);
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
    const rewriteLink = selected?.rewrite_workspace_id && selected.topic_source_ref
        ? studioHref("rewrite", { organizationId, projectId, rewriteId: selected.rewrite_workspace_id, versionId: selected.topic_source_ref })
        : "";
    const topicLink = selected && selected.topic_source_type !== "script_rewrite"
        ? studioHref("inspiration", { organizationId, projectId, topicId: selected.topic_id })
        : "";
    const canEditSelected = canWrite && Boolean(selected) && !["published", "reviewed", "archived"].includes(selected?.status || "");
    const pack = useMemo(() => selected ? readPack(selected.pack_json) : null, [selected]);
    const reference = pack?.referenceCreation;
    const referenceLink = reference && selected ? structureDraftHref({ organizationId, projectId, videoId: reference.videoId, analysisId: reference.analysisId, contentId: selected.id }) : "";
    const isScaffold = selected?.generation_mode === "scaffold";
    const template = pack?.benchmarkRewrite;
    const usedBenchmarkCount = pack?.citations.filter((citation) => citation.sourceType === "benchmark").length ?? 0;
    const usedMethodKnowledgeCount = pack?.citations.filter((citation) => citation.sourceType === "method_knowledge").length ?? 0;
    const usedHistoricalCopyCount = pack?.citations.filter((citation) => citation.sourceType === "historical_copy").length ?? 0;
    async function generateItem(contentId: string) {
        const options = { creationMode: template ? "single_benchmark" : "standard", writingIntent,
            benchmarkEntryIds: template ? [template.sourceId] : selectedBenchmarkIds, recommendedBenchmarkIds };
        setBusy(`generate:${contentId}`);
        setError("");
        try {
            const response = await scopedFetch(`/api/content-items/${contentId}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, expectedVersion: items.find((item) => item.id === contentId)?.current_version ?? 1, modelProfile: "max", ...options }) });
            if (!response.ok) {
                const message = await readError(response);
                setError(`口播稿生成未成功：${message}`);
                setItems((current) => current.map((item) => item.id === contentId ? { ...item, latest_generation_status: "failed", latest_generation_error: message } : item));
                return;
            }
            const body = await response.json() as {
                item: Partial<ContentItem> & {
                    id: string;
                };
            };
            setItems((current) => replaceItem(current, { ...body.item, latest_generation_status: "completed", latest_generation_error: null }));
        } catch (reason) {
            if (isScopeCancellation(reason)) throw reason;
            const message = reason instanceof Error ? reason.message : "网络连接中断，请重试。";
            setError(`口播稿生成未成功：${message}`);
            setItems((current) => current.map((item) => item.id === contentId ? { ...item, latest_generation_status: "failed", latest_generation_error: message } : item));
        } finally { setBusy(""); }
    }
    function toggleBenchmark(entryId: string) {
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
    async function polishVersion() {
        if (!selected || !canEditSelected || !pack || busy) return;
        if (editor.current && [...editor.current.querySelectorAll("textarea, input")].some(field => {
            const input = field as HTMLTextAreaElement | HTMLInputElement;
            return input.value !== input.defaultValue;
        })) {
            setError("正文有未保存的修改，请先保存这一版再润色。");
            return;
        }
        setBusy("polish"); setError("");
        try {
            const response = await scopedFetch("/api/script-rewrites", { method: "POST",
                headers: { "content-type": "application/json" }, body: JSON.stringify({
                    organizationId, projectId, sourceType: "pasted", sourceText: pack.fullScript,
                    title: `${selected.title} · 润色 v${selected.current_version}`.slice(0, 160),
                }) });
            if (!response.ok) throw new Error(await readError(response));
            const { workspace } = await response.json() as { workspace: { id: string } };
            window.location.assign(studioHref("rewrite", { organizationId, projectId, rewriteId: workspace.id,
                returnContentId: selected.id, returnContentVersion: String(selected.current_version) }));
        } finally { setBusy(""); }
    }
    async function saveVersion(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selected || !pack)
            return;
        setBusy(`save:${selected.id}`);
        setError("");
        const form = new FormData(event.currentTarget);
        const nextPack = { ...pack, ...(isScaffold ? { citations: [{ sourceType: "topic", sourceId: selected.topic_id, quote: `本次创作选题标题：${selected.title}`.slice(0, 80) }] } : {}), fullScript: String(form.get("fullScript") || ""), shortScript: String(form.get("shortScript") || "") };
        const response = await scopedFetch(`/api/content-items/${selected.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, expectedVersion: selected.current_version, pack: nextPack, changeSummary: form.get("changeSummary") }) });
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
        const response = await scopedFetch(`/api/content-items/${contentId}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, expectedVersion: items.find((item) => item.id === contentId)?.current_version, toStatus: "internal_review", note: "从内容生产提交内部审核" }) });
        if (!response.ok) {
            setError(await readError(response));
            setBusy("");
            return;
        }
        window.location.assign(`/workflow?view=review&organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&contentId=${encodeURIComponent(contentId)}`);
    }
    if (loading)
        return <div className="management-state" role="status">正在载入稿件…</div>;
    if (error && organizations.length === 0)
        return <div className="management-state error-state"><strong>暂时无法进入内容生产</strong><p>{error}</p></div>;
    if (!organizationId || !projectId)
        return <div className="empty-panel"><h2>请先创建企业空间</h2><p>每份生产包必须归属于明确的企业空间。</p></div>;
    return <div className="production-workspace"><div className="management-toolbar production-toolbar"><label>公司<select value={organizationId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setOrganizationId(id); await loadProjects(id); }, setError)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label><label>企业空间<select value={projectId} onChange={(event) => runScopedAction(async () => { const id = event.target.value; setProjectId(id); rememberCurrentScope(organizationId, id); await loadWorkspace(organizationId, id); }, setError)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><span>{items.length} 个内容任务</span></div>{error && <div className="inline-alert" role="alert">{error}</div>}
    <SplitWorkspace className="production-layout record-sidebar-layout">
      <RecordSidebar
        title="稿件列表"
        count={items.length}
        footer={<Link href={studioHref("rewrite", { organizationId, projectId })}>历史口播改写<ArrowRight size={14} aria-hidden="true" /></Link>}
      >
        {items.length ? items.map(item => (
          <RecordSidebarItem
            key={item.id}
            title={item.title}
            selected={selectedId === item.id}
            version={item.current_version}
            status={contentStatusLabels[item.status as ContentStatus] || item.status}
            meta={item.generation_mode === "ai" ? "AI 生产包" : item.rewrite_workspace_id ? `源自改写 v${item.rewrite_version}` : item.generation_mode === "manual" ? "人工修订" : "待生成口播稿"}
            onSelect={() => {
              setSelectedId(item.id);
              setWritingIntent("auto");
              setError("");
              if (canWrite) void loadRecommendations(organizationId, projectId, item.id);
            }}
          />
        )) : <p>当前企业空间还没有稿件。</p>}
      </RecordSidebar>
      <main key={selectedId} className="panel production-editor">{selected && pack ? <><div className="production-editor-head"><div><p className="section-kicker">{selected.generation_mode === "ai" ? `提示词 ${selected.prompt_version || "已记录"}` : isScaffold ? "待生成口播稿" : "人工稿件"}</p><h2>{selected.title}</h2><span>当前版本 v{selected.current_version} · {contentStatusLabels[selected.status as ContentStatus] || selected.status}</span>
          <div className="studio-origin-links">
            {rewriteLink && <Link href={rewriteLink}>查看来源改写 v{selected.rewrite_version} →</Link>}
            {reference ? <Link href={`/analysis/${encodeURIComponent(reference.videoId)}?${new URLSearchParams({ organizationId, projectId, analysisId: reference.analysisId })}`}>查看参考视频 →</Link> : topicLink && <Link href={topicLink}>查看来源灵感 →</Link>}
          </div></div><div className="generation-actions">{canEditSelected && referenceLink && <a className="primary-button" href={referenceLink}>{isScaffold ? "继续生成文案" : "按参考结构生成新版本"}</a>}{canEditSelected && !referenceLink && <><button type="button" disabled={Boolean(busy) || recommendationLoading} onClick={() => void runScopedAction(() => generateItem(selected.id), setError).finally(() => setBusy(""))}>{busy === `generate:${selected.id}` ? "生成中…" : isScaffold ? "生成口播稿" : "AI 生成新版本"}</button></>}{canEditSelected && (selected.status === "draft" || selected.status === "internal_revision") ? <button className="submit-review" type="button" disabled={Boolean(busy) || isScaffold} onClick={() => void submitForReview(selected.id)}>{busy === `review:${selected.id}` ? "提交中…" : "提交审核 →"}</button> : <a href={`/workflow?view=review&organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&contentId=${encodeURIComponent(selected.id)}`}>查看审核 →</a>}</div></div>
        {canEditSelected && ["internal_review", "client_review", "publish_ready"].includes(selected.status) && <div className="production-generation-status" role="status"><strong>修改后需要重新审核</strong><p>保存或重新生成会创建新版本，稿件回到内部修改；请重新提交审核后再登记发布。</p></div>}
        {canWrite && !canEditSelected && <div className="production-generation-status" role="status"><strong>当前稿件已锁定</strong><p>已发布、已复盘或已归档的稿件供查看，发布记录始终保留登记时的版本。</p></div>}
        {!referenceLink && <section className="production-generation-settings" aria-label="创作设置">
          <div className="production-settings-row">
            {canEditSelected ? <label>创作意图<select aria-label="创作意图" value={writingIntent} disabled={Boolean(busy)} onChange={(event) => setWritingIntent(event.target.value as WritingIntent)}>{Object.entries(writingIntentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : <span className="production-settings-label">创作依据</span>}
            {!isScaffold && pack.writingIntent && <p className="production-current-intent">当前稿件<span>{writingIntentLabels[pack.writingIntent.kind]}</span></p>}
          </div>
          <details className="production-generation-basis">
            <summary><span>查看生成依据</span><small>{canEditSelected ? `下次生成 · ${coreStrategy ? "策略已启用" : "未启用策略"} · 已选品牌资料 ${topicKnowledgeSelection(selected.selected_knowledge_ids_json).length} 条 · 已选对标 ${selectedBenchmarkIds.length} 条` : `本稿保留 ${selected.citation_count ?? pack.citations.length} 条来源证据`}</small></summary>
            <div className="production-generation-basis-body">
              {canEditSelected && <section><h3>下次生成</h3><p>{writingIntent === "auto" ? "AI 根据选题选择写法，无参考素材时也可创作科普或教程。" : `按“${writingIntentLabels[writingIntent]}”创作新版本。`}品牌资料沿用选题中的勾选，公司案例仅在选用相关资料时加入。</p><p>根据选题、内容方法和已选资料创作，不自动加入项目记忆或历史视频。</p></section>}
              {canEditSelected && <CoreStrategyPreview strategy={coreStrategy} />}
              {!isScaffold && <section className="production-saved-basis"><h3>当前版本 v{selected.current_version}</h3>{pack.writingIntent && <p>{writingIntentLabels[pack.writingIntent.kind]} · {pack.writingIntent.reason}</p>}<dl><div><dt>创作来源</dt><dd>{sourceLabels[selected.topic_source_type || "manual"] || selected.topic_source_type || "人工策划"}</dd></div><div><dt>实际引用</dt><dd>{selected.citation_count ?? pack.citations.length} 条来源证据 · {usedBenchmarkCount ? `${usedBenchmarkCount} 条对标` : "未引用对标"} · {usedMethodKnowledgeCount ? `${usedMethodKnowledgeCount} 项内容方法` : "未记录方法调用"} · {usedHistoricalCopyCount ? `${usedHistoricalCopyCount} 篇历史文案` : "未记录历史文案引用"}</dd></div></dl><p>这里记录已保存稿件的实际引用，重新生成后才会更新。</p></section>}
            </div>
          </details>
        </section>}
        {canEditSelected && !referenceLink && !template && deliveryPlan.features.videoAnalysis && <details className="benchmark-generation-context"><summary>调整这份旧稿的参考素材</summary><header><div><strong>智能推荐参考素材</strong><span>系统检索当前企业空间已分析对标。勾选后使用，可在生成依据中查看本稿的引用数量。</span></div><div><em>已选 {selectedBenchmarkIds.length}/5</em><button type="button" disabled={Boolean(busy) || recommendationLoading} onClick={() => void loadRecommendations(organizationId, projectId, selected.id)}>{recommendationLoading ? "检索中…" : "重新推荐"}</button></div></header>{benchmarks.length ? <div className="benchmark-generation-options">{benchmarks.slice(0, 50).map((entry) => <label key={entry.id} className={entry.recommended ? "recommended" : ""}><input aria-label={`选择参考素材：${entry.title || "未命名素材"}`} type="checkbox" disabled={Boolean(busy)} checked={selectedBenchmarkIds.includes(entry.id)} onChange={() => toggleBenchmark(entry.id)}/><span><strong>{entry.title || "未命名素材"}</strong><small>{entry.author_name || entry.category || "已完成分析"} · 匹配度 {entry.score}</small><small>{entry.reasons.slice(0, 2).join("；") || "综合素材内容与当前选题排序"}</small>{entry.feedback && (entry.feedback.approvedCount > 0 || entry.feedback.changesRequestedCount > 0 || entry.feedback.publishedCount > 0) && <small>本空间历史反馈：通过 {entry.feedback.approvedCount} · 退回 {entry.feedback.changesRequestedCount} · 发布 {entry.feedback.publishedCount}</small>}</span>{entry.recommended && <b>推荐</b>}{entry.hasOutcomeData && <b className="outcome">有真实数据</b>}</label>)}</div> : <p>{recommendationLoading ? "正在检索当前企业空间的对标内容库…" : <>当前企业空间的对标内容库还没有可用的已分析视频。请先进入<Link href="/analysis?view=benchmark">对标内容库</Link>添加并完成视频分析。</>}</p>}</details>}
        {isReferenceCreationReport(reference) && <ReferenceDraftResult report={reference} storyboard={pack.storyboard} />}
        {pack.benchmarkRewrite && <BenchmarkRewriteComparison report={pack.benchmarkRewrite}/>}
        {isScaffold && <div className="production-generation-status" role="status"><strong>{busy === `generate:${selected.id}` ? "正在生成完整口播稿…" : "这份内容尚未生成口播稿"}</strong><p>{selected.latest_generation_status === "failed" ? `上次生成未成功：${selected.latest_generation_error || "请重新生成。"} 下方留空，生成成功后会显示完整稿件。` : referenceLink ? "参考结构与选材已保存，可以继续确认材料并生成。" : "可以继续生成这份旧稿，或在下方编辑正文并保存。"}</p></div>}
        {!isScaffold && selected.latest_generation_status === "failed" && <div className="inline-alert" role="alert">最近一次生成未成功：{selected.latest_generation_error} 当前显示的是已保存的 v{selected.current_version}，没有被失败结果覆盖。</div>}
        <form ref={editor} key={`${selected.id}:${selected.current_version}`} className="production-form" onSubmit={saveVersion}><section>
          <div className="production-script-heading">
            <label htmlFor="production-full-script">完整口播稿</label>
            {canEditSelected && !isScaffold && pack.fullScript.trim().length >= 20 && (
              <button type="button" className="primary-button production-polish-button" disabled={Boolean(busy)} aria-busy={busy === "polish"} onClick={() => void runScopedAction(polishVersion, setError)}>
                <WandSparkles size={16} aria-hidden="true" />
                {busy === "polish" ? "正在打开…" : "润色这版"}
              </button>
            )}
          </div>
          <textarea id="production-full-script" name="fullScript" rows={16} defaultValue={isScaffold ? "" : pack.fullScript} placeholder="生成成功后，完整口播稿会显示在这里；也可以手动写稿。" readOnly={!canEditSelected || Boolean(busy)}/>
          {!isScaffold && !isReferenceCreationReport(reference) && !!pack.storyboard?.length && <DraftStoryboard shots={pack.storyboard} />}
          <label>精简版<textarea name="shortScript" rows={7} defaultValue={isScaffold ? "" : pack.shortScript} placeholder="填写或生成精简版口播稿" readOnly={!canEditSelected || Boolean(busy)}/></label>{canEditSelected && <div className="save-version"><input name="changeSummary" maxLength={500} placeholder="本次修改说明（可选）"/><button disabled={Boolean(busy)}>{busy === `save:${selected.id}` ? "保存中…" : "保存为新版本"}</button></div>}</section>
        </form></> : <div className="production-empty"><h2>开始创作稿件</h2><p>点上方「创作文案」，先选一条参考视频。</p></div>}</main>
    </SplitWorkspace>
  </div>;
}
