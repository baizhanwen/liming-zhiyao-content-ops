"use client";

import { useEffect, useState, type FormEvent } from "react";
import { readApiError } from "../lib/client-format";
import { scopedFetch } from "../lib/client-scope";
import { isScopeCancellation } from "../lib/client-scope-request";
import styles from "./ModelSettingsPanel.module.css";

type TikHubSettings = {
  apiKeyConfigured: boolean;
  source: "organization" | "environment" | "none";
  version: number;
};

const sourceLabels = {
  organization: "当前公司的密钥",
  environment: "服务端默认密钥",
  none: "尚未配置密钥",
};

export function TikHubSettingsRow({ organizationId }: { organizationId: string }) {
  const [saved, setSaved] = useState<TikHubSettings | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await scopedFetch(`/api/tikhub-settings?organizationId=${encodeURIComponent(organizationId)}`, {
          cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error(await readApiError(response));
        const next: TikHubSettings = await response.json();
        if (!controller.signal.aborted) setSaved(next);
      } catch (reason) {
        if (!controller.signal.aborted && !isScopeCancellation(reason)) {
          setError(reason instanceof Error ? reason.message : "TikHub 配置读取失败。");
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [organizationId, refresh]);

  const dirty = Boolean(apiKey.trim()) || clearApiKey;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved || !dirty || saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const update = clearApiKey ? { clearApiKey: true } : { apiKey: apiKey.trim() };
      const response = await scopedFetch("/api/tikhub-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, version: saved.version, ...update }),
      });
      if (!response.ok) {
        if (response.status === 409) {
          setSaved(null);
          setClearApiKey(false);
          setRefresh(current => current + 1);
        }
        throw new Error(await readApiError(response));
      }
      const next: TikHubSettings = await response.json();
      setSaved(next);
      setApiKey("");
      setClearApiKey(false);
      setMessage(clearApiKey ? "已移除公司密钥。" : "密钥已保存，下次采集时生效。");
    } catch (reason) {
      if (!isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "TikHub 配置保存失败。");
    } finally {
      setSaving(false);
    }
  }

  const badge = dirty ? "有未保存修改" : saved ? (saved.apiKeyConfigured ? "已配置" : "待配置") : (error ? "读取失败" : "读取中");
  const badgeClass = dirty ? "model-role-pending" : saved?.apiKeyConfigured ? "model-role-ready" : "model-role-missing";
  return <details className={`${styles.role} operations-model-role`}>
    <summary>
      <span><strong>TikHub 抖音数据采集</strong><small>视频元数据、原封面和前十条一级评论</small></span>
      <span className={badgeClass}>{badge}</span>
    </summary>
    <div className="operations-model-role-body">
      {saved && <>
        <div className={styles.state}><strong>{sourceLabels[saved.source]}</strong></div>
        <form className={`stack-form ${styles.form}`} onSubmit={submit}>
          <label>API 密钥
            <input aria-label="TikHub API 密钥" type="password" autoComplete="new-password" spellCheck={false}
              disabled={saving || clearApiKey} maxLength={16000} value={apiKey}
              placeholder={saved.apiKeyConfigured ? "输入新密钥以更换" : "输入 TikHub API 密钥"}
              onChange={event => { setApiKey(event.target.value); setMessage(""); setError(""); }} />
          </label>
          {saved.source === "organization" && <label className={styles.clear}>
            <input type="checkbox" checked={clearApiKey} disabled={saving}
              onChange={event => { setClearApiKey(event.target.checked); setApiKey(""); setMessage(""); setError(""); }} />
            移除公司密钥，恢复服务端默认配置
          </label>}
          <div className={styles.actions}>
            <button type="submit" className="primary-button" disabled={!dirty || saving}>{saving ? "正在保存…" : "保存并使用"}</button>
          </div>
        </form>
      </>}
      {message && <p className={styles.message} role="status">{message}</p>}
      {error && <p className={`${styles.message} ${styles.error}`} role="alert">{error}</p>}
      {!saved && error && <button type="button" className="secondary-button" onClick={() => { setError(""); setRefresh(current => current + 1); }}>重新读取</button>}
    </div>
  </details>;
}
