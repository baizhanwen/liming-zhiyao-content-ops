"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isScopeCancellation } from "../../lib/client-scope-request";
import { deriveFirstVideoReadiness, type FirstVideoGuideData, type FirstVideoGuideStep } from "../../lib/ecommerce/first-video-guide";
import { Products } from "./Products";
import { Tasks } from "./Tasks";
import { ecommerceApi, Field, kinds, Notices, useEcommerceAction, type MethodCard, type Scope } from "./shared";

type GuideSelection = { productId: string | null; step: FirstVideoGuideStep; taskId: string };
type Starter = { key: string; card: MethodCard };
const stepDescriptions = {
  product: "选好要介绍的商品，保存基本资料。",
  evidence: "选择一个卖点，核对并关联真实依据。",
  create: "选择视频条件，生成口播和拍摄清单。",
};

export function FirstVideoGuide({ scope, enabled, settingsRevision, canManage, enabling, onEnable, dirty, discard, openMethods, openTasks }: {
  scope: Scope; enabled: boolean; settingsRevision: number; canManage: boolean; enabling: boolean;
  onEnable: () => Promise<void>; dirty: (value: boolean) => void; discard: () => boolean;
  openMethods: () => void; openTasks: () => void;
}) {
  const [selection, setSelectionState] = useState<string | null>(null), [step, setStepState] = useState<FirstVideoGuideStep>("product");
  const [taskId, setTaskIdState] = useState(""), [hydrated, setHydrated] = useState(false);
  const [editorProductVersionId, setEditorVersionState] = useState<string | null>(null);
  const [editorIdentity, setEditorIdentity] = useState(0), identityRef = useRef(0);
  const bumpIdentity = useCallback(() => { identityRef.current += 1; setEditorIdentity(identityRef.current); }, []);
  const selectionRef = useRef<string | null>(null), stepRef = useRef<FirstVideoGuideStep>("product"), taskRef = useRef(""), editorVersionRef = useRef<string | null>(null);
  const setSelection = useCallback((value: string | null) => { if (selectionRef.current !== value) bumpIdentity(); selectionRef.current = value; setSelectionState(value); }, [bumpIdentity]);
  const setStep = useCallback((value: FirstVideoGuideStep) => { if (stepRef.current !== value) bumpIdentity(); stepRef.current = value; setStepState(value); }, [bumpIdentity]);
  const setTaskId = useCallback((value: string) => { if (taskRef.current !== value) bumpIdentity(); taskRef.current = value; setTaskIdState(value); }, [bumpIdentity]);
  const setEditorProductVersionId = useCallback((value: string | null) => { if (editorVersionRef.current !== value) bumpIdentity(); editorVersionRef.current = value; setEditorVersionState(value); }, [bumpIdentity]);
  const [data, setData] = useState<FirstVideoGuideData | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const readNumber = useRef(0), mounted = useRef(true), useSuggestedStep = useRef(true);
  const storageKey = `ec.first-video.${scope.organizationId}.${scope.projectId}`;

  useEffect(() => {
    mounted.current = true;
    let active = true;
    // Read browser-only navigation memory after hydration. It stores identities,
    // never the user's unsaved answers or a fabricated readiness result.
    queueMicrotask(() => {
      if (!active) return;
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null") as Partial<GuideSelection> | null;
        if (saved && (typeof saved.productId === "string" || saved.productId === null)) {
          setSelection(saved.productId); setTaskId(typeof saved.taskId === "string" ? saved.taskId : "");
          if (["product", "evidence", "create"].includes(saved.step || "")) { setStep(saved.step!); useSuggestedStep.current = false; }
        }
      } catch { /* The server remains the source of readiness when storage is unavailable. */ }
      setHydrated(true);
    });
    return () => { active = false; mounted.current = false; readNumber.current += 1; };
  }, [storageKey, setSelection, setStep, setTaskId]);

  useEffect(() => {
    if (!hydrated) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ productId: selection, step, taskId })); } catch { /* Optional navigation memory. */ }
  }, [hydrated, selection, step, taskId, storageKey]);

  const refresh = useCallback(async () => {
    // A completed request from an editor that is no longer selected must not
    // start a new read for its old product or replace the current draft.
    if (!mounted.current || selection !== selectionRef.current) return;
    const number = ++readNumber.current;
    setLoading(true);
    try {
      const suffix = selection === null ? "" : `?productId=${encodeURIComponent(selection)}`;
      const result = await ecommerceApi<FirstVideoGuideData>(scope, `first-video-guide${suffix}`);
      if (!mounted.current || number !== readNumber.current || selection !== selectionRef.current) return;
      setData(result); setError("");
      if (selection === null) setSelection(result.selectedProductId ?? "");
      if (useSuggestedStep.current) { setStep(deriveFirstVideoReadiness(result).suggestedStep); useSuggestedStep.current = false; }
      if (stepRef.current === "create" && result.selectedProduct?.ready && editorVersionRef.current === null) setEditorProductVersionId(result.selectedProduct.versionId);
    } catch (reason) {
      if (mounted.current && number === readNumber.current && selection === selectionRef.current && !isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "准备状态读取失败，请重试。");
    } finally {
      if (mounted.current && number === readNumber.current && selection === selectionRef.current) setLoading(false);
    }
  }, [scope, selection, setSelection, setStep, setEditorProductVersionId]);

  useEffect(() => { let active = true; if (hydrated) queueMicrotask(() => { if (active) void refresh(); }); return () => { active = false; }; }, [hydrated, refresh, settingsRevision]);
  const current = data && (selection === null || data.selectedProductId === (selection || null)) ? data : null;
  const readiness = deriveFirstVideoReadiness(error || !current ? null : current);
  const selected = current?.selectedProduct ?? null;
  const changeStep = (next: FirstVideoGuideStep) => { if (next !== step && discard()) { dirty(false); setStep(next); setEditorProductVersionId(next === "create" && selected?.ready ? selected.versionId : null); } };
  const selectProduct = (id: string) => { if (id !== selection && discard()) { dirty(false); setTaskId(""); setEditorProductVersionId(null); setSelection(id); } };
  const editorDirty = useCallback((value: boolean) => { if (mounted.current && editorIdentity === identityRef.current) dirty(value); }, [dirty, editorIdentity]);
  const productSaved = (id: string) => {
    if (editorIdentity !== identityRef.current || !mounted.current || selection !== selectionRef.current || step !== stepRef.current) return;
    if (id !== selection) { setSelection(id); setTaskId(""); setEditorProductVersionId(null); } else void refresh();
    if (step === "product") setStep("evidence");
  };
  const taskSaved = (id: string) => {
    if (editorIdentity === identityRef.current && mounted.current && selection === selectionRef.current && stepRef.current === "create" && editorVersionRef.current === editorProductVersionId && taskRef.current === taskId) setTaskId(id);
  };
  const tasks = current?.tasks.filter(task => task.productId === selected?.id && task.productVersionId === (editorProductVersionId ?? selected?.versionId) && task.status !== "archived") ?? [];

  return <section className="ec-guide" aria-label="制作第一条商品视频">
    <header className="ec-panel ec-guide-intro"><div><p className="ec-guide-kicker">商品视频 · 三步开始</p><h2>{readiness.completed ? "第一份可拍稿已经准备好" : "制作第一条商品视频"}</h2><p className="ec-muted">常见条件直接选择，商品事实和特殊要求按实际填写。</p></div>{enabled && <button type="button" className="ec-quiet" disabled={loading} onClick={() => void refresh()}>{loading ? "正在核对…" : "核对准备状态"}</button>}</header>
    <ol className="ec-guide-steps" aria-label="制作步骤">{readiness.steps.map((item, index) => <li key={item.id} data-state={item.status}><button type="button" aria-current={step === item.id ? "step" : undefined} onClick={() => changeStep(item.id)}><span className="ec-guide-number" aria-hidden="true">{item.status === "complete" ? "✓" : index + 1}</span><span><strong>{item.label}</strong><small>{item.status === "complete" ? "已准备" : item.status === "unknown" ? "待核对" : stepDescriptions[item.id]}</small></span></button></li>)}</ol>

    {!enabled ? <article className="ec-panel ec-guide-welcome"><h3>先启用当前空间，再准备商品</h3><p>启用后，按上面三步制作口播与拍摄清单。已有商品、视频方法、案例和发布记录仍可从顶部入口查看。</p>{canManage ? <div className="ec-actions"><button type="button" className="ec-primary" disabled={enabling} aria-busy={enabling} onClick={() => void onEnable()}>启用并开始制作</button><small className="ec-muted">沿用当前空间的并发和用量上限；启用不会调用模型。</small></div> : <p className="ec-muted">请联系公司管理员启用当前空间。</p>}</article> : <>
      {error && <div className="ec-panel"><Notices error={error} /><p className="ec-muted">准备状态暂未确认。已有资料保留，读取状态不会生成内容或重复保存。</p><div className="ec-actions"><button type="button" onClick={() => void refresh()}>重新读取</button><button type="button" onClick={() => { if (discard()) { dirty(false); setTaskId(""); setEditorProductVersionId(null); setStep("product"); useSuggestedStep.current = true; if (selection === null) void refresh(); else setSelection(null); } }}>重新选择商品</button></div></div>}
      {!current ? !error && <div className="ec-panel" role="status">正在读取当前空间的商品与制作进度…</div> : <>
        {!!current.products.length && <div className="ec-guide-product"><Field label="这次介绍哪个商品？"><select value={selection ?? ""} onChange={event => selectProduct(event.target.value)}><option value="">＋ 准备一个新商品</option>{current.products.map(product => <option key={product.id} value={product.id}>{product.name} · {product.sku}{product.ready ? " · 资料已确认" : " · 资料待补齐"}</option>)}</select></Field></div>}
        {step === "product" && <><Products scope={scope} enabled={enabled} dirty={editorDirty} discard={discard} guidedStep="product" selectedProductId={selection ?? ""} onSelectProduct={selectProduct} onSaved={productSaved} onProgressChange={() => void refresh()} /><footer className="ec-guide-footer"><p>先保存基本资料。已有商品可以直接继续核对卖点。</p><button type="button" className="ec-primary" disabled={!readiness.productSaved} onClick={() => changeStep("evidence")}>下一步：确认卖点与依据</button></footer></>}
        {step === "evidence" && (selected ? <><section className="ec-panel ec-guide-instruction"><h3>只确认本次要讲的真实卖点</h3><p className="ec-muted">先保存并核对证据，再关联到卖点，最后确认商品。特殊条件和限制仍请按实际填写。</p>{!!selected.problems.length && <ul className="ec-guide-missing">{selected.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}</section><Products scope={scope} enabled={enabled} dirty={editorDirty} discard={discard} guidedStep="evidence" selectedProductId={selected.id} onSelectProduct={selectProduct} onSaved={productSaved} onProgressChange={() => void refresh()} /><footer className="ec-guide-footer"><button type="button" onClick={() => changeStep("product")}>上一步</button><button type="button" className="ec-primary" disabled={!readiness.productReady} onClick={() => changeStep("create")}>下一步：设置视频并生成</button></footer></> : <MissingProduct onBack={() => changeStep("product")} />)}
        {step === "create" && (selected && (selected.ready || editorProductVersionId) ? <>
          <Preparation scope={scope} data={current} discard={discard} refresh={refresh} openMethods={openMethods} />
          {editorProductVersionId && editorProductVersionId !== selected.versionId && <div className="ec-panel"><p>商品资料已有新版本，当前填写内容仍保留。使用新版本前请先保存当前任务，或确认放弃未保存修改。</p><div className="ec-actions"><button type="button" onClick={() => { if (discard()) { dirty(false); setTaskId(""); setEditorProductVersionId(selected.versionId); } }}>使用最新商品版本</button></div></div>}
          {readiness.draftReady && <div className="ec-guide-outcome" role="status"><strong>{readiness.filmingReady ? "已有可拍摄稿件" : "稿件已生成，还有事项需要核对"}</strong><span>{readiness.filmingReady ? "可以查看口播、镜头和拍摄清单；审核、发布与复盘继续在原任务中完成。" : "在任务中处理“待人工确认”，保存并重新核对后再拍摄。"}</span></div>}
          {(!!tasks.length || Boolean(taskId)) && <div className="ec-guide-product"><Field label="新做一条，还是继续已有视频？"><select value={taskId} onChange={event => { if (discard()) { dirty(false); setTaskId(event.target.value); } }}><option value="">＋ 制作新视频</option>{taskId && !tasks.some(task => task.id === taskId) && <option value={taskId}>当前任务 · 状态待核对</option>}{tasks.map(task => <option key={task.id} value={task.id}>{task.title}{task.hasDraft ? " · 已有稿件" : " · 条件草稿"}</option>)}</select></Field><button type="button" className="ec-quiet" onClick={openTasks}>管理全部视频任务</button></div>}
          {editorProductVersionId && <Tasks key={`${editorProductVersionId}:${taskId || "new"}`} scope={scope} enabled={enabled && Boolean(current.settings.enabled) && !error} canManage={canManage} dirty={editorDirty} discard={discard} guided initialProductVersionId={editorProductVersionId} initialTaskId={taskId || undefined} onTaskSaved={taskSaved} onProgressChange={() => void refresh()} />}
        </> : <div className="ec-panel"><h3>先把商品与卖点准备好</h3><p className="ec-muted">{selected ? "确认一条有有效证据支持的卖点后，再设置视频条件。" : "请先选择或保存一个商品。"}</p><div className="ec-actions"><button type="button" className="ec-primary" onClick={() => changeStep(selected ? "evidence" : "product")}>返回补齐资料</button></div></div>)}
      </>}
    </>}
  </section>;
}

