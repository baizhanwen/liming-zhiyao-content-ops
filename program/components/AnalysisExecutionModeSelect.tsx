"use client";

import { useId } from "react";
import { analysisExecutionModeLabels, type AnalysisExecutionMode } from "../lib/analysis-execution-mode";

export function AnalysisExecutionModeSelect({ value, onChange, disabled = false, compact = false }: {
  value: AnalysisExecutionMode;
  onChange: (value: AnalysisExecutionMode) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const helpId = useId();
  return <div className={`analysis-visual-mode${compact ? " analysis-visual-mode-compact" : ""}`}>
    <label>{compact ? "处理" : "处理方式"}<select name="executionMode" aria-label="分析处理方式" value={value} disabled={disabled} onChange={event => onChange(event.target.value as AnalysisExecutionMode)} aria-describedby={helpId}>
      <option value="controlled_parallel">{analysisExecutionModeLabels.controlled_parallel}（默认）</option>
      <option value="serial">{analysisExecutionModeLabels.serial}</option>
    </select></label>
    <p id={helpId} className={compact ? "sr-only" : "analysis-input-hint"}>{value === "controlled_parallel"
      ? "在同一视频内重叠处理口播与画面，减少等待；瞬时资源占用较高，电脑卡顿时可切换串行。"
      : "先完成口播准备，再处理画面，降低瞬时资源占用；分析等待时间可能更长。"}</p>
  </div>;
}
