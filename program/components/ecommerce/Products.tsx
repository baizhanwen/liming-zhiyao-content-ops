"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { claimSchema, productInternalSchema, productPublicSchema } from "../../lib/ecommerce/contracts";
import { isScopeCancellation } from "../../lib/client-scope-request";
import { productQuestionOptions } from "../../lib/ecommerce/product-question-options";
import { ProductChoiceField } from "./ProductChoiceField";
import { Checks, Choice, displayTime, ecommerceApi, evidenceKinds, Field, MoneyField, Notices, State, statuses, TextField, TimeField, useEcommerceAction, type Evidence, type EvidenceRow, type Product, type ProductRow, type Scope } from "./shared";

type Props = {
  scope: Scope; enabled: boolean; dirty: (value: boolean) => void; discard: () => boolean;
  guidedStep?: "product" | "evidence";
  selectedProductId?: string;
  onSelectProduct?: (id: string) => void;
  onSaved?: (id: string) => void;
  onProgressChange?: () => void;
};
export function Products({ scope, enabled, dirty, discard, guidedStep, selectedProductId, onSelectProduct, onSaved, onProgressChange }: Props) {
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
    {guidedStep === "product" && selectedProductId === undefined && <div className="ec-panel-head"><Field label="使用已有商品，或新建一个"><select value={selectedId} onChange={event => pick(event.target.value)}><option value="">新建商品</option>{rows.map(row => <option key={row.id} value={row.id}>{row.name} · {row.sku} · {statuses[row.status as keyof typeof statuses] ?? row.status}</option>)}</select></Field>{selectedId && <button type="button" disabled={!enabled} onClick={() => pick("")}>新建商品</button>}</div>}
    {editor}
  </section>;
  return <div className="ec-split"><aside className="ec-panel ec-list"><div className="ec-panel-head"><h2>商品资料</h2><button type="button" disabled={!enabled} onClick={() => pick("")}>新建商品</button></div>
    <Notices error={action.error} />{!loaded ? <p role="status">正在加载商品…</p> : !rows.length ? <p className="ec-muted">先保存一个商品，再补充卖点和依据。</p> : rows.map(row => <button type="button" key={row.id} className={`ec-list-item ${row.id === selectedId ? "selected" : ""}`} onClick={() => pick(row.id)}><strong>{row.name}</strong><small>{row.sku} · v{row.current_version}</small><State value={row.status} /></button>)}
  </aside><section className="ec-panel">{editor}</section></div>;
}

