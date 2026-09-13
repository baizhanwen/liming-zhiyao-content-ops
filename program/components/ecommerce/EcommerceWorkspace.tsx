"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadClientProjects, rememberCurrentScope, runScopedAction } from "../../lib/client-scope";
import { useWorkspaceInitialization } from "../useWorkspaceInitialization";
import { Products } from "./Products";
import { Methods } from "./Methods";
import { ecommerceApi, Field, Notices, useEcommerceAction, type Scope } from "./shared";
import "./ecommerce.css";

type Item = { id: string; name: string };
type Settings = { enabled: number; revision: number; max_concurrent: number; monthly_call_limit: number };
export function EcommerceWorkspace({ initialOrganizationId = "", initialProjectId = "" }: { initialOrganizationId?: string; initialProjectId?: string }) {
  const [organizations, setOrganizations] = useState<Item[]>([]), [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Item[]>([]), [projectId, setProjectId] = useState("");
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [dirty, setDirty] = useState(false);
  const scope = useMemo(() => ({ organizationId, projectId }), [organizationId, projectId]);
  const discard = () => !dirty || window.confirm("还有未保存的修改，确定离开当前表单吗？");
  const loadProjects = useCallback(async (org: string, requested = "") => {
    setProjectId(""); setProjects([]);
    const data = await loadClientProjects<Item>(org, requested);
    setProjects(data.projects); setProjectId(data.selected); rememberCurrentScope(org, data.selected);
  }, []);
  useWorkspaceInitialization({ initialOrganizationId, initialProjectId, setOrganizations, setOrganizationId, loadProjects, setError, setLoading });
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  if (loading) return <div className="management-state" role="status">正在加载企业空间…</div>;
  return <div className="ec-workspace"><div className="ec-scope"><Field label="公司"><select value={organizationId} onChange={event => { const id = event.target.value; if (discard()) { setDirty(false); setOrganizationId(id); void runScopedAction(() => loadProjects(id), setError); } }}>{organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field><Field label="企业空间"><select value={projectId} onChange={event => { if (discard()) { setDirty(false); setProjectId(event.target.value); rememberCurrentScope(organizationId, event.target.value); } }}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><a className="ec-back" href={`/content?${new URLSearchParams(scope)}`} onClick={event => { if (!discard()) event.preventDefault(); }}>返回普通内容</a></div><Notices error={error} />{projectId ? <ProjectWorkspace key={`${organizationId}:${projectId}`} scope={scope} dirty={setDirty} discard={discard} /> : <p className="ec-panel">请先选择一个可访问的企业空间。</p>}</div>;
}

function ProjectWorkspace({ scope, dirty, discard }: { scope: Scope; dirty: (value: boolean) => void; discard: () => boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null), [canManage, setCanManage] = useState(false), [tab, setTab] = useState<"products" | "methods">("products");
  const action = useEcommerceAction();
  const load = useCallback(async () => { const result = await ecommerceApi<{ settings: Settings; canManage: boolean }>(scope, "settings"); setSettings(result.settings); setCanManage(result.canManage); }, [scope]);
  const { act } = action;
  useEffect(() => { void act(load); }, [act, load]);
  const enabled = Boolean(settings?.enabled);
  return <><Notices error={action.error} message={action.message} />{!settings ? <div className="ec-panel"><p role="status">{action.error ? "电商设置未加载。" : "正在读取电商设置…"}</p>{action.error && <button type="button" onClick={() => void action.act(load)}>重新加载</button>}</div> : <>
    <section className="ec-panel ec-settings"><div className="ec-panel-head"><div><strong>{enabled ? "电商素材已启用" : "电商素材未启用"}</strong><p className="ec-muted">{enabled ? "按当前空间保存商品与任务，生成计入公司的模型额度。" : "当前可查看已有资料。由公司管理员启用后才能保存与生成。"}</p></div>{canManage && <details><summary>空间设置</summary><form key={settings.revision} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void action.act(async () => { const result = await ecommerceApi<{ settings: Settings }>(scope, "settings", { enabled: form.has("enabled"), revision: settings.revision, maxConcurrent: Number(form.get("concurrent")), monthlyCallLimit: Number(form.get("limit")) }, "PUT"); setSettings(result.settings); }, "电商空间设置已保存。"); }}><fieldset className="ec-form" disabled={action.busy}><label className="ec-check"><input type="checkbox" name="enabled" defaultChecked={enabled} />启用当前空间电商素材</label><Field label="同时生成任务数"><input type="number" name="concurrent" defaultValue={settings.max_concurrent} min={1} max={3} required /></Field><Field label="每月模型调用上限" hint="一次完整生成通常包含计划、成稿与校对等多次模型调用。"><input type="number" name="limit" defaultValue={settings.monthly_call_limit} min={1} max={10000} required /></Field><button type="submit" aria-busy={action.busy}>保存设置</button></fieldset></form></details>}</div></section>
    <nav className="ec-tabs" aria-label="电商素材工作区"><button type="button" aria-current={tab === "products" ? "page" : undefined} onClick={() => { if (tab !== "products" && discard()) { dirty(false); setTab("products"); } }}>商品资料</button><button type="button" aria-current={tab === "methods" ? "page" : undefined} onClick={() => { if (tab !== "methods" && discard()) { dirty(false); setTab("methods"); } }}>素材组件</button></nav>
    {tab === "products" ? <Products scope={scope} enabled={enabled} dirty={dirty} discard={discard} /> : <Methods scope={scope} enabled={enabled} canManage={canManage} dirty={dirty} discard={discard} />}
  </>}</>;
}
