"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { preferredOrganizationId, rememberCurrentScope, scopedFetch } from "../lib/client-scope";
import { ModuleHeader } from "./ModuleHeader";
import { AppShell } from "./AppShell";

type Organization = { id: string; name: string };
type SearchResult = { type: string; id: string; project_id: string | null; title: string; subtitle: string | null; href: string };
const labels: Record<string, string> = { project: "项目", content: "内容", topic: "灵感", card: "灵感", video: "视频", knowledge: "知识", member: "成员" };

export function SearchWorkspace() {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState(""); const [results, setResults] = useState<SearchResult[]>([]); const [searched, setSearched] = useState(false); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/organizations");
        const body = await response.json() as { organizations?: Organization[] };
        const items = body.organizations ?? [];
        setOrganizations(items);
        setOrganizationId(preferredOrganizationId(items));
      } catch {
        setError("无法读取公司空间。");
      }
    })();
  }, []);
  async function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); const q = String(form.get("q") || "").trim(); if (!organizationId || q.length < 2) return; setLoading(true); setError(""); const response = await scopedFetch(`/api/search?organizationId=${encodeURIComponent(organizationId)}&q=${encodeURIComponent(q)}`); const body = await response.json() as { results?: SearchResult[]; error?: { message?: string } }; if (!response.ok) setError(body.error?.message || "搜索失败。"); else setResults(body.results ?? []); setSearched(true); setLoading(false); }
  function resultHref(item: SearchResult) {
    const [path, query] = item.href.split("?", 2);
    const params = new URLSearchParams(query);
    params.set("organizationId", organizationId);
    if (item.project_id) params.set("projectId", item.project_id);
    if (item.type === "content") params.set("contentId", item.id);
    if (item.type === "card") params.set("cardId", item.id);
    if (item.type === "topic") params.set("topicId", item.id);
    return `${path}?${params}`;
  }
  return <AppShell activePath="/search"><ModuleHeader title="全局搜索" /><form className="global-search-panel panel" onSubmit={search}><label className="field-affix"><Search aria-hidden="true" size={18} /><input name="q" aria-label="搜索关键词" minLength={2} maxLength={80} placeholder="输入至少两个字，例如：招聘、管理者、复盘" /></label><select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} aria-label="公司空间">{organizations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="primary-button" disabled={loading || !organizationId}>{loading ? "搜索中…" : "搜索"}</button></form>{error && <div className="inline-alert">{error}</div>}<section className="search-results panel">{results.map((item) => <Link href={resultHref(item)} onClick={() => item.project_id && rememberCurrentScope(organizationId, item.project_id)} key={`${item.type}:${item.id}`}><span>{labels[item.type] || item.type}</span><div><strong>{item.title}</strong><small>{item.subtitle || "利明智耀业务资产"}</small></div><em>打开 →</em></Link>)}{searched && !results.length && <div className="dashboard-empty">没有找到匹配记录，请更换关键词。</div>}{!searched && <div className="dashboard-empty">搜索结果会显示在这里。</div>}</section></AppShell>;
}
