import type { CoreContentStrategy } from "../lib/content-strategy-policy";

export function CoreStrategyPreview({ strategy }: { strategy: CoreContentStrategy | null }) {
  return <section className="core-strategy-preview" aria-label="核心内容策略">
    <strong>{strategy ? "核心内容策略 · 自动读取" : "当前未启用内容策略"}</strong>
    {strategy ? <details><summary>查看策略：{strategy.name}</summary><dl>
      <dt>账号定位</dt><dd>{strategy.positioning || "未填写"}</dd>
      <dt>目标受众</dt><dd>{strategy.targetAudience || "未填写"}</dd>
      <dt>表达风格与禁忌</dt><dd>{strategy.styleNotes || "未填写"}</dd>
      <dt>默认内容目标（仅在本次未指定时参考）</dt><dd>{strategy.defaultObjectives.join("；") || "未填写"}</dd>
    </dl></details> : <p>启用策略后，后续生成会自动读取核心方向。</p>}
    <p>定位、受众与基本风格保持一致；内容支柱不限定题材，结构与结尾按本题决定。策略不作为个人经历的依据。</p>
  </section>;
}