function MissingProduct({ onBack }: { onBack: () => void }) {
  return <div className="ec-panel"><h3>先选择要介绍的商品</h3><p className="ec-muted">保存商品基本资料后，再添加它的卖点与证据。</p><div className="ec-actions"><button type="button" className="ec-primary" onClick={onBack}>准备商品</button></div></div>;
}

function Preparation({ scope, data, discard, refresh, openMethods }: { scope: Scope; data: FirstVideoGuideData; discard: () => boolean; refresh: () => Promise<void>; openMethods: () => void }) {
  const [cards, setCards] = useState<Starter[]>([]), [keys, setKeys] = useState<string[]>([]), action = useEcommerceAction();
  const strategyUrl = `/knowledge?${new URLSearchParams({ ...scope, tab: "strategy", from: "ecommerce" })}`;
  return <section className="ec-panel ec-guide-preparation" aria-label="生成前的空间准备"><header className="ec-panel-head"><div><h3>生成前，再核对两项准备</h3><p className="ec-muted">视频条件会在任务中继续核对；这里先检查空间的内容策略和视频方法。</p></div><button type="button" className="ec-quiet" disabled={action.busy} onClick={() => void refresh()}>已补齐，重新核对</button></header>
    <div className="ec-guide-checks"><div><span className={`ec-guide-check ${data.strategy.ready ? "ready" : ""}`} aria-hidden="true">{data.strategy.ready ? "✓" : "·"}</span><div><strong>内容策略{data.strategy.ready ? "已准备" : "待补齐"}</strong><p className="ec-muted">{data.strategy.ready ? `${data.strategy.positioning} · ${data.strategy.targetAudience}` : "先确定空间的账号定位和目标人群，之后可以重复使用。"}</p>{!data.strategy.ready && <a className="ec-link" href={strategyUrl} onClick={event => { if (!discard()) event.preventDefault(); }}>去设置内容策略 →</a>}</div></div><div><span className={`ec-guide-check ${data.methods.ready ? "ready" : ""}`} aria-hidden="true">{data.methods.ready ? "✓" : "·"}</span><div><strong>视频方法{data.methods.ready ? "已准备" : "待补齐"}</strong><p className="ec-muted">{data.methods.ready ? "已有开头、画面、结构和拍摄方法；生成时按实际条件筛选。" : "需要开头、画面、结构和拍摄四类方法，可以先选用基础方法。"}</p>{!data.methods.ready && <div className="ec-actions">{data.canManage && <button type="button" disabled={action.busy} onClick={() => void action.act(async () => { const result = await ecommerceApi<{ cards: Starter[] }>(scope, "components/starter"); setCards(result.cards); setKeys(result.cards.map(card => card.key)); if (!result.cards.length) action.setError("当前版本未提供基础方法，可以在视频方法库整理自己的方法。"); })}>预览基础方法</button>}<button type="button" className="ec-quiet" onClick={openMethods}>打开视频方法库</button></div>}</div></div></div>
    <Notices error={action.error} message={action.message} />
    {!!cards.length && <div className="ec-guide-starter"><h3>选择要导入当前空间的方法</h3><p className="ec-muted">方法帮助安排结构和拍摄，商品事实仍使用你确认的证据。重复导入保留已有修改。</p><div className="ec-guide-starter-grid">{cards.map(item => <label key={item.key}><input type="checkbox" checked={keys.includes(item.key)} onChange={event => setKeys(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))} /><span>{item.card.name}<small>{kinds[item.card.kind]} · {item.card.problem}</small></span></label>)}</div><div className="ec-actions"><button type="button" className="ec-primary" disabled={action.busy || !keys.length} onClick={() => void action.act(async () => { await ecommerceApi(scope, "components/starter", { keys, confirm: true }); setCards([]); await refresh(); }, "所选方法已导入当前空间。")}>确认导入所选方法（{keys.length}）</button><button type="button" className="ec-quiet" onClick={() => setCards([])}>暂不导入</button></div></div>}
  </section>;
}
