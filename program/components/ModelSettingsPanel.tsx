"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { scopedFetch } from "../lib/client-scope";
import { isScopeCancellation } from "../lib/client-scope-request";
import { readApiError } from "../lib/client-format";
import {
  modelConfigurationDraft,
  modelConfigurationUpdate,
} from "../lib/model-settings-client";
import type {
  ConfigurableModelRole,
  ModelConfigurationDraft,
  PublicModelConfiguration,
} from "../lib/model-settings-client";
import styles from "./ModelSettingsPanel.module.css";

const roleDetails: Array<{ id: ConfigurableModelRole; label: string; description: string }> = [
  { id: "analysisText", label: "视频分析文本模型", description: "根据转写和画面证据生成结构化视频分析。" },
  { id: "visualUnderstanding", label: "视频画面理解", description: "用于关键帧图片理解，请选择支持图片输入的模型。" },
  { id: "contentGeneration", label: "内容生成模型", description: "用于选题、文案和内容生产，可为这条链路设置独立模型。" },
  { id: "projectAssistant", label: "项目记忆与灵感模型", description: "用于项目记忆整理和灵感对话，独立保存本角色配置。" },
];

type Snapshot = {
  roles: Record<ConfigurableModelRole, PublicModelConfiguration>;
  canManage: boolean;
  version?: number;
};
type Feedback = { text: string; error: boolean };

function emptyConfiguration(): PublicModelConfiguration {
  return { provider: "", baseUrl: "", model: "", apiKeyConfigured: false, updatedAt: null };
}

