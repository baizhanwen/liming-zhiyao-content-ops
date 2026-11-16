"use client";

import { useId } from "react";
import { ANALYSIS_COLLECTION_MODE_LABELS, type AnalysisCollectionMode } from "../lib/analysis-collection-mode";

export function AnalysisCollectionModeSelect({ value, onChange, disabled = false, compact = false }: {
  value: AnalysisCollectionMode;
  onChange: (value: AnalysisCollectionMode) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const helpId = useId();
  return <div className={`analysis-collection-mode analysis-visual-mode${compact ? " analysis-visual-mode-compact" : ""}`}>
    <label>采集方式<select aria-label="视频采集方式" value={value} onChange={event => onChange(event.target.value as AnalysisCollectionMode)} disabled={disabled} aria-describedby={helpId}>
      {Object.entries(ANALYSIS_COLLECTION_MODE_LABELS).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
    </select></label>
    <p id={helpId} className={compact ? "sr-only" : "analysis-input-hint"}>{value === "cookie"
      ? "使用当前公司上传的抖音 Cookie 采集；登录失效时需要重新上传。"
      : "使用独立匿名浏览器采集，不读取个人 Cookie，也不会自动切换采集方式。"}</p>
  </div>;
}
