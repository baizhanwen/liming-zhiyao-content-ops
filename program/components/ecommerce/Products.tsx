"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { productInternalSchema, productPublicSchema } from "../../lib/ecommerce/contracts";
import { isScopeCancellation } from "../../lib/client-scope-request";
import { productQuestionOptions } from "../../lib/ecommerce/product-question-options";
import { ProductChoiceField } from "./ProductChoiceField";
import { Choice, displayTime, ecommerceApi, evidenceKinds, Field, MoneyField, Notices, State, statuses, TextField, useEcommerceAction, type Evidence, type EvidenceRow, type Product, type ProductRow, type Scope } from "./shared";

type Props = {
  scope: Scope; enabled: boolean; dirty: (value: boolean) => void; discard: () => boolean;
  guidedStep?: "product" | "evidence";
  selectedProductId?: string;
  onSelectProduct?: (id: string) => void;
  onSaved?: (id: string) => void;
  onProgressChange?: () => void;
  onCreateCopy?: (versionId: string) => void;
};
export function Products({ scope, enabled, dirty, discard, guidedStep, selectedProductId, onSelectProduct, onSaved, onProgressChange, onCreateCopy }: Props) {
  const [rows, setRows] = useState<ProductRow[]>([]), [localSelectedId, setLocalSelectedId] = useState(""), [loaded, setLoaded] = useState(false);
  const selectedId = selectedProductId ?? localSelectedId;
  const mounted = useRef(false), selectionVersion = useRef(0), readVersion = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; selectionVersion.current += 1; readVersion.current += 1; }; }, []);
  useLayoutEffect(() => { selectionVersion.current += 1; }, [selectedId, guidedStep, scope.organizationId, scope.projectId]);
  const select = (id: string) => { selectionVersion.current += 1; setLocalSelectedId(id); onSelectProduct?.(id); };
  const beginSave = () => { const version = selectionVersion.current; return () => mounted.current && version === selectionVersion.current; };
  const action = useEcommerceAction();
  const load = useCallback(async () => { const version = ++readVersion.current; const data = await ecommerceApi<{ products: ProductRow[] }>(scope, "products"); if (!mounted.current || version !== readVersion.current) return; setRows(data.products); setLoaded(true); }, [scope]);
  const { act } = action;
  useEffect(() => { void act(load); }, [act, load]);
  const selected = rows.find(row => row.id === selectedId);
  const priceLabel = (row: ProductRow) => { try { const facts = JSON.parse(row.public_json) as { priceCents: number | null; currency: string }; return typeof facts.priceCents !== "number" ? "未填写价格" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: facts.currency || "CNY" }).format(facts.priceCents / 100); } catch { return "未填写价格"; } };
  const pick = (id: string) => { if (id !== selectedId && discard()) { dirty(false); select(id); } };
  const editor = !loaded ? <p role="status">正在加载商品…</p> : selectedId && !selected
    ? <p className="ec-muted">所选商品当前不可用，请重新选择商品。</p>
    : <ProductEditor key={`${selected?.id ?? "new"}:${selected?.revision ?? 0}:${guidedStep ?? "full"}`} scope={scope} row={selected} enabled={enabled} dirty={dirty} guidedStep={guidedStep} onProgressChange={onProgressChange} beginSave={beginSave} saved={async (id, current) => {
      if (!current()) return;
      await load();
      if (!current()) return;
      dirty(false);
      // A guide save owns selection and advancement together. Its navigation
      // callback is reserved for an explicit user choice, not a save receipt.
      if (guidedStep && onSaved) setLocalSelectedId(id); else select(id);
      onSaved?.(id); onProgressChange?.();
    }} />;
  if (guidedStep) return <section className="ec-panel">
    <Notices error={action.error} />
    {guidedStep === "product" && selectedProductId === undefined && <div className="ec-panel-head"><Field label="使用已有商品，或新建一个"><select value={selectedId} onChange={event => pick(event.target.value)}><option value="">新建商品</option>{rows.map(row => <option key={row.id} value={row.id}>{row.name} · {priceLabel(row)} · {statuses[row.status as keyof typeof statuses] ?? row.status}</option>)}</select></Field>{selectedId && <button type="button" disabled={!enabled} onClick={() => pick("")}>新建商品</button>}</div>}
    {editor}
  </section>;
  return <div className="ec-split"><aside className="ec-panel ec-list"><div className="ec-panel-head"><h2>商品资料</h2><button type="button" disabled={!enabled} onClick={() => pick("")}>新建商品</button></div>
    <Notices error={action.error} />{!loaded ? <p role="status">正在加载商品…</p> : !rows.length ? <p className="ec-muted">补全商品信息并确认，即可参考带货视频写文案。</p> : rows.map(row => <button type="button" key={row.id} className={`ec-list-item ${row.id === selectedId ? "selected" : ""}`} onClick={() => pick(row.id)}><strong>{row.name}</strong><small>{priceLabel(row)} · v{row.current_version}</small><State value={row.status} /></button>)}
  </aside><section className="ec-panel">{selected && onCreateCopy && <div className="ec-actions ec-product-next"><button type="button" className="ec-primary" disabled={!enabled || selected.status !== "confirmed"} onClick={() => { if (discard()) { dirty(false); onCreateCopy(selected.version_id); } }}>用此商品写文案 →</button>{selected.status !== "confirmed" && <small className="ec-muted">确认商品信息后，即可选择参考带货视频。</small>}</div>}{editor}</section></div>;
}