function ModelRoleEditor({ role, saved, disabled, busy, onSave, onTest }: {
  role: typeof roleDetails[number];
  saved: PublicModelConfiguration;
  disabled: boolean;
  busy: "save" | "test" | null;
  onSave: (role: ConfigurableModelRole, draft: ModelConfigurationDraft) => Promise<Feedback | null>;
  onTest: (role: ConfigurableModelRole) => Promise<Feedback | null>;
}) {
  const [draft, setDraft] = useState(() => modelConfigurationDraft(saved));
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const lastSaved = useRef(saved);
  // A keyed editor is remounted after a successful save, preserving any other
  // role's unsaved edits while clearing the submitted secret from React state.
  const dirty = draft.provider !== saved.provider || draft.baseUrl !== saved.baseUrl || draft.model !== saved.model || Boolean(draft.apiKey || draft.clearApiKey);
  function change(field: keyof ModelConfigurationDraft, value: string | boolean) {
    setDraft(current => ({ ...current, [field]: value }));
    setFeedback(null);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    try {
      modelConfigurationUpdate(draft, lastSaved.current);
      const result = await onSave(role.id, draft);
      if (result) setFeedback(result);
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : "配置没有保存。", error: true });
    }
  }
  async function testSaved() {
    setFeedback(null);
    const result = await onTest(role.id);
    if (result) setFeedback(result);
  }
  return <section className={styles.role} aria-labelledby={`model-role-${role.id}`}>
    <h3 id={`model-role-${role.id}`}>{role.label}</h3>
    <p className={styles.description}>{role.description}</p>
    <div className={styles.state}><strong>{saved.apiKeyConfigured ? "密钥已保存" : "尚未设置密钥"}</strong>{saved.source && <span>{saved.source === "organization" ? "当前公司配置" : "本项目默认配置"}</span>}{saved.updatedAt && <span>更新于 {new Date(saved.updatedAt).toLocaleString("zh-CN")}</span>}</div>
    <form className={`stack-form ${styles.form}`} onSubmit={submit}>
      <fieldset className={styles.fieldset} disabled={disabled}>
        <div className="stack-form">
          <label>提供方<input aria-label={`${role.label}提供方`} value={draft.provider} onChange={event => change("provider", event.target.value)} list="model-provider-options" placeholder="例如 glm、deepseek、openai-compatible" maxLength={100} autoComplete="off" /></label>
          <label>接口地址<input aria-label={`${role.label}接口地址`} type="url" value={draft.baseUrl} onChange={event => change("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" maxLength={1000} autoComplete="off" /></label>
          <label>模型名称<input aria-label={`${role.label}模型名称`} value={draft.model} onChange={event => change("model", event.target.value)} placeholder={role.id === "visualUnderstanding" ? "支持图片的模型，或 understand_image" : "填写服务商提供的模型名称"} maxLength={200} autoComplete="off" /></label>
          <label>API 密钥<input aria-label={`${role.label} API 密钥`} type="password" value={draft.apiKey} onChange={event => change("apiKey", event.target.value)} disabled={draft.clearApiKey} placeholder={saved.apiKeyConfigured ? "已保存；留空保持原密钥" : "输入该模型的 API 密钥"} maxLength={4000} autoComplete="new-password" spellCheck={false} /></label>
          <p className={styles.keyNote}>密钥不会回显。只改模型名称时可留空；更换提供方或接口地址时请填写对应密钥。</p>
          {saved.apiKeyConfigured && <label className={styles.clear}><input type="checkbox" checked={draft.clearApiKey} onChange={event => { change("clearApiKey", event.target.checked); if (event.target.checked) change("apiKey", ""); }} />清除本角色密钥并停用该角色</label>}
        </div>
      </fieldset>
      <div className={styles.actions}>
        <button className="primary-button" type="submit" disabled={disabled || !dirty}>{busy === "save" ? "正在保存…" : "保存并使用"}</button>
        <button className="secondary-button" type="button" disabled={disabled || !saved.apiKeyConfigured || dirty} onClick={() => void testSaved()}>{busy === "test" ? "正在测试…" : "测试已保存配置"}</button>
      </div>
      <p className={styles.keyNote}>{dirty ? "有未保存的修改，请先保存。" : "连接测试使用已保存配置。"}测试可能产生少量模型用量。</p>
      {feedback && <p className={`${styles.message}${feedback.error ? ` ${styles.error}` : ""}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
    </form>
  </section>;
}

export function ModelSettingsPanel({ organizationId, canManage, onSaved }: {
  organizationId: string;
  canManage: boolean;
  onSaved?: () => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<{ role: ConfigurableModelRole; action: "save" | "test" } | null>(null);
  const [savedEpochs, setSavedEpochs] = useState<Partial<Record<ConfigurableModelRole, number>>>({});
  const mounted = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = true;
    void (async () => {
      try {
        const response = await scopedFetch(`/api/model-settings?organizationId=${encodeURIComponent(organizationId)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(await readApiError(response));
        const body = await response.json() as Snapshot;
        if (!controller.signal.aborted) setSnapshot(body);
      } catch (reason) {
        if (!isScopeCancellation(reason) && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "模型配置加载失败。");
      }
    })();
    return () => { mounted.current = false; controller.abort(); };
  }, [organizationId]);

  async function save(role: ConfigurableModelRole, draft: ModelConfigurationDraft): Promise<Feedback | null> {
    if (!snapshot || busy) return null;
    const saved = snapshot.roles[role] ?? emptyConfiguration();
    const update = modelConfigurationUpdate(draft, saved);
    setBusy({ role, action: "save" }); setError(""); setNotice("");
    try {
      const response = await scopedFetch("/api/model-settings", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, roles: { [role]: update }, ...(snapshot.version === undefined ? {} : { version: snapshot.version }) }),
      });
      if (!response.ok) return { text: await readApiError(response), error: true };
      const body = await response.json() as Snapshot;
      if (!mounted.current) return null;
      setSnapshot(current => current ? { ...current, version: body.version, canManage: body.canManage, roles: { ...current.roles, [role]: body.roles[role] } } : body);
      setSavedEpochs(current => ({ ...current, [role]: (current[role] ?? 0) + 1 }));
      setNotice(`${roleDetails.find(item => item.id === role)?.label ?? "模型"}已保存，后续新任务使用此配置；正在执行的任务继续使用原配置。`);
      if (onSaved) {
        try { await onSaved(); } catch { setNotice("配置已保存；状态刷新暂未完成，请稍后刷新状态。"); }
      }
      return null;
    } catch (reason) {
      return isScopeCancellation(reason) ? null : { text: reason instanceof Error ? reason.message : "模型配置没有保存。", error: true };
    } finally { if (mounted.current) setBusy(null); }
  }

  async function test(role: ConfigurableModelRole): Promise<Feedback | null> {
    if (busy) return null;
    setBusy({ role, action: "test" }); setError(""); setNotice("");
    try {
      const response = await scopedFetch("/api/model-settings/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, role }) });
      if (!response.ok) return { text: await readApiError(response), error: true };
      const body = await response.json() as { result?: { status?: string; message?: string }; probe?: { status?: string; message?: string }; status?: string; message?: string };
      const result = body.result ?? body.probe ?? body;
      return { text: result.message || (result.status === "passed" ? "连接测试通过。" : "连接测试没有通过，请检查当前配置。"), error: result.status !== "passed" };
    } catch (reason) {
      return isScopeCancellation(reason) ? null : { text: reason instanceof Error ? reason.message : "连接测试没有完成。", error: true };
    } finally { if (mounted.current) setBusy(null); }
  }

  const editable = canManage && snapshot?.canManage !== false;
  return <article id="model-settings" className="panel operations-panel">
    <div className="panel-heading"><div><p className="section-kicker">当前公司的模型设置</p><h2>配置后直接使用</h2></div><span>{editable ? "管理员可修改" : "仅管理员可修改"}</span></div>
    <p className={styles.intro}>分别设置视频分析、画面理解、内容生成和项目助理。配置保存在本项目中；密钥不回显，留空保留已保存密钥。</p>
    <datalist id="model-provider-options">{["glm", "deepseek", "openai-compatible", "openai", "minimax", "minimax-token-plan", "qwen", "dashscope"].map(provider => <option key={provider} value={provider} />)}</datalist>
    {error && <p className={`${styles.message} ${styles.error}`} role="alert">{error}</p>}
    {notice && <p className={styles.message} role="status">{notice}</p>}
    {!snapshot && !error && <p className={styles.loading}>正在读取模型配置…</p>}
    {snapshot && <div className={styles.roles}>{roleDetails.map(role => <ModelRoleEditor key={`${organizationId}:${role.id}:${savedEpochs[role.id] ?? 0}`} role={role} saved={snapshot.roles[role.id] ?? emptyConfiguration()} disabled={!editable || Boolean(busy)} busy={busy?.role === role.id ? busy.action : null} onSave={save} onTest={test} />)}</div>}
  </article>;
}
