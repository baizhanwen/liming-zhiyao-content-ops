"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { readApiError } from "../lib/client-format";
import { contentTimeLabel } from "../lib/content-analysis-presentation";
import { rememberCurrentScope, scopedFetch } from "../lib/client-scope";
import { isScopeCancellation } from "../lib/client-scope-request";
import type { StructureDraftPreview } from "../lib/structure-draft";
import type { ReferenceMaterialQuestion } from "../lib/reference-material-questions";
import type { ContentGenerationProgress } from "../lib/content-generation-progress";
import type { ProductionPack } from "../lib/content-production";
import { structureDraftHref, studioHref } from "../lib/studio-links";
import { isReferenceCreationReport, type ReferenceCreationInput, type ReferenceCreationReport } from "../lib/structure-creation";
import { ModuleHeader } from "./ModuleHeader";
import { CoreStrategyPreview } from "./CoreStrategyPreview";
import { DraftGenerationProgressCard } from "./DraftGenerationProgressCard";
import { useDraftGenerationProgress } from "./useDraftGenerationProgress";
import { ReferenceDraftResult } from "./ReferenceDraftResult";
import { ReferenceSegmentSuggestion } from "./ReferenceSegmentSuggestion";
import { ReferenceIdeaPicker, readReferenceIdeas, type SelectableIdea } from "./ReferenceIdeaPicker";
import "./reference-draft.css";

type Segment = ReferenceCreationInput["segments"][number];
type Idea = NonNullable<ReferenceCreationInput["idea"]>;
type Preview = StructureDraftPreview & { canWrite: boolean };
type Props = { organizationId: string; projectId: string; videoId: string; analysisId: string; libraryEntryId: string; initialContentId: string; initialIdeaId?: string; initialIdeaKind?: Idea["kind"] };
type DraftItem = { id: string; current_version: number; status: string; pack_json: string };
const displays = { spoken: "口播", screen: "画面或字幕", both: "口播配上屏文字", original_sound: "保留原声", screen_table: "上屏表格" } as const;

function savedPack(item: DraftItem) {
  return JSON.parse(item.pack_json) as Partial<Pick<ProductionPack, "referenceCreation" | "storyboard">>;
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json() as Promise<T>;
}

