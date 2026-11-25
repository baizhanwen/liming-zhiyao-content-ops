"use client";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Search } from "lucide-react";
import { readApiError, formatClientDate } from "../lib/client-format";
import { isScopeCancellation } from "../lib/client-scope-request";
import { scopedFetch } from "../lib/client-scope";
import { studioHref } from "../lib/studio-links";
import type { LibraryIdea, StudioIdeaScope } from "../lib/studio-ideas";
import "./studio-ideas.css";

const sourceNames: Record<string,string> = { manual:"手动记录", project_assistant:"灵感对话", inspiration_card:"灵感卡片", video_analysis:"视频分析", analysis:"视频分析", benchmark:"对标内容", knowledge:"品牌知识", performance:"数据复盘", trend:"行业热点", comment:"评论需求", project_memory:"项目记忆" };
const historyNames: Record<string,string> = { archived:"已归档", rejected:"已拒绝", superseded:"历史版本" };

type Props = StudioIdeaScope & {
  focusId?: string; showHistoryInitially: boolean; refresh: number;
  cardActions: (idea: LibraryIdea) => ReactNode; onConversation: (id: string) => void;
};

export function StudioIdeaLibrary({organizationId, projectId, focusId="", showHistoryInitially, refresh, cardActions, onConversation}: Props) {
  const [note, setNote] = useState("");
  const pendingNote = useRef<{title:string; key:string}|null>(null);
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState(showHistoryInitially);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [canWrite, setCanWrite] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [ideas, setIdeas] = useState<LibraryIdea[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [settledQuery, setSettledQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<LibraryIdea|null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [focused, setFocused] = useState(focusId);
  const lastOpenedLink = useRef("");
  const requestKey = JSON.stringify([organizationId,projectId,history,query,offset,revision,refresh,focused]);
  const loading = settledQuery !== requestKey;

  useEffect(() => {
    if (!focusId || focused !== focusId || loading || lastOpenedLink.current === focusId) return;
    const idea = ideas.find(row => row.id === focusId || row.topicId === focusId);
    if (!idea) return;
    const record = document.getElementById(idea.kind + "-" + idea.id);
    if (record) {
      lastOpenedLink.current = focusId;
      record.focus({ preventScroll: true });
      record.scrollIntoView({ block: "start" });
    }
  }, [focusId, focused, loading, ideas]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({organizationId,projectId,view:"library",offset:String(offset)});
    if (history) params.set("history","1");
    if (query.trim()) params.set("q",query.trim());
    if (focused) params.set("focusId",focused);
    void (async () => {
      try {
        const response = await scopedFetch("/api/studio/ideas?"+params, {signal:controller.signal});
        if (!response.ok) throw new Error(await readApiError(response));
        const data = await response.json() as {ideas:LibraryIdea[];canWrite:boolean;canDelete:boolean;hasMore:boolean};
        if (controller.signal.aborted) return;
        if (focused && focused===focusId && !query && !history && !data.ideas.some(row=>row.id===focused || row.topicId===focused)) {
          const archived = new URLSearchParams(params);
          archived.set("history","1");
          const check = await scopedFetch("/api/studio/ideas?"+archived, {signal:controller.signal});
          if (check.ok) {
            const prior = await check.json() as {ideas: LibraryIdea[]};
            if (controller.signal.aborted) return;
            if (prior.ideas.some(row=>row.id===focused || row.topicId===focused)) { setHistory(true); return; }
          }
        }
        setError("");
        setIdeas(data.ideas);
        setCanWrite(data.canWrite);
        setCanDelete(data.canDelete);
        setHasMore(data.hasMore);
      } catch (reason) {
        if (!isScopeCancellation(reason) && !controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "暂时无法读取灵感库。");
          setIdeas([]); setHasMore(false);
        }
      } finally {
        if (!controller.signal.aborted) setSettledQuery(requestKey);
      }
    })();
    return () => controller.abort();
  }, [organizationId,projectId,history,query,offset,revision,refresh,focused,focusId,requestKey]);

  function showList(nextHistory: boolean) {
    setOffset(0); setHistory(nextHistory); setFocused(""); setNotice("");
  }
  async function saveNote(event: FormEvent) {
    event.preventDefault();
    if (saving || !canWrite || note.trim().length<2) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const title = note.trim();
      if (pendingNote.current?.title !== title) pendingNote.current = {title, key:Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")};
      const response = await scopedFetch("/api/topics",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({organizationId,projectId,title,noteKey:pendingNote.current.key})});
      if (!response.ok) throw new Error(await readApiError(response));
      const {topic} = await response.json() as {topic:{id:string}};
      pendingNote.current = null;
      setNote(""); setQuery(""); setOffset(0); setHistory(false); setFocused(topic.id); setRevision(n=>n+1); setNotice("已保存到灵感库。");
    } catch (reason) {
      if (!isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "暂时无法确认是否已保存，请刷新核对。");
    } finally { setSaving(false); }
  }
  async function deleteIdea(event: FormEvent) {
    event.preventDefault();
    if (!deleteCandidate || !canDelete || confirmation !== deleteCandidate.title || saving) return;
    setSaving(true); setError("");
    try {
      const response = await scopedFetch("/api/topics",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({organizationId,projectId,topicId:deleteCandidate.id,expectedUpdatedAt:deleteCandidate.updatedAt,confirmationTitle:confirmation})});
      if (!response.ok) throw new Error(await readApiError(response));
      setDeleteCandidate(null); setConfirmation(""); setOffset(0); setRevision(n=>n+1); setNotice("已从灵感库移除。");
    } catch (reason) {
      if (!isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "暂时无法确认是否已移除，请刷新核对。");
    } finally { setSaving(false); }
  }
  return <section id="studio-saved-ideas" className="panel inspiration-library-panel studio-idea-library" aria-label="已存灵感" tabIndex={-1}>
    <header className="studio-idea-controls">
      <div className="studio-idea-heading">
        <h2>已存灵感</h2>
        <div className="inspiration-library-tabs" role="group" aria-label="灵感状态">
          <button type="button" aria-pressed={!history} className={!history ? "active" : ""} onClick={() => showList(false)}>我的灵感</button>
          <button type="button" aria-pressed={history} className={history ? "active" : ""} onClick={() => showList(true)}>历史记录</button>
        </div>
        <label className="field-affix field-compact studio-idea-search">
          <Search aria-hidden="true" />
          <input type="search" aria-label="搜索灵感" placeholder="搜索灵感" value={query}
            onChange={event => { setQuery(event.target.value); setOffset(0); setFocused(""); }} />
        </label>
      </div>
      {canWrite && <form className="studio-quick-idea" onSubmit={saveNote}>
        <input aria-label="一句话灵感" placeholder="记下一句话灵感…" value={note} onChange={event => setNote(event.target.value)}
          minLength={2} maxLength={160} required disabled={saving} />
        <button type="submit" className="inspiration-button primary" disabled={saving || note.trim().length < 2}>
          {saving && !deleteCandidate ? "保存中…" : "保存灵感"}
        </button>
      </form>}
    </header>
    {notice && <p role="status" className="studio-idea-notice">{notice}</p>}
    {error && <p role="alert" className="inline-alert">{error} <button type="button" onClick={()=>setRevision(n=>n+1)}>重新读取</button></p>}
    {loading ? <p role="status" className="list-empty">正在读取灵感…</p> : ideas.length ? <div className="inspiration-card-grid">{ideas.map(idea => {
      const selected = focused === idea.id || focused === idea.topicId;
      const scope = {organizationId,projectId};
      const detailsAvailable = Boolean(idea.insight && idea.insight!==idea.title || idea.angle || idea.rationale || idea.conversationId || idea.drafts.length || (idea.kind==="card" || canDelete));
      return <article key={idea.kind+idea.id} id={idea.kind+"-"+idea.id} tabIndex={-1} className={"inspiration-library-card"+(selected?" studio-selected-record":"")}>
        <small>{sourceNames[idea.sourceType] || idea.sourceType} · {formatClientDate(idea.updatedAt)}{history?" · "+(historyNames[idea.status]||"已过期"):""}</small>
        <h3>{idea.title}</h3>
        {idea.active===1 && canWrite && <a className="inspiration-button primary studio-card-link" href={studioHref("create",{...scope,ideaId:idea.id,ideaKind:idea.kind})}>用这个想法写稿</a>}
        {detailsAvailable && <details className="studio-idea-details" open={selected || undefined}><summary>查看详情</summary><div>
          {idea.originalTitle && idea.originalTitle!==idea.title && <p>来源灵感 · {idea.originalTitle}</p>}
          {idea.insight && idea.insight!==idea.title && <p>{idea.insight}</p>}
          {idea.angle && <p>原选题角度 · {idea.angle}</p>}
          {idea.rationale && <p>原选题理由 · {idea.rationale}</p>}
          {idea.conversationId && <button type="button" className="inspiration-button ghost" onClick={()=>onConversation(idea.conversationId!)}>查看来源对话</button>}
          {idea.drafts.map(draft=><a className="studio-related-draft" key={draft.id} href={studioHref("drafts",{...scope,contentId:draft.id})}>查看稿件 · {draft.title}</a>)}
          {idea.kind==="card" ? cardActions(idea) : canDelete && <button type="button" className="inspiration-button danger-ghost" onClick={()=>{setDeleteCandidate(idea);setConfirmation("");}}>移除灵感</button>}
        </div></details>}
      </article>;
    })}</div> : <div className="list-empty">{query?"没有找到匹配的灵感":history?"暂无历史记录":"还没有灵感。可以先记下一句话，也可以从对话中保存。"}</div>}
    {!loading && (offset>0 || hasMore) && <div className="studio-idea-pagination"><button className="inspiration-button secondary" disabled={!offset} onClick={()=>setOffset(n=>Math.max(0,n-36))}>上一页</button><button className="inspiration-button secondary" disabled={!hasMore} onClick={()=>setOffset(n=>n+36)}>下一页</button></div>}
    {deleteCandidate && <div className="inspiration-modal-backdrop"><form className="stack-form inspiration-modal" role="dialog" aria-modal="true" aria-label="移除灵感" onSubmit={deleteIdea}>
      <h2>移除灵感</h2><p>{deleteCandidate.title}</p>
      <label>输入完整标题以确认<input value={confirmation} onChange={e=>setConfirmation(e.target.value)} required /></label>
      {error && <p role="alert">{error}</p>}
      <div className="inspiration-modal-actions"><button type="button" className="inspiration-button secondary" onClick={()=>setDeleteCandidate(null)}>取消</button><button className="inspiration-button primary" disabled={saving || confirmation!==deleteCandidate.title}>确认移除</button></div>
    </form></div>}
  </section>;
}