function ProductEditor({ scope, row, enabled, dirty, saved, guidedStep, onProgressChange, beginSave }: { scope: Scope; row?: ProductRow; enabled: boolean; dirty: Props["dirty"]; saved: (id: string, current: () => boolean) => Promise<void>; guidedStep?: Props["guidedStep"]; onProgressChange?: Props["onProgressChange"]; beginSave: () => () => boolean }) {
  const [product, setProduct] = useState<Product>(() => ({ ...scope, ...(row ? { id: row.id } : {}), revision: row?.revision ?? 0, name: row?.name ?? "", sku: row?.sku ?? `AUTO-${crypto.randomUUID()}`, status: (row?.status ?? "draft") as Product["status"], publicData: row ? JSON.parse(row.public_json) : productPublicSchema.parse({ audience: {}, claims: [] }), internalData: row ? JSON.parse(row.internal_json) : productInternalSchema.parse({}) }));
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]), action = useEcommerceAction();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirtyParts = useRef({ product: false, evidence: false });
  const update = (next: Product) => { setProduct(next); dirtyParts.current.product = true; dirty(true); };
  const evidenceDirty = (value: boolean) => { dirtyParts.current.evidence = value; dirty(value || dirtyParts.current.product); };
  const p = product.publicData;
  const publicChange = (values: Partial<Product["publicData"]>) => update({ ...product, publicData: { ...p, ...values } });
  const loadEvidence = useCallback(async () => { if (!row) return; const result = await ecommerceApi<{ evidence: EvidenceRow[] }>(scope, `evidence?productId=${encodeURIComponent(row.id)}`); setEvidence(result.evidence); }, [scope, row]);
  const { setError } = action;
  useEffect(() => { if (!row || guidedStep !== "evidence") return; let active = true; ecommerceApi<{ evidence: EvidenceRow[] }>(scope, `evidence?productId=${encodeURIComponent(row.id)}`).then(result => { if (active) setEvidence(result.evidence); }).catch(error => { if (active && !isScopeCancellation(error)) setError(error instanceof Error ? error.message : "证据加载失败"); }); return () => { active = false; }; }, [scope, row, setError, guidedStep]);
  const evidencePanel = row && <EvidencePanel scope={scope} productId={row.id} enabled={enabled} rows={evidence} refresh={loadEvidence} dirty={evidenceDirty} onProgressChange={onProgressChange} guided={guidedStep === "evidence"} />;
  const basicFields = <>
    <div className="ec-grid"><TextField label="商品名称 *" required value={product.name} maxLength={300} onChange={name => update({ ...product, name })} /><MoneyField label={`价格（${p.currency === "CNY" ? "元" : p.currency}）`} value={p.priceCents} onChange={priceCents => publicChange({ priceCents })} /><ProductChoiceField label="商品品类" value={p.category} options={productQuestionOptions.category} maxLength={300} onChange={category => publicChange({ category })} /><TextField label="规格" value={p.specification} maxLength={1000} onChange={specification => publicChange({ specification })} /></div>
    <div className="ec-grid"><ProductChoiceField label="谁使用" value={p.audience.user} options={productQuestionOptions.user} maxLength={300} onChange={user => publicChange({ audience: { ...p.audience, user } })} /><ProductChoiceField label="谁决定购买" value={p.audience.buyer} options={productQuestionOptions.buyer} maxLength={300} onChange={buyer => publicChange({ audience: { ...p.audience, buyer } })} /></div>
    <div className="ec-grid"><ProductChoiceField label="商品使用场景" value={p.scenarios} options={productQuestionOptions.scene} multiline onChange={scenarios => publicChange({ scenarios })} /><ProductChoiceField label="可公开使用的购买顾虑" value={p.purchaseConcerns} options={productQuestionOptions.concern} multiline hint="选择常见情况，具体问题可自行填写。" onChange={purchaseConcerns => publicChange({ purchaseConcerns })} /></div>
  </>;
  return <><header className="ec-panel-head"><div><h2>{guidedStep === "product" ? "准备商品基本资料" : guidedStep === "evidence" ? "确认一个卖点和它的依据" : row ? row.name : "新建商品"}</h2><p className="ec-muted">{guidedStep === "product" ? "常见情况可以直接选择，具体商品信息请按实际填写。保存后继续准备卖点。" : guidedStep === "evidence" ? "先添加并核对证据，再为卖点关联证据，最后确认商品。" : "填写商品信息和价格，确认后选择参考带货视频写文案。"}</p></div>{row && <State value={row.status} />}</header>
    <Notices error={action.error} message={action.message} />
    {guidedStep === "evidence" && evidencePanel}
    <form onSubmit={e => { e.preventDefault(); if (dirtyParts.current.evidence) { action.setError("请先保存或清空证据草稿，再保存商品。"); return; } void action.act(async () => { const current = beginSave(); const savedProduct = { ...product, sku: product.sku || `AUTO-${crypto.randomUUID()}` }; const result = await ecommerceApi<{ product: { id: string } }>(scope, "products", guidedStep === "product" ? { ...savedProduct, status: "draft" } : savedProduct); if (mounted.current && current()) await saved(result.product.id, current); }); }}>
      <fieldset disabled={!enabled || action.busy} className="ec-form">
        {guidedStep === "evidence" ? <details><summary>查看或修改商品基本资料</summary>{basicFields}</details> : basicFields}
        <TextField label="商品卖点" multiline value={p.sellingPoints ?? ""} maxLength={3000} hint="每行写一个具体特点，按实际商品信息填写。" onChange={sellingPoints => publicChange({ sellingPoints })} />
        <TextField label="不能说的内容" multiline value={p.prohibited} maxLength={3000} hint="确认商品前必填；没有额外禁区可明确写“暂无额外禁区”。" onChange={prohibited => publicChange({ prohibited })} />
        <div className="ec-actions">{guidedStep !== "product" && <Choice label="保存为" value={product.status} values={statuses} onChange={status => update({ ...product, status })} />}<button type="submit" className="ec-primary" aria-busy={action.busy}>{guidedStep === "product" ? "保存商品草稿并继续" : "保存商品" + (row ? "新版本" : "草稿")}</button></div>{row?.confirmed_by && <p className="ec-muted">本版本确认人：{row.confirmed_by} · {displayTime(row.confirmed_at)}</p>}
      </fieldset>
    </form>
  </>;
}

