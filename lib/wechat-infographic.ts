import type { WechatImageRatioId, WechatImageStructure } from "./wechat-image-generation";

export type InfographicTemplate = {
  name: string;
  label: string;
  structure: WechatImageStructure;
  adaptive?: boolean;
  orientations: Array<"portrait" | "landscape" | "square">;
};

export const infographicTemplates: InfographicTemplate[] = [
  { name: "studio-operating-path", label: "经营决策路径", structure: "sequence", adaptive: true, orientations: ["portrait", "landscape", "square"] },
  { name: "reference-compare", label: "双栏对照", structure: "list", orientations: ["portrait", "landscape", "square"] },
  { name: "reference-system", label: "阶段系统", structure: "sequence", orientations: ["portrait", "landscape", "square"] },
  { name: "reference-matrix", label: "四色矩阵", structure: "quadrant", orientations: ["portrait", "landscape", "square"] },
  { name: "reference-orbit", label: "环形要素", structure: "relation", orientations: ["portrait", "landscape", "square"] },
  { name: "reference-pyramid", label: "分层金字塔", structure: "pyramid", orientations: ["portrait", "landscape", "square"] },
  { name: "reference-funnel", label: "营销漏斗", structure: "pyramid", orientations: ["portrait", "landscape", "square"] },
];

function orientation(ratio: WechatImageRatioId) {
  return ratio === "3:4" ? "portrait" : ratio === "1:1" ? "square" : "landscape";
}

export function templateCandidates(structure: WechatImageStructure, ratio: WechatImageRatioId) {
  const matching = infographicTemplates.filter((item) => (item.adaptive || item.structure === structure) && item.orientations.includes(orientation(ratio)));
  return matching.length ? matching : infographicTemplates.filter((item) => item.adaptive || item.structure === structure);
}

export function templateChoicesForRatio(ratio: WechatImageRatioId) {
  const direction = orientation(ratio);
  return infographicTemplates.filter((item) => item.orientations.includes(direction));
}

export function pickInfographicTemplate(structure: WechatImageStructure, ratio: WechatImageRatioId, current = "", random = Math.random) {
  const candidates = templateCandidates(structure, ratio);
  if (!current) return candidates.find((item) => item.adaptive) ?? candidates[0] ?? infographicTemplates[0];
  const alternatives = candidates.length > 1 ? candidates.filter((item) => item.name !== current) : candidates;
  return alternatives[Math.floor(random() * alternatives.length)] ?? infographicTemplates[0];
}

export function getInfographicTemplate(name: string) {
  return infographicTemplates.find((item) => item.name === name) ?? null;
}