function ProductEditor({ scope, row, enabled, dirty, saved, guidedStep, onProgressChange, beginSave }: { scope: Scope; row?: ProductRow; enabled: boolean; dirty: Props["dirty"]; saved: (id: string, current: () => boolean) => Promise<void>; guidedStep?: Props["guidedStep"]; onProgressChange?: Props["onProgressChange"]; beginSave: () => () => boolean }) {
  const [product, setProduct] = useState<Product>(() => ({ ...scope, ...(row ? { id: row.id } : {}), revision: row?.revision ?? 0, name: row?.name ?? "", sku: row?.sku ?? "", status: (row?.status ?? "draft") as Product["status"], publicData: row ? JSON.parse(row.public_json) : productPublicSchema.parse({ audience: {}, claims: [] }), internalData: row ? JSON.parse(row.internal_json) : productInternalSchema.parse({}) }));
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]), action = useEcommerceAction();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirtyParts = useRef({ product: false, evidence: false });
  const update = (next: Product) => { setProduct(next); dirtyParts.current.product = true; dirty(true); };
  const evidenceDirty = (value: boolean) => { dirtyParts.current.evidence = value; dirty(value || dirtyParts.current.product); };
  const p = product.publicData, internal = product.internalData;
  const publicChange = (values: Partial<Product["publicData"]>) => update({ ...product, publicData: { ...p, ...values } });
  const loadEvidence = useCallback(async () => { if (!row) return; const result = await ecommerceApi<{ evidence: EvidenceRow[] }>(scope, `evidence?productId=${encodeURIComponent(row.id)}`); setEvidence(result.evidence); }, [scope, row]);
  const { setError } = action;
  useEffect(() => { if (!row) return; let active = true; ecommerceApi<{ evidence: EvidenceRow[] }>(scope, `evidence?productId=${encodeURIComponent(row.id)}`).then(result => { if (active) setEvidence(result.evidence); }).catch(error => { if (active && !isScopeCancellation(error)) setError(error instanceof Error ? error.message : "证据加载失败"); }); return () => { active = false; }; }, [scope, row, setError]);
  const evidencePanel = row && <EvidencePanel scope={scope} productId={row.id} enabled={enabled} rows={evidence} refresh={loadEvidence} dirty={evidenceDirty} onProgressChange={onProgressChange} guided={guidedStep === "evidence"} />;
  const basicFields = <>
    <div className="ec-grid"><TextField label="商品名称 *" required value={product.name} maxLength={300} onChange={name => update({ ...product, name })} /><TextField label="SKU *" required value={product.sku} maxLength={100} hint="填写你们识别这款商品的编号。" onChange={sku => update({ ...product, sku })} /><ProductChoiceField label="商品品类" value={p.category} options={productQuestionOptions.category} maxLength={300} onChange={category => publicChange({ category })} /><TextField label="规格" value={p.specification} maxLength={1000} onChange={specification => publicChange({ specification })} /></div>
    <div className="ec-grid"><ProductChoiceField label="谁使用" value={p.audience.user} options={productQuestionOptions.user} maxLength={300} onChange={user => publicChange({ audience: { ...p.audience, user } })} /><ProductChoiceField label="谁决定购买" value={p.audience.buyer} options={productQuestionOptions.buyer} maxLength={300} onChange={buyer => publicChange({ audience: { ...p.audience, buyer } })} /></div>
    <div className="ec-grid"><ProductChoiceField label="商品使用场景" value={p.scenarios} options={productQuestionOptions.scene} multiline onChange={scenarios => publicChange({ scenarios })} /><ProductChoiceField label="可公开使用的购买顾虑" value={p.purchaseConcerns} options={productQuestionOptions.concern} multiline hint="选择常见情况，具体问题可自行填写。" onChange={purchaseConcerns => publicChange({ purchaseConcerns })} /></div>
    <details><summary>更详细的人群与购买判断</summary><div className="ec-grid">
      {([ ["situation", "用户当前处境"], ["trigger", "为什么此时需要"], ["alternative", "以前怎么解决"], ["barrier", "为什么还没有购买"], ["concerns", "价格、品质或效果的顾虑"], ["viewingContext", "在哪种情境下看到内容"], ["source", "人群信息来源"] ] as const).map(([key, label]) => <TextField key={key} label={label} value={p.audience[key]} maxLength={key === "viewingContext" ? 500 : 1000} onChange={value => publicChange({ audience: { ...p.audience, [key]: value } })} />)}
      <Choice label="人群信息状态" value={p.audience.status} values={{ hypothesis: "待验证假设", confirmed: "已人工确认" }} onChange={status => publicChange({ audience: { ...p.audience, status } })} />
    </div></details>
  </>;
  return <><header className="ec-panel-head"><div><h2>{guidedStep === "product" ? "准备商品基本资料" : guidedStep === "evidence" ? "确认一个卖点和它的依据" : row ? row.name : "新建商品"}</h2><p className="ec-muted">{guidedStep === "product" ? "常见情况可以直接选择，具体商品信息请按实际填写。保存后继续准备卖点。" : guidedStep === "evidence" ? "先添加并核对证据，再为卖点关联证据，最后确认商品。" : "先填常用资料；详细人群、价格和内部资料按需展开。"}</p></div>{row && <State value={row.status} />}</header>
    <Notices error={action.error} message={action.message} />
    {guidedStep === "evidence" && evidencePanel}
    <form onSubmit={e => { e.preventDefault(); if (dirtyParts.current.evidence) { action.setError("请先保存或清空证据草稿，再保存商品。"); return; } void action.act(async () => { const current = beginSave(); const result = await ecommerceApi<{ product: { id: string } }>(scope, "products", guidedStep === "product" ? { ...product, status: "draft" } : product); if (mounted.current && current()) await saved(result.product.id, current); }); }}>
      <fieldset disabled={!enabled || action.busy} className="ec-form">
        {guidedStep === "evidence" ? <details><summary>查看或修改商品基本资料</summary>{basicFields}</details> : basicFields}
        {guidedStep !== "product" && <details open={guidedStep === "evidence"}><summary>主卖点及事实依据</summary><p className="ec-muted">先添加并确认一条证据，再填写它能支持的卖点。独特卖点和表达范围继续自由填写。</p>

          {p.claims.map((claim, index) => { const change = (values: Partial<typeof claim>) => publicChange({ claims: p.claims.map((c, i) => i === index ? { ...c, ...values } : c) }); return <section className="ec-inset" key={claim.id}><div className="ec-panel-head"><h3>卖点 {index + 1}</h3><button type="button" className="ec-quiet" onClick={() => publicChange({ claims: p.claims.filter(c => c.id !== claim.id) })}>移除此卖点</button></div><TextField label="卖点表述 *" required value={claim.statement} maxLength={1000} onChange={statement => change({ statement })} /><TextField label="允许使用的表达范围 *" required multiline value={claim.allowedExpression} maxLength={1000} onChange={allowedExpression => change({ allowedExpression })} /><div className="ec-grid"><Choice label="卖点类别" value={claim.kind} values={{ specification: "规格事实", demonstration: "可观察演示", experience: "使用体验", offer: "价格与权益" }} onChange={kind => change({ kind })} /><Choice label="卖点确认状态" value={claim.status} values={statuses} onChange={status => change({ status })} /><TextField label="适用条件" value={claim.conditions} maxLength={1000} onChange={conditions => change({ conditions })} /><TimeField label="卖点有效至（可留空）" value={claim.validUntil} onChange={validUntil => change({ validUntil })} /></div><Checks label="关联本商品证据" value={claim.evidenceIds} values={Object.fromEntries(evidence.map(e => [e.id, `${e.title}（${statuses[e.status as keyof typeof statuses]}）`]))} onChange={evidenceIds => change({ evidenceIds })} /></section>; })}
          <button type="button" disabled={p.claims.length >= 30} onClick={() => publicChange({ claims: [...p.claims, { ...claimSchema.parse({ id: crypto.randomUUID(), statement: "待补充卖点", allowedExpression: "待补充允许范围", kind: "specification", evidenceIds: [] }), statement: "", allowedExpression: "" }] })}>＋ 添加卖点</button>
        </details>}
        <TextField label="不能说的内容" multiline value={p.prohibited} maxLength={3000} hint="确认商品前必填；没有额外禁区可明确写“暂无额外禁区”。" onChange={prohibited => publicChange({ prohibited })} />
        <details><summary>价格、活动与承接链接</summary><div className="ec-grid"><MoneyField label="当前售价（元）" value={p.priceCents} onChange={priceCents => publicChange({ priceCents })} /><TextField label="币种" value={p.currency} maxLength={3} onChange={currency => publicChange({ currency: currency.toUpperCase() })} /><TextField label="活动与适用条件" value={p.offer} maxLength={1000} onChange={offer => publicChange({ offer })} /><TimeField label="价格或活动有效至" value={p.offerValidUntil} onChange={offerValidUntil => publicChange({ offerValidUntil })} /></div><TextField label="商品卡或直播间链接" value={p.landingUrl} onChange={landingUrl => publicChange({ landingUrl })} /></details>
        <details className="ec-private"><summary>内部经营资料</summary><p className="ec-muted">仅在企业空间保存，生成接口不向创作模型传入这些字段。</p><div className="ec-grid"><MoneyField label="成本（元）" value={internal.costCents} onChange={costCents => update({ ...product, internalData: { ...internal, costCents } })} /><Field label="人工记录库存"><input type="number" min="0" step="1" value={internal.stock ?? ""} onChange={e => update({ ...product, internalData: { ...internal, stock: e.target.value === "" ? null : Number(e.target.value) } })} /></Field><TimeField label="库存观察时间" value={internal.stockObservedAt} onChange={stockObservedAt => update({ ...product, internalData: { ...internal, stockObservedAt } })} /><TextField label="毛利说明" value={internal.marginNotes} maxLength={1000} onChange={marginNotes => update({ ...product, internalData: { ...internal, marginNotes } })} /></div><TextField label="原始退款原因" multiline value={internal.refundReasons} maxLength={3000} onChange={refundReasons => update({ ...product, internalData: { ...internal, refundReasons } })} /><TextField label="原始差评原因" multiline value={internal.negativeReviews} maxLength={3000} onChange={negativeReviews => update({ ...product, internalData: { ...internal, negativeReviews } })} /></details>
        <div className="ec-actions">{guidedStep !== "product" && <Choice label="保存为" value={product.status} values={statuses} onChange={status => update({ ...product, status })} />}<button type="submit" className="ec-primary" aria-busy={action.busy}>{guidedStep === "product" ? "保存商品草稿并继续" : "保存商品" + (row ? "新版本" : "草稿")}</button></div>{row?.confirmed_by && <p className="ec-muted">本版本确认人：{row.confirmed_by} · {displayTime(row.confirmed_at)}</p>}
      </fieldset>
    </form>
    {guidedStep !== "product" && guidedStep !== "evidence" && evidencePanel}
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
