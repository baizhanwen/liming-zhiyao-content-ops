"use client";

import { useEffect } from "react";
import { Bot, Database, GitBranch, Target, TrendingUp, UsersRound } from "lucide-react";
import type { WechatImageContent, WechatImageRatioId } from "../lib/wechat-image-generation";

function layoutKind(templateName: string) {
  if (templateName === "studio-operating-path") return "studio";
  if (templateName === "reference-compare") return "compare";
  if (templateName === "reference-system") return "system";
  if (templateName === "reference-matrix") return "matrix";
  if (templateName === "reference-orbit") return "orbit";
  if (templateName === "reference-pyramid") return "pyramid";
  if (templateName === "reference-funnel") return "funnel";
  return "matrix";
}

const itemIcons = [Target, Database, GitBranch, Bot, TrendingUp, UsersRound];

function fit(value: string, maximum: number) {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length <= maximum ? chars.join("") : `${chars.slice(0, maximum - 1).join("")}…`;
}

function EditableText({ as: Tag, className, children }: { as: "h1" | "h3" | "p"; className?: string; children: string }) {
  return <Tag className={className} contentEditable suppressContentEditableWarning role="textbox" tabIndex={0}>{children}</Tag>;
}

function IconBadge({ index }: { index: number }) {
  const Icon = itemIcons[index % itemIcons.length];
  return <span className="wechat-poster-icon"><Icon aria-hidden="true" /></span>;
}

function CompareLayout({ content }: { content: WechatImageContent }) {
  return <section className="wechat-poster-items compare-board" aria-label="左右对照">
    <div className="compare-head"><strong>常见做法</strong><b>VS</b><strong>高手做法</strong></div>
    <div className="compare-rows">{content.sections.map((section, index) => <article className="wechat-poster-item compare-row" key={`${section.heading}-${index}`}>
      <div className="compare-side compare-side-old"><IconBadge index={index} /><span><EditableText as="h3">{fit(section.heading, 16)}</EditableText><EditableText as="p">{fit(section.body, 44)}</EditableText></span></div>
      <b className="compare-vs">VS</b>
      <div className="compare-side compare-side-new"><span className="wechat-poster-index">{String(index + 1).padStart(2, "0")}</span><span><EditableText as="h3">{fit(section.heading, 16)}</EditableText><EditableText as="p">{fit(section.contrast, 44)}</EditableText></span></div>
    </article>)}</div>
  </section>;
}

function SystemLayout({ content }: { content: WechatImageContent }) {
  const supplements = [
    { heading: "关键判断", body: content.quote, contrast: content.quote, details: [content.quote] },
    { heading: "落地执行", body: content.conclusion, contrast: content.conclusion, details: [content.conclusion] },
    { heading: "下一步", body: content.cta, contrast: content.cta, details: [content.cta] },
  ];
  const steps = [...content.sections, ...supplements].slice(0, 7);
  return <section className="wechat-poster-items system-board" aria-label="阶段系统">
    <div className="system-flow">{steps.map((section, index) => <article className="wechat-poster-item system-step" key={`${section.heading}-${index}`}>
      <span className="wechat-poster-index">{String(index + 1).padStart(2, "0")}</span><IconBadge index={index} />
      <EditableText as="h3">{fit(section.heading, 12)}</EditableText><EditableText as="p">{fit(section.body, 34)}</EditableText>
    </article>)}</div>
    <div className="system-actions">{content.sections.slice(0, 4).map((section, index) => <div key={`${section.heading}-action`}><span>{String(index + 1).padStart(2, "0")}</span><strong>{fit(section.contrast, 28)}</strong></div>)}</div>
  </section>;
}

function MatrixLayout({ content }: { content: WechatImageContent }) {
  return <section className="wechat-poster-items matrix-board" aria-label="四象限矩阵">
    {content.sections.slice(0, 4).map((section, index) => <article className="wechat-poster-item matrix-card" key={`${section.heading}-${index}`}>
      <header><span className="wechat-poster-index">{String(index + 1).padStart(2, "0")}</span><EditableText as="h3">{fit(section.heading, 16)}</EditableText><IconBadge index={index} /></header>
      <EditableText as="p" className="matrix-summary">{fit(section.body, 44)}</EditableText>
      <div className="matrix-perspectives"><div><strong>用户视角</strong><p>{fit(section.details[0] || section.body, 28)}</p></div><div><strong>经营视角</strong><p>{fit(section.details[1] || section.contrast, 28)}</p></div></div>
      <p className="matrix-goal"><span>核心目标</span>{fit(section.contrast, 34)}</p>
    </article>)}
  </section>;
}

