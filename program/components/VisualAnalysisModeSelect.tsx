"use client";

import { useId } from "react";
import type { VisualAnalysisMode } from "../lib/visual-analysis-mode";

export const visualAnalysisModeLabels: Record<VisualAnalysisMode, string> = {
  hybrid: "混合模式（OCR＋视觉）",
  vision_only: "纯视觉模式",
};

export function VisualAnalysisModeSelect({ value, onChange, disabled = false, compact = false }: {
  value: VisualAnalysisMode;
  onChange: (value: VisualAnalysisMode) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const helpId = useId();
  return <div className={`analysis-visual-mode${compact ? " analysis-visual-mode-compact" : ""}`}>
    <label>{compact ? "画面" : "画面分析方式"}<select name="visualAnalysisMode" aria-label="画面分析方式" value={value} disabled={disabled} onChange={event => onChange(event.target.value as VisualAnalysisMode)} aria-describedby={helpId}>
      <option value="hybrid">{compact ? "OCR＋视觉" : visualAnalysisModeLabels.hybrid}</option>
      <option value="vision_only">{compact ? "纯视觉" : visualAnalysisModeLabels.vision_only}</option>
    </select></label>
    <p id={helpId} className={compact ? "sr-only" : "analysis-input-hint"}>{value === "vision_only"
      ? "由视觉模型识别画面和文字，不运行本地 OCR；口播转写照常。需要可用的视觉模型。"
      : "本地 OCR 提取画面文字，视觉模型理解画面；口播转写照常。"}</p>
  </div>;
}