export function ReferenceDraftComposer(props: Props) {
  const { organizationId, projectId, videoId, analysisId, libraryEntryId, initialContentId, initialIdeaId, initialIdeaKind } = props;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [topicMode, setTopicMode] = useState<ReferenceCreationInput["topicMode"]>("reference");
  const [customTopic, setCustomTopic] = useState("");
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [showIdeas, setShowIdeas] = useState(false);
  const [focus, setFocus] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [materialQuestions, setMaterialQuestions] = useState<ReferenceMaterialQuestion[]>([]);
  const [draft, setDraft] = useState<{ id: string; version: number } | null>(null);
  const [result, setResult] = useState<{ report: ReferenceCreationReport; storyboard?: ProductionPack["storyboard"] } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [retry, setRetry] = useState(0);
  const pendingDraft = useRef<{ input: string; id: string } | null>(null);
  const submitting = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const segmentOptions = useRef<HTMLDetailsElement>(null);
  const noteFields = useRef(new Map<string, HTMLTextAreaElement>());
  const params = new URLSearchParams({ organizationId, projectId, analysisId });
  if (libraryEntryId) params.set("libraryEntryId", libraryEntryId);
  const sourceUrl = `/api/videos/${encodeURIComponent(videoId)}/structure-draft`;
  const previewUrl = `${sourceUrl}?${params}`;
  const backUrl = `/analysis/${encodeURIComponent(videoId)}?${params}`;
  const changeReferenceUrl = studioHref("create", { organizationId, projectId, ideaId: selectedIdea?.id, ideaKind: selectedIdea?.kind });
  const editUrl = (id: string) => structureDraftHref({ organizationId, projectId, analysisId, videoId, libraryEntryId, contentId: id });
  const onProgressTerminal = useCallback((progress: ContentGenerationProgress, contentId: string) => {
    submitting.current = null;
    setBusy("");
    if (progress.status === "completed") window.location.assign(studioHref("drafts", { organizationId, projectId, contentId }));
    if (progress.status === "needs_material") setMaterialQuestions(progress.materialQuestions);
    if (progress.status === "failed" && ["CONTENT_VERSION_CONFLICT", "REFERENCE_STRUCTURE_CHANGED", "INVALID_REFERENCE_MATERIAL", "REFERENCE_CONTEXT_CHANGED"].includes(progress.errorCode ?? "")) setConflict(true);
  }, [organizationId, projectId]);
  const progress = useDraftGenerationProgress(organizationId, projectId, onProgressTerminal);
  const { resume } = progress;
  const generating = Boolean(busy) || progress.locked;
  const readDraft = useCallback(async (id: string, signal: AbortSignal) => {
    const query = new URLSearchParams({ organizationId, projectId, contentId: id });
    const data = await readResponse<{ items: DraftItem[] }>(await scopedFetch(`/api/content-items?${query}`, { signal }));
    const item = data.items.find(row => row.id === id);
    if (!item) throw new Error("当前空间中找不到这篇稿件。");
    if (["published", "reviewed", "archived"].includes(item.status)) throw new Error("这篇稿件已锁定。可以从原分析创建另一篇。");
    return item;
  }, [organizationId, projectId]);

  useEffect(() => {
    rememberCurrentScope(organizationId, projectId);
    const operation = new AbortController();
    controller.current = operation;
    async function load() {
      try {
        const preselect = !initialContentId && initialIdeaId && initialIdeaKind;
        const [data, item, picked] = await Promise.all([
          scopedFetch(previewUrl, { signal: operation.signal }).then(response => readResponse<Preview>(response)),
          initialContentId ? readDraft(initialContentId, operation.signal) : null,
          preselect ? readReferenceIdeas(organizationId, projectId, { ideaId: initialIdeaId, ideaKind: initialIdeaKind }, operation.signal)
            .then(ideas => ({ idea: ideas[0] }))
            .catch((reason: unknown) => ({ idea: null, error: reason instanceof Error ? reason.message : "读取灵感失败。" })) : null,
        ]);
        if (operation.signal.aborted) return;
        if (!data.canWrite) throw new Error("当前账号只有查看权限。请由可创作的空间成员生成稿件。");
        const pack = item ? savedPack(item) : undefined;
        const saved = pack?.referenceCreation;
        if (item && (!saved || saved.videoId !== videoId || saved.analysisId !== analysisId)) throw new Error("这篇稿件与当前参考分析不匹配。");
        setFocus(saved?.focus ?? "");
        setResult(isReferenceCreationReport(saved) ? { report: saved, storyboard: pack?.storyboard } : null);
        if (saved) {
          setTopicMode(saved.topicMode);
          setCustomTopic(saved.customTopic ?? "");
          setSelectedIdea(saved.idea ?? null);
        } else if (preselect) {
          setTopicMode("custom");
          if (picked?.idea) {
            setCustomTopic(picked.idea.title);
            setSelectedIdea({ id: picked.idea.id, kind: picked.idea.kind });
          } else {
            setError(picked && "error" in picked ? picked.error : "这条灵感已不可用，请直接填写选题或重新选择。");
          }
        } else {
          setTopicMode(data.referenceTopic ? "reference" : "custom");
        }
        const available = new Set(data.materials.map(row => row.id));
        setSegments(data.segments.map(source => {
          const old = saved?.segments.find(segment => segment.segmentId === source.segmentId);
          return { segmentId: source.segmentId, role: source.role, materialIds: old?.materialIds.filter(id => available.has(id)) ?? [],
            note: old?.note ?? "", presentation: old?.presentation ?? source.presentation };
        }));
        if (saved?.segments.some(s => s.materialIds.some(id => !available.has(id)))) setError("部分历史材料已失效，请逐段重新确认。");
        if (item) {
          setDraft({ id: item.id, version: item.current_version });
          resume(item.id, item.current_version);
        }
        setPreview(data);
      } catch (reason) {
        if (!operation.signal.aborted && !isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "读取参考资料失败。");
      }
    }
    void load();
    return () => { operation.abort(); };
  }, [organizationId, projectId, videoId, analysisId, previewUrl, initialContentId, initialIdeaId, initialIdeaKind, readDraft, retry, resume]);

  function selectIdea(idea: SelectableIdea) {
    setSelectedIdea({ id: idea.id, kind: idea.kind });
    setCustomTopic(idea.title);
    setShowIdeas(false);
    setError("");
  }

  function selectMode(mode: ReferenceCreationInput["topicMode"]) {
    if (selectedIdea) setCustomTopic("");
    setSelectedIdea(null);
    setShowIdeas(false);
    setTopicMode(mode);
  }

  function update(index: number, change: Partial<Segment>) {
    setSegments(current => current.map((row, i) => i === index ? { ...row, ...change } : row));
  }

  useEffect(() => {
    if (busy || !materialQuestions.length) return;
    if (segmentOptions.current) segmentOptions.current.open = true;
    for (const question of materialQuestions) {
      const segment = noteFields.current.get(question.segmentId)?.closest("details");
      if (segment) segment.open = true;
    }
    noteFields.current.get(materialQuestions[0].segmentId)?.focus();
  }, [busy, materialQuestions]);

  const referenceCreation: ReferenceCreationInput = {
    videoId, analysisId, topicMode, ...(topicMode === "custom" && { customTopic: customTopic.trim() }),
    ...(topicMode === "custom" && selectedIdea && { idea: selectedIdea }),
    ...(focus.trim() && { focus: focus.trim() }), segments,
  };
  const suggestionContext = JSON.stringify(referenceCreation);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || !preview || submitting.current || progress.locked || conflict) return;
    const generationRequestId = progress.begin();
    submitting.current = generationRequestId;
    const isCurrent = () => !signal.aborted && submitting.current === generationRequestId;
    let awaitingResult = false;
    setMaterialQuestions([]);
    setError(""); setBusy("正在生成…");
    const post = (url: string, body: object) => scopedFetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal, body: JSON.stringify({ organizationId, projectId, ...body }) });
    try {
      if (!preview.strategy) {
        const current = await readResponse<Preview>(await scopedFetch(previewUrl, { signal }));
        if (!isCurrent()) return;
        if (!current.strategy) throw new Error("当前空间还没有启用内容策略，启用后可回到这里生成。");
        setPreview({ ...preview, strategy: current.strategy });
      }
      let target = draft;
      if (!target) {
        const input = JSON.stringify(referenceCreation);
        if (pendingDraft.current?.input !== input) pendingDraft.current = { input, id: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("") };
        const created = await readResponse<{ contentId: string; version: number }>(await post(sourceUrl, { requestId: pendingDraft.current.id, libraryEntryId: libraryEntryId || undefined, referenceCreation }));
        if (!isCurrent()) return;
        target = { id: created.contentId, version: created.version };
        setDraft(target);
        window.history.replaceState(window.history.state, "", editUrl(target.id));
      }
      progress.track({ contentId: target.id, version: target.version });
      awaitingResult = true;
      const response = await post(`/api/content-items/${encodeURIComponent(target.id)}/generate`, { expectedVersion: target.version, generationRequestId, creationMode: "single_benchmark", modelProfile: "max", referenceCreation });
      if (!isCurrent()) return;
      if (!response.ok && response.headers.get("content-type")?.includes("application/json")) awaitingResult = false;
      if (response.status === 422) {
        const problem = await response.clone().json().catch(() => null) as { error?: { code?: string }; materialQuestions?: ReferenceMaterialQuestion[] } | null;
        if (problem?.error?.code === "REFERENCE_MATERIAL_NEEDED" && Array.isArray(problem.materialQuestions)) {
          const questions = problem.materialQuestions.filter(q => q && typeof q.question === "string" && q.question.trim() && segments.some(s => s.segmentId === q.segmentId));
          if (questions.length && isCurrent()) {
            progress.finish("needs_material", `有 ${questions.length} 段需要补充材料。`);
            setMaterialQuestions(questions);
            return;
          }
        }
      }
      if (response.status === 409) {
        const problem = await response.clone().json().catch(() => null) as { error?: { code?: string } } | null;
        if (isCurrent() && ["CONTENT_VERSION_CONFLICT", "REFERENCE_STRUCTURE_CHANGED", "INVALID_REFERENCE_MATERIAL", "REFERENCE_CONTEXT_CHANGED"].includes(problem?.error?.code || "")) setConflict(true);
      }
      const { item } = await readResponse<{ item: DraftItem }>(response);
      if (!isCurrent()) return;
      const { referenceCreation: report, storyboard } = savedPack(item);
      if (!isReferenceCreationReport(report)) throw new Error("已保存版本缺少逐段交付，请打开稿件核对。");
      progress.finish("completed");
      setDraft({ id: target.id, version: item.current_version }); setResult({ report, storyboard });
      window.location.assign(studioHref("drafts", { organizationId, projectId, contentId: target.id }));
    } catch (reason) {
      if (isCurrent() && !isScopeCancellation(reason)) {
        if (awaitingResult) progress.disconnect();
        else progress.finish("failed", reason instanceof Error ? reason.message : "生成失败，请重试。");
      }
    } finally {
      if (isCurrent()) {
        submitting.current = null;
        setBusy("");
      }
    }
  }
  return <>
    <ModuleHeader title="创作文案" actions={<a className="secondary-link" href={draft ? studioHref("drafts", { organizationId, projectId, contentId: draft.id }) : changeReferenceUrl}>{draft ? "← 返回稿件" : "← 重选参考视频"}</a>} />
    <div className="reference-composer">
      {preview && <p className="reference-source-link">参考视频 · <a href={backUrl} target="_blank" rel="noreferrer">{preview.referenceTitle}</a></p>}
    {!preview ? <div className="management-state" role={error ? "alert" : "status"}>{error || "正在读取选定版本的分析…"} {error && <button onClick={() => { setError(""); setRetry(n => n + 1); }}>重新读取</button>}</div>
      : <><form onSubmit={generate}>
        <fieldset className="reference-topic" disabled={generating}><legend>这篇文案用哪个选题？</legend>
          <div className="reference-topic-options">{(["reference", "custom"] as const).map(mode => <label key={mode}><input type="radio" name="topicMode" checked={topicMode === mode} disabled={Boolean(draft) || (mode === "reference" && !preview.referenceTopic)} onChange={() => selectMode(mode)} />{mode === "reference" ? "沿用参考视频的选题" : "使用我的选题"}</label>)}</div>
          {topicMode === "reference" ? <p className="reference-topic-title">{preview.referenceTopic}</p> : <>
            {!preview.referenceTopic && <p className="reference-topic-hint">这版参考分析没有提取到选题，请填写本次题目。</p>}
            <div className="reference-custom-topic"><input aria-label="我的选题" required maxLength={300} readOnly={Boolean(draft)} value={customTopic} onChange={e => { setCustomTopic(e.target.value); setSelectedIdea(null); }}
              placeholder="写下这篇想讲什么" />
              {!draft && <button type="button" aria-expanded={showIdeas} aria-controls={showIdeas ? "reference-idea-picker" : undefined}
                onClick={() => setShowIdeas(open => !open)}>{showIdeas ? "收起灵感库" : "从灵感库选择"}</button>}
            </div>
            {showIdeas && !draft && <ReferenceIdeaPicker organizationId={organizationId} projectId={projectId} onSelect={selectIdea} />}
          </>}
          {draft && <a href={structureDraftHref({ organizationId, projectId, videoId, analysisId, libraryEntryId })}>换个选题另写一篇</a>}
        </fieldset>
        {!preview.strategy && <p className="reference-material-question">生成前请先<a target="_blank" rel="noreferrer" href={`/space?${new URLSearchParams({ organizationId, projectId, tab: "strategy" })}`}>启用本空间的内容策略</a>。</p>}
        <details className="reference-options" ref={segmentOptions}><summary>查看参考结构与本次材料 <small>{segments.length} 段</small></summary>
          <fieldset disabled={generating} aria-label="调整分段与材料">
          {segments.map((row, i) => {
            const question = materialQuestions.find(q => q.segmentId === row.segmentId);
            return <details className="reference-segment" key={row.segmentId}>
            <summary>{i + 1}. {row.role}{question && <small>待补材料</small>}</summary>
            <div className="reference-segment-heading">
              <label>呈现方式<select value={row.presentation} onChange={event => update(i, { presentation: event.target.value as Segment["presentation"] })}>{Object.entries(displays).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            </div>
            {preview.segments[i]?.excerpt && <details><summary>参考片这一段{preview.segments[i].startMs !== null && ` · ${contentTimeLabel(preview.segments[i].startMs)}${preview.segments[i].endMs !== null ? "–" + contentTimeLabel(preview.segments[i].endMs) : ""}`}</summary><p>{preview.segments[i].excerpt}</p></details>}
            {preview.materials.length > 0 && <details><summary>{row.materialIds.length ? `已选 ${row.materialIds.length} 条 · ${preview.materials.filter(m => row.materialIds.includes(m.id)).map(m => m.title).join("、")}` : "选择品牌资料"}</summary>
              <div className="reference-materials">{preview.materials.map(m => <label key={m.id}><input type="checkbox" checked={row.materialIds.includes(m.id)} onChange={e => update(i, { materialIds: e.target.checked ? [...row.materialIds, m.id] : row.materialIds.filter(id => id !== m.id) })} /><span>{m.title}<small>{m.body}</small></span></label>)}</div>
            </details>}
            {question && <p id={`material-question-${row.segmentId}`} className="reference-material-question" role="status">{question.question}</p>}
            <div className="reference-segment-note">
              <label htmlFor={`reference-note-${row.segmentId}`}>本段补充</label>
              {!generating && <ReferenceSegmentSuggestion
                key={suggestionContext + (question?.question ?? "")}
                sourceUrl={sourceUrl} organizationId={organizationId} projectId={projectId} libraryEntryId={libraryEntryId}
                referenceCreation={referenceCreation} segment={row} materialQuestion={question?.question}
                disabled={conflict || (topicMode === "custom" && !customTopic.trim())}
                onFocusNote={() => noteFields.current.get(row.segmentId)?.focus()}
                onApply={note => {
                  update(i, { note });
                  noteFields.current.get(row.segmentId)?.focus();
                }} />}
              <textarea id={`reference-note-${row.segmentId}`} ref={element => { if (element) noteFields.current.set(row.segmentId, element); else noteFields.current.delete(row.segmentId); }}
                aria-describedby={question ? `material-question-${row.segmentId}` : undefined}
                value={row.note} maxLength={2000} rows={2} onChange={e => update(i, { note: e.target.value })} placeholder={row.presentation === "screen_table" ? "表里需要哪几列、比较哪些对象？" : "可直接填写这段要用的材料"} />
            </div>
          </details>; })}
          </fieldset>
          {preview.strategy && <CoreStrategyPreview strategy={preview.strategy} />}
        </details>
        <label className="reference-focus">补充一句（选填）
          <input maxLength={300} disabled={generating} value={focus} onChange={e => { setFocus(e.target.value); setMaterialQuestions([]); }} placeholder="这篇最想讲清哪一点？" />
        </label>
        {progress.view && <DraftGenerationProgressCard {...progress.view} onRefresh={progress.refresh} />}
        <div className="reference-submit">{error && <p role="alert">{error}</p>}
          {materialQuestions.length > 0 && <span>请在标出的段落补充材料，或调整本次写作重点后重新生成。</span>}
          {conflict && draft ? <a href={editUrl(draft.id)}>重新读取当前稿件版本</a> : <button className="primary-button" disabled={generating || (topicMode === "custom" && !customTopic.trim()) || !segments.length}>{generating ? "正在生成…" : (result ? "生成新版本" : "生成文案")}</button>}
          {draft && <a href={studioHref("drafts", { organizationId, projectId, contentId: draft.id })}>打开稿件 v{draft.version}</a>}
        </div>
      </form>
      {result && <ReferenceDraftResult {...result} />}</>}
    </div>
  </>;
}