function OrbitLayout({ content }: { content: WechatImageContent }) {
  return <section className="wechat-poster-items orbit-board" aria-label="中心要素与对照表">
    <div className="orbit-visual"><div className="wechat-poster-center"><UsersRound aria-hidden="true" /><strong>{fit(content.eyebrow, 10)}</strong></div>{content.sections.map((section, index) => <div className="orbit-node" key={`${section.heading}-node`}><span>{String(index + 1).padStart(2, "0")}</span><IconBadge index={index} /><strong>{fit(section.heading, 8)}</strong></div>)}</div>
    <div className="orbit-table"><header><strong>关键要素</strong><strong>内在动因</strong><strong>应用机会</strong></header>{content.sections.map((section, index) => <article className="wechat-poster-item" key={`${section.heading}-row`}><span>{String(index + 1).padStart(2, "0")}</span><strong>{fit(section.heading, 10)}</strong><p>{fit(section.body, 28)}</p><p>{fit(section.contrast, 28)}</p></article>)}</div>
  </section>;
}

function LayerLayout({ content, kind }: { content: WechatImageContent; kind: "pyramid" | "funnel" }) {
  return <section className={`wechat-poster-items layer-board layer-board-${kind}`} aria-label={kind === "pyramid" ? "金字塔层级" : "营销漏斗"}>
    <div className="layer-shapes">{content.sections.slice(0, 5).map((section, index) => <div className="layer-shape" key={`${section.heading}-shape`}><IconBadge index={index} /><strong>{fit(section.heading, 9)}</strong></div>)}</div>
    <div className="layer-list">{content.sections.slice(0, 5).map((section, index) => <article className="wechat-poster-item" key={`${section.heading}-detail`}><span className="wechat-poster-index">{String(index + 1).padStart(2, "0")}</span><div><EditableText as="h3">{fit(section.heading, 16)}</EditableText><EditableText as="p">{fit(section.body, 42)}</EditableText><small>{fit(section.contrast, 34)}</small></div></article>)}</div>
  </section>;
}

function StudioLayout({ content }: { content: WechatImageContent }) {
  const supplements = [{ heading: "落地执行", body: content.conclusion, contrast: content.quote, details: [content.cta] }];
  const sections = [...content.sections, ...supplements].slice(0, 5);
  return <section className="wechat-poster-items studio-board" aria-label="经营决策路径">
    <aside className="studio-path-note"><strong>经营决策路径</strong><p>从认知到验收，<br />一步步把 AI 用<br />到业务里。</p></aside>
    <div className="studio-stage-list">{sections.map((section, index) => <article className="wechat-poster-item studio-stage" key={`${section.heading}-studio`}>
      <div className="studio-shape"><IconBadge index={index} /></div>
      <span className="studio-node">{String(index + 1).padStart(2, "0")}</span>
      <div className="studio-copy"><EditableText as="h3">{fit(section.heading, 16)}</EditableText><strong>{fit(section.contrast, 34)}</strong><EditableText as="p">{fit(section.body, 48)}</EditableText></div>
    </article>)}</div>
  </section>;
}

function PosterBody({ content, kind }: { content: WechatImageContent; kind: string }) {
  if (kind === "studio") return <StudioLayout content={content} />;
  if (kind === "compare") return <CompareLayout content={content} />;
  if (kind === "system") return <SystemLayout content={content} />;
  if (kind === "matrix") return <MatrixLayout content={content} />;
  if (kind === "orbit") return <OrbitLayout content={content} />;
  if (kind === "pyramid" || kind === "funnel") return <LayerLayout content={content} kind={kind} />;
  return null;
}

export function WechatPosterCanvas({ content, templateName, ratio, onReady }: { content: WechatImageContent; templateName: string; ratio: WechatImageRatioId; onReady(): void }) {
  const kind = layoutKind(templateName);
  const portrait = ratio === "3:4";

  useEffect(() => { onReady(); }, [content, kind, onReady, ratio]);

  return <main className={`wechat-native-poster layout-${kind} ratio-${ratio.replace(":", "-")}`}>
    <section className="wechat-poster-hero">
      <span className="wechat-poster-signal">{String(content.sections.length).padStart(2, "0")} KEY IDEAS</span>
      <EditableText as="h1">{fit(content.title, portrait ? 34 : 42)}</EditableText>
      <EditableText as="p" className="wechat-poster-subtitle">{fit(content.subtitle, portrait ? 58 : 72)}</EditableText>
    </section>
    <PosterBody content={content} kind={kind} />
    <aside className="wechat-poster-quote"><span>核心判断</span><EditableText as="p">{fit(content.quote, portrait ? 48 : 56)}</EditableText></aside>
  </main>;
}
