"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AppShell } from "./AppShell";

type Organization = { id: string; name: string };
type SearchResult = { type: string; id: string; title: string; subtitle: string | null; href: string };
const labels: Record<string, string> = { project: "项目", content: "内容", topic: "选题", video: "视频", knowledge: "知识", member: "成员" };

export function SearchWorkspace() {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState(""); const [results, setResults] = useState<SearchResult[]>([]); const [searched, setSearched] = useState(false); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  useEffect(() => { fetch("/api/organizations").then((response) => response.json()).then((body: { organizations?: Organization[] }) => { const items = body.organizations ?? []; setOrganizations(items); setOrganizationId(items[0]?.id ?? ""); }).catch(() => setError("无法读取公司空间。")); }, []);
  async function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); const q = String(form.get("q") || "").trim(); if (!organizationId || q.length < 2) return; setLoading(true); setError(""); const response = await fetch(`/api/search?organizationId=${encodeURIComponent(organizationId)}&q=${encodeURIComponent(q)}`); const body = await response.json() as { results?: SearchResult[]; error?: { message?: string } }; if (!response.ok) setError(body.error?.message || "搜索失败。"); else setResults(body.results ?? []); setSearched(true); setLoading(false); }
  return <AppShell activePath="/search"><section className="page-heading"><div><p>跨业务资产检索</p><h1>全局搜索</h1><span>搜索项目、内容、选题、视频、知识和成员。</span></div></section><form className="global-search-panel panel" onSubmit={search}><label><span aria-hidden="true">⌕</span><input name="q" minLength={2} maxLength={80} placeholder="输入至少两个字，例如：招聘、管理者、复盘" /></label><select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} aria-label="公司空间">{organizations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="primary-button" disabled={loading || !organizationId}>{loading ? "搜索中…" : "搜索"}</button></form>{error && <div className="inline-alert">{error}</div>}<section className="search-results panel">{results.map((item) => <Link href={item.href} key={`${item.type}:${item.id}`}><span>{labels[item.type] || item.type}</span><div><strong>{item.title}</strong><small>{item.subtitle || "利明智耀业务资产"}</small></div><em>打开 →</em></Link>)}{searched && !results.length && <div className="dashboard-empty">没有找到匹配记录，请更换关键词。</div>}{!searched && <div className="dashboard-empty">搜索结果会显示在这里。</div>}</section></AppShell>;
}