function EvidencePanel({ scope, productId, enabled, rows, refresh, dirty, guided, onProgressChange }: { scope: Scope; productId: string; enabled: boolean; rows: EvidenceRow[]; refresh: () => Promise<void>; dirty: (value: boolean) => void; guided?: boolean; onProgressChange?: () => void }) {
  const [kind, setKind] = useState<Evidence["kind"]>("specification"), [reset, setReset] = useState(0), action = useEcommerceAction();
  const [now] = useState(Date.now);
  const refreshProgress = async () => { await refresh(); onProgressChange?.(); };
  return <section className="ec-section"><h3>商品证据</h3><p className="ec-muted">证据正文保存后不覆盖；更正资料时添加新证据并撤回旧证据。人工确认不等同于实验证明。</p><Notices error={action.error} message={action.message} />
    {rows.map(row => { const body = JSON.parse(row.body_json) as Evidence; return <details className="ec-inset" key={row.id}><summary>{row.title} <State value={row.status} expires={row.valid_until} /></summary><p className="ec-pre">{body.body}</p><p>资料定位：{body.sourceLocator}</p>{body.conditions && <p>适用条件：{body.conditions}</p>}<p className="ec-muted">{evidenceKinds[body.kind]} · 确认人 {row.confirmed_by ?? "未确认"} · {displayTime(row.confirmed_at)}</p><div className="ec-actions"><button type="button" disabled={!enabled || action.busy || row.status === "confirmed" || Boolean(row.valid_until && Date.parse(row.valid_until) <= now)} onClick={() => void action.act(async () => { await ecommerceApi(scope, "evidence", { id: row.id, revision: row.revision, status: "confirmed" }, "PATCH"); await refreshProgress(); }, "证据已确认。")}>确认此证据</button><button type="button" disabled={!enabled || action.busy || row.status === "revoked"} onClick={() => void action.act(async () => { await ecommerceApi(scope, "evidence", { id: row.id, revision: row.revision, status: "revoked" }, "PATCH"); await refreshProgress(); }, "证据已撤回，新生成将不再采用。")}>撤回</button></div></details>; })}
    <details open={Boolean(guided && !rows.length)}><summary>＋ 添加证据</summary><form key={reset} onChange={() => dirty(true)} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void action.act(async () => { await ecommerceApi(scope, "evidence", { productId, title: form.get("title"), kind, body: form.get("body"), sourceLocator: form.get("source"), conditions: form.get("conditions"), validUntil: form.get("validUntil") ? new Date(String(form.get("validUntil"))).toISOString() : null, status: "draft" }); await refreshProgress(); setReset(v => v + 1); dirty(false); }, "证据草稿已保存，请核对原始资料后确认。 "); }}><fieldset className="ec-form" disabled={!enabled || action.busy}><div className="ec-grid"><Field label="证据标题 *"><input name="title" required maxLength={300} /></Field><Choice label="证据类别" value={kind} values={evidenceKinds} onChange={setKind} /></div><Field label="原始证据正文 *"><textarea name="body" required rows={4} maxLength={8000} /></Field><Field label="来源与精确位置 *" hint="填写可核对的文档链接、文件名、页码或视频时间点。"><textarea name="source" required rows={2} maxLength={2000} /></Field><Field label="适用条件"><textarea name="conditions" rows={2} maxLength={2000} /></Field><Field label="有效至（可留空）"><input name="validUntil" type="datetime-local" /></Field><div className="ec-actions"><button type="submit" aria-busy={action.busy}>保存证据草稿</button><button type="button" onClick={() => { setReset(v => v + 1); dirty(false); }}>清空证据草稿</button></div></fieldset></form></details>
  </section>;
}
