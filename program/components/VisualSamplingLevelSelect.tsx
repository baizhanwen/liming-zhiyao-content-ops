"use client";

import { useId } from "react";
import { visualSamplingLevelLabels, type VisualSamplingLevel } from "../lib/visual-sampling-level";

export function VisualSamplingLevelSelect({ value, onChange, disabled = false, compact = false }: {
  value: VisualSamplingLevel;
  onChange: (value: VisualSamplingLevel) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const helpId = useId();
  const description = value === "quick"
    ? "省时减少采样密度，视觉模型每批最多 4 图，总抽帧预算不变；仍执行完整画面分析模块并保留关键取证。"
    : value === "detailed"
      ? "精细增加采样密度，适合换屏频繁、画面细节较多的视频。"
      : "均衡兼顾采样覆盖与处理开销，视觉模型每批最多 2 图，总抽帧预算不变；保留完整画面分析模块和关键取证。";
  return <div className={`analysis-visual-sampling${compact ? " analysis-visual-mode-compact" : ""}`}>
    <label>{compact ? "采样" : "画面档位"}<select name="visualSamplingLevel" aria-label="画面档位" value={value} disabled={disabled} onChange={event => onChange(event.target.value as VisualSamplingLevel)} aria-describedby={helpId}>
      {Object.entries(visualSamplingLevelLabels).map(([level, label]) => <option value={level} key={level}>{label}</option>)}
    </select></label>
    <p id={helpId} className={compact ? "sr-only" : "analysis-input-hint"}>{description}</p>
  </div>;
}
