"use client";

import type { TopicBackground, TopicReferenceRecommendation, TopicSourcePreview } from "../lib/topic-reference-policy";
import type { ReactNode } from "react";
import { CoreStrategyPreview } from "./CoreStrategyPreview";
import "./creation-cleanup.css";

const sourceNames: Record<string, string> = { topic: "当前表单", knowledge: "已选品牌知识", strategy: "核心内容策略", video_analysis: "关联视频分析", method_knowledge: "选题方法规则" };

export function TopicReferenceControls({ background, videoAvailable, includeVideo, onVideoChange, selected, recommendations, recommending, busy, onRecommend, onAdd, sources, onClearGenerated, children }: {
  background: TopicBackground | null;
  videoAvailable: boolean;
  includeVideo: boolean;
  onVideoChange: (value: boolean) => void;
  selected: { id: string; title: string }[];
  recommendations: { query: string; items: TopicReferenceRecommendation[] } | null;
  recommending: boolean;
  busy: boolean;
  onRecommend: () => void;
  onAdd: (id: string) => void;
  sources: TopicSourcePreview[] | null;
  onClearGenerated: () => void;
  children: ReactNode;
}) {
  return <section className="topic-reference-controls creation-reference" aria-label="AI 参考范围">
    <details className="creation-reference-options">
      <summary><strong>生成参考</strong><span>已选知识 {selected.length} 条 · 策略{background ? "已启用" : "未启用"}{videoAvailable && includeVideo ? " · 已选关联视频" : ""}</span></summary>
      <div className="creation-reference-body">
        {children}
        <CoreStrategyPreview strategy={background} />
        <p className="creation-hint">当前表单和选题方法默认参与；项目记忆和历史视频片段不会自动加入。</p>
        {videoAvailable && <label className="topic-reference-toggle"><input type="checkbox" checked={includeVideo} disabled={busy} onChange={event => onVideoChange(event.target.checked)} /><span>使用已关联的视频分析</span></label>}
        <div className="topic-reference-recommend"><button type="button" disabled={busy || recommending} onClick={onRecommend}>{recommending ? "正在查找…" : "按标题推荐参考"}</button><small>仅查找资料，点击加入后才用于生成</small></div>
        {recommendations && <div className="topic-reference-recommendations"><p>针对「{recommendations.query}」的推荐</p>{recommendations.items.length ? recommendations.items.map(item => <article key={item.id}><strong>{item.title}</strong><small>命中：{item.matchedTerms.join("、")}</small><button type="button" disabled={busy || selected.some(entry => entry.id === item.id) || selected.length >= 20} onClick={() => onAdd(item.id)}>{selected.some(entry => entry.id === item.id) ? "已加入" : "加入参考"}</button></article>) : <p>没有找到匹配的参考，可以仅围绕标题策划。</p>}</div>}
      </div>
    </details>
    {sources && <details className="topic-actual-sources"><summary>上次生成实际使用的来源（{sources.length} 项）</summary><p>以下为上次发送的参考内容快照；修改勾选不会改变已有生成文字。</p>{sources.map(source => <details key={`${source.sourceType}:${source.sourceId}`}><summary>{sourceNames[source.sourceType] || source.sourceType} · {source.title}（{source.characterCount} 字符）</summary><pre>{source.text}</pre></details>)}<button type="button" disabled={busy} onClick={onClearGenerated}>清空未手动修改的补全内容</button></details>}
  </section>;
}
