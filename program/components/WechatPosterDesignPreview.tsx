"use client";

import { WechatPosterCanvas } from "./WechatPosterCanvas";
import type { WechatImageContent } from "../lib/wechat-image-generation";

const previewContent: WechatImageContent = {
  structure: "sequence",
  eyebrow: "老板 AI 决策课",
  title: "中小企业老板必须懂的 5 个 AI 概念",
  subtitle: "别背术语，用经营视角判断 AI 从哪里开始、怎么验收",
  quote: "企业 AI 先讲落地，再讲工具。",
  sections: [
    { heading: "智能体", contrast: "有岗位说明书的数字员工", body: "能执行任务，但需要明确边界、交付物和审核人。", details: ["明确边界", "定义交付", "保留审核"] },
    { heading: "知识库", contrast: "企业可以调用的记忆", body: "先整理资料，再谈智能调用。", details: ["资料整理", "权限清晰", "持续维护"] },
    { heading: "工作流", contrast: "把一次成功固定成流程", body: "提示词只是其中一环，流程才是可复制的能力。", details: ["步骤固化", "责任明确", "结果复用"] },
    { heading: "数字员工", contrast: "有岗位、有交付、有审核", body: "不是万能机器人，也不能绕过责任人。", details: ["岗位说明", "交付标准", "人工负责"] },
    { heading: "验收标准", contrast: "先定指标，再谈效果", body: "没有验收标准，AI 项目只是演示。", details: ["业务指标", "检查动作", "持续迭代"] },
  ],
  conclusion: "从业务出发，小步快跑，明确验收，持续迭代。",
  cta: "收藏这张图，用五个问题检查你的 AI 项目",
  footer: "利明智耀新媒体",
};

export function WechatPosterDesignPreview() {
  return <main className="design-preview-page">
    <div className="wechat-infographic-frame professional-blue ratio-3-4 design-preview-frame">
      <header><input aria-label="栏目名称" value={previewContent.eyebrow} readOnly /><span>经营决策路径 · 3:4</span></header>
      <WechatPosterCanvas content={previewContent} templateName="studio-operating-path" ratio="3:4" onReady={() => undefined} />
      <footer><textarea aria-label="总结" value={previewContent.conclusion} readOnly /><div><input aria-label="行动引导" value={previewContent.cta} readOnly /><input aria-label="品牌落款" value={previewContent.footer} readOnly /></div></footer>
    </div>
  </main>;
}
