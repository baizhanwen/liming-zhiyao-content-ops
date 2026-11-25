"use client";

import { useEffect, useState } from "react";
import { readApiError } from "../lib/client-format";
import { scopedFetch } from "../lib/client-scope";
import { isScopeCancellation } from "../lib/client-scope-request";
import type { ReferenceCreationInput } from "../lib/structure-creation";

type Idea = NonNullable<ReferenceCreationInput["idea"]>;
export type SelectableIdea = Idea & { title: string };

export async function readReferenceIdeas(organizationId: string, projectId: string, filter: { q?: string; ideaId?: string; ideaKind?: string }, signal: AbortSignal) {
  const params = new URLSearchParams({ organizationId, projectId, ...filter });
  const response = await scopedFetch(`/api/studio/ideas?${params}`, { signal });
  if (!response.ok) throw new Error(await readApiError(response));
  const { ideas } = await response.json() as { ideas: SelectableIdea[] };
  return ideas;
}

export function ReferenceIdeaPicker({ organizationId, projectId, onSelect }: {
  organizationId: string; projectId: string; onSelect: (idea: SelectableIdea) => void;
}) {
  const [query, setQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ query: string; ideas: SelectableIdea[]; error?: string } | null>(null);
  const search = query.trim();
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const ideas = await readReferenceIdeas(organizationId, projectId, { q: search }, controller.signal);
        if (!controller.signal.aborted) setResponse({ query: search, ideas });
      } catch (reason) {
        if (!controller.signal.aborted && !isScopeCancellation(reason)) setResponse({ query: search, ideas: [], error: reason instanceof Error ? reason.message : "读取灵感库失败。" });
      }
    }, search ? 160 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [organizationId, projectId, search, retry]);

  return <div className="reference-idea-picker" id="reference-idea-picker">
    <input type="search" aria-label="搜索灵感库" placeholder="搜索灵感库" value={query} maxLength={160}
      onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") e.preventDefault(); }} />
    {!response || response.query !== search ? <p role="status">正在读取灵感…</p>
      : response.error ? <p role="alert">{response.error} <button type="button" onClick={() => { setResponse(null); setRetry(n => n + 1); }}>重试</button></p>
      : response.ideas.length ? <ul aria-label="可选灵感">{response.ideas.map(idea => <li key={idea.kind + ":" + idea.id}>
        <button type="button" onClick={() => onSelect(idea)}>{idea.title}</button>
      </li>)}</ul> : <p role="status">{search ? "没找到匹配的灵感，可以直接填写选题。" : "灵感库还是空的，可以直接填写选题。"}</p>}
  </div>;
}
