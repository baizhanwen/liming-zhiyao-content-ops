"use client";

import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { scopedFetch } from "../../lib/client-scope";
import { generationFeedback } from "../../lib/ecommerce/generation-feedback";
import { isCurrentClientScope, isScopeCancellation, ScopeChangedError } from "../../lib/client-scope-request";
import type { z } from "zod";
import type { componentSchema, evidenceSchema, productSchema, scopeSchema } from "../../lib/ecommerce/contracts";

export type Scope = z.infer<typeof scopeSchema>;
export type Product = z.infer<typeof productSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type MethodCard = Omit<z.infer<typeof componentSchema>, "organizationId" | "projectId" | "id" | "revision">;
export type ProductRow = { id: string; name: string; sku: string; status: string; revision: number; version_id: string; current_version: number; public_json: string; internal_json: string; confirmed_by: string | null; confirmed_at: string | null };
export type EvidenceRow = { id: string; title: string; kind: string; status: string; revision: number; body_json: string; confirmed_by: string | null; confirmed_at: string | null; valid_until: string | null };
export type ComponentRow = { id: string; name: string; kind: MethodCard["kind"]; scope: string; status: string; revision: number; current_version: number; body_json: string; confirmed_by: string | null; confirmed_at: string | null };
export const statuses = { draft: "草稿", pending: "待确认", confirmed: "已确认", revoked: "已撤回" };
export const kinds = { hook: "钩子", visual: "卖点可视化", structure: "素材结构", sop: "拍摄 SOP" };
export const evidenceKinds = { specification: "规格资料", demonstration: "操作或实验演示", customer_permission: "客户授权资料", manual_confirmation: "人工确认", offer: "价格与活动" };
export const platforms = { douyin: "抖音", wechat_channels: "视频号", xiaohongshu: "小红书", other: "其他" };
export const targets = { product_click: "商品点击", live_entry: "直播进房", purchase: "成交" };
export const filmingKinds = { product: "可拍实物", hands: "手部演示", presenter: "真人出镜", location: "场地拍摄", comparison: "对照拍摄", screen: "录屏或资料画面" };
export const splitLines = (value: string) => [...new Set(value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
export const displayTime = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "未确认";
export function localTime(value: string | null) { if (!value) return ""; const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
export const isoTime = (value: string) => value ? new Date(value).toISOString() : null;

export class EcommerceApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export async function ecommerceApi<T>(scope: Scope, path: string, body?: unknown, method = "POST"): Promise<T> {
  const query = new URLSearchParams(scope);
  const response = await scopedFetch(`/api/ecommerce/${path}${path.includes("?") ? "&" : "?"}${query}`, body === undefined ? {} : {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...scope, ...(body as Record<string, unknown>) }),
  }, scope);
  const result = await response.json() as { error?: { message?: string; code?: string }; run?: { error_message?: string } };
  if (!isCurrentClientScope(scope)) throw new ScopeChangedError();
  if (!response.ok) throw new EcommerceApiError(result.error?.message ?? result.run?.error_message ?? "请求没有完成，请刷新运行记录后核对。", response.status, result.error?.code);
  return result as T;
}

export function useEcommerceAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const active = useRef(true), pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const act = useCallback(async (work: () => Promise<void>, success = "") => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setMessage("");
    try { await work(); if (active.current) setMessage(success); }
    catch (reason) { if (active.current && !isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "操作未完成"); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }, []);
  return { busy, error, message, act, setError };
}

// Several independent forms can be dirty at once. Saving one must not
// silently clear the navigation protection for the others.
export function useDirtySections(dirty: (value: boolean) => void) {
  const sections = useRef(new Set<string>());
  const mark = (section: string, value: boolean) => {
    if (value) sections.current.add(section); else sections.current.delete(section);
    dirty(sections.current.size > 0);
  };
  const discardSection = (section: string) => {
    if (sections.current.has(section) && !window.confirm("放弃此表单尚未保存的修改吗？")) return false;
    mark(section, false); return true;
  };
  return { mark, discardSection };
}

export function Notices({ error, message }: { error: string; message?: string }) {
  const feedback = error ? generationFeedback(error) : null;
  return <>{error && (feedback ? <div className="ec-notice ec-error" role="alert"><strong>{feedback.summary}</strong><ul>{feedback.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><p>这是生成结果的问题，无需手工填写或修改素材编号。可以重新生成；原有稿件保留。</p><details><summary>查看检查详情</summary><ul>{feedback.details.map(detail => <li key={detail}>{detail}</li>)}</ul></details></div> : <p className="ec-notice ec-error" role="alert">{error}</p>)}{message && <p className="ec-notice" role="status">{message}</p>}</>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  const control = isValidElement(children) ? cloneElement(children as ReactElement<{ id?: string; "aria-describedby"?: string }>, { id, "aria-describedby": hint ? `${id}-hint` : undefined }) : children;
  return <div className="ec-field"><label htmlFor={id}>{label}</label>{control}{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
export function TextField({ label, value, onChange, multiline = false, required = false, maxLength = 2000, hint }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; required?: boolean; maxLength?: number; hint?: string }) {
  return <Field label={label} hint={hint}>{multiline ? <textarea value={value} onChange={e => onChange(e.target.value)} rows={3} required={required} maxLength={maxLength} /> : <input value={value} onChange={e => onChange(e.target.value)} required={required} maxLength={maxLength} />}</Field>;
}
export function Choice<T extends string>({ label, value, values, onChange }: { label: string; value: T; values: Record<T, string>; onChange: (value: T) => void }) {
  return <Field label={label}><select value={value} onChange={e => onChange(e.target.value as T)}>{Object.entries<string>(values).map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></Field>;
}
export function Checks<T extends string>({ label, value, values, onChange }: { label: string; value: T[]; values: Record<T, string>; onChange: (value: T[]) => void }) {
  return <fieldset className="ec-checks"><legend>{label}</legend>{Object.entries<string>(values).map(([id, title]) => <label key={id}><input type="checkbox" checked={value.includes(id as T)} onChange={e => onChange(e.target.checked ? [...value, id as T] : value.filter(v => v !== id))} />{title}</label>)}</fieldset>;
}
export function TimeField({ label, value, onChange }: { label: string; value: string | null; onChange: (value: string | null) => void }) {
  return <Field label={label}><input type="datetime-local" value={localTime(value)} onChange={e => onChange(isoTime(e.target.value))} /></Field>;
}
export function MoneyField({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  // Keep the user's decimal string while typing, store integer minor units only.
  const [input, setInput] = useState(value === null ? "" : (value / 100).toFixed(2));
  return <Field label={label}><input type="number" min="0" step="0.01" value={input} onChange={e => { const v = e.target.value; setInput(v); onChange(v === "" ? null : Math.round(Number(v) * 100)); }} /></Field>;
}
export function State({ value, expires }: { value: string; expires?: string | null }) {
  const [now] = useState(Date.now);
  const expired = expires && Date.parse(expires) <= now;
  return <span className={`ec-state ${value === "confirmed" && !expired ? "ec-confirmed" : ""}`}>{expired ? "已过期" : statuses[value as keyof typeof statuses] ?? value}</span>;
}
